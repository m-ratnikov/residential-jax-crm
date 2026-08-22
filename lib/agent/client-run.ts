"use client";

/**
 * The agent turn, run in the tab.
 *
 * The tools have to reach the parcel data, and the parcel data is read by
 * DuckDB-WASM in this tab, so the loop runs here. The key it answers on does
 * not: the model call goes through /api/llm/<provider>, which attaches this
 * deployment's key server-side. Tools stay where the data is, the key stays
 * where a key belongs, and the visitor is asked for nothing.
 *
 * Routing through our own origin also removes a caveat that used to need
 * explaining: a browser cannot call every provider directly - some refuse
 * browser origins outright and Anthropic needs an explicit opt-in header - but
 * from the provider's side the caller here is a server.
 *
 * The prompt, the tool definitions, the provider registry, the evidence trace
 * and the response contract are all the shared ones. Only the place the loop
 * executes moved.
 */

import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
} from "ai";

import { classifyProviderError } from "@/lib/oracle/agent/errors";
import { safeMessage } from "@/lib/oracle/agent/redact";
import type { AgentChatMessage, AgentResponse, AgentUsage } from "@/lib/oracle/agent/types";
import { propertySource, fetchOverlay } from "@/lib/data/client-source";
import { createProxiedModel } from "./proxy-model";
import type { AgentProvider } from "@/lib/agent/providers";
import { SYSTEM_PROMPT } from "./prompt";
import { createAgentTools, newTrace, TOOL_ORDER } from "./tools";

export const MAX_STEPS = 12;
export const MAX_HISTORY_MESSAGES = 12;

/**
 * The model this turn runs on, once it has been built.
 *
 * Declared here rather than imported from the vendored agent because this
 * deployment resolves exactly one way: a provider and model it publishes, built
 * against the proxy that holds the key. The vendored resolver existed to weigh
 * that against a credential the visitor supplied, and the bring-your-own-key
 * page it served was removed; keeping its resolver around would have kept ~550
 * lines of provider-construction and header-reading code that nothing calls.
 *
 * `source` survives the narrowing because the error classifier words a 401
 * differently depending on whose credential failed, and the answer here is
 * always "this deployment's".
 */
interface ResolvedModel {
  provider: AgentProvider;
  modelId: string;
  model: LanguageModel;
  /** Whose credential built this client. Drives error wording, not behaviour. */
  source: "user" | "server";
  /** Wrap the system prompt with the provider's cache marker, if it has one. */
  instructions: (system: string) => SystemModelMessage;
}

export function toModelMessages(messages: AgentChatMessage[]): ModelMessage[] {
  const trimmed = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.content.trim(),
    )
    .slice(-MAX_HISTORY_MESSAGES);
  // The conversation has to end on the user's turn; drop a dangling assistant
  // message.
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role !== "user") trimmed.pop();
  return trimmed.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : { role: "assistant", content: message.content },
  );
}

function toUsage(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  },
  steps: number,
): AgentUsage {
  return {
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
    cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    steps,
  };
}

export interface RunClientAgentOptions {
  messages: AgentChatMessage[];
  /**
   * A provider and model this deployment offers on its own key. The loop still
   * runs here; only the model call goes through `/api/llm/<provider>`.
   */
  serverModel?: { provider: AgentProvider; modelId: string } | null;
  /** Injected by tests. */
  model?: ResolvedModel;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

/**
 * Which model answers.
 *
 * One path: a model this deployment publishes, called through the proxy that
 * holds the key. There is no per-visitor credential to weigh against it, which
 * is the point - a CRM that asks the person evaluating it to go and mint an API
 * key before it will answer a question has failed at the question.
 */
async function pickModel(options: RunClientAgentOptions): Promise<ResolvedModel> {
  if (options.model) return options.model;

  const chosen = options.serverModel;
  if (!chosen) {
    throw new Error(
      "This deployment has no model configured, so the agent cannot answer. Everything else in the application works without one.",
    );
  }

  return {
    provider: chosen.provider,
    modelId: chosen.modelId,
    model: await createProxiedModel(chosen.provider, chosen.modelId),
    source: "server",
    // Plain system prompt. The Anthropic cache marker is a server-side saving
    // that this path cannot claim, since the proxy re-sends the prefix anyway.
    instructions: (system: string) => ({ role: "system", content: system }),
  };
}

export async function runClientAgent(options: RunClientAgentOptions): Promise<AgentResponse> {
  const started = Date.now();
  const modelMessages = toModelMessages(options.messages);
  if (modelMessages.length === 0) {
    throw new Error("messages must contain at least one user message");
  }

  const source = propertySource();
  const [resolved, overlay] = await Promise.all([pickModel(options), fetchOverlay()]);

  const trace = newTrace();
  const tools = createAgentTools(
    { source, overlay: overlay.overlay, courtDataAvailable: overlay.courtDataAvailable },
    trace,
  );

  const agent = new ToolLoopAgent({
    id: "duval-acquisition-crm",
    model: resolved.model,
    instructions: resolved.instructions(SYSTEM_PROMPT),
    tools,
    // Stable tool order keeps the cached prefix identical across turns.
    toolOrder: [...TOOL_ORDER],
    stopWhen: stepCountIs(options.maxSteps ?? MAX_STEPS),
    maxOutputTokens: 4096,
    temperature: 0.2,
  });

  // Several providers quote the offending credential in the body of a 401, so
  // redact first and classify second even here, where the key is the visitor's
  // own: it must not end up in a rendered error string either.
  // Nothing secret passes through this process any more: the key lives on the
  // server and the proxy attaches it. The redaction pass stays because a
  // provider can still quote a credential back in the body of a 401, and it
  // must not reach a rendered error string.
  const secrets: string[] = [];
  let result;
  try {
    result = await agent.generate({ messages: modelMessages, abortSignal: options.abortSignal });
  } catch (error: unknown) {
    throw classifyProviderError(error, safeMessage(error, secrets), resolved.source);
  }

  let answer = result.text.trim();
  if (!answer) {
    answer =
      result.finishReason === "tool-calls"
        ? "I ran out of tool steps before writing an answer. The transcript and evidence panels show everything retrieved so far; ask a narrower question, or ask me to continue."
        : "The model returned no text. The transcript shows the tool calls that were made.";
  }

  // The badge is always populated: if no tool happened to read the pipeline
  // status, read it here rather than leaving the answer undated.
  let freshness = trace.freshness;
  if (!freshness) {
    try {
      const [runs, info] = await Promise.all([source.listRuns(1), source.info()]);
      freshness = {
        run_id: runs[0]?.runId ?? info.runId,
        finished_at: runs[0]?.finishedAt ?? info.generatedAt,
        is_sample: info.isSample,
      };
    } catch {
      freshness = null;
    }
  }

  const usage = toUsage(result.totalUsage, result.steps.length);

  return {
    status: "ok",
    message: answer,
    answer,
    toolCalls: trace.calls,
    tool_calls: trace.calls,
    evidence: trace.evidence,
    assumptions: trace.assumptions,
    data_freshness: freshness,
    model: `${resolved.provider}:${resolved.modelId}`,
    usage,
    elapsed_ms: Date.now() - started,
  };
}
