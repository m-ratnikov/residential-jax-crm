"use client";

/**
 * The agent turn, run in the tab.
 *
 * The tools have to reach the parcel data, and the parcel data is read by
 * DuckDB-WASM in this tab, so the loop runs here. The visitor's key is already
 * held here too - it is stored in this browser and has never been on the server
 * - so nothing about the credential changes.
 *
 * The prompt, the tool definitions, the provider registry, the evidence trace
 * and the response contract are all the shared ones. Only the place the loop
 * executes moved.
 *
 * The one honest caveat, surfaced on the settings page rather than discovered
 * as a failure: not every provider allows a browser to call it. Google AI Studio
 * does. Anthropic requires an explicit opt-in header, which this sends when the
 * visitor selects it, and some providers block browser origins outright.
 */

import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";

import { resolveModel, type ResolvedModel } from "@/lib/oracle/agent/model";
import type { UserCredential } from "@/lib/oracle/agent/credentials";
import { classifyProviderError } from "@/lib/oracle/agent/errors";
import { safeMessage } from "@/lib/oracle/agent/redact";
import type { AgentChatMessage, AgentResponse, AgentUsage } from "@/lib/oracle/agent/types";
import { propertySource, fetchOverlay } from "@/lib/data/client-source";
import { SYSTEM_PROMPT } from "./prompt";
import { createAgentTools, newTrace, TOOL_ORDER } from "./tools";

export const MAX_STEPS = 12;
export const MAX_HISTORY_MESSAGES = 12;

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
  credential: UserCredential;
  /** Injected by tests. */
  model?: ResolvedModel;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

export async function runClientAgent(options: RunClientAgentOptions): Promise<AgentResponse> {
  const started = Date.now();
  const modelMessages = toModelMessages(options.messages);
  if (modelMessages.length === 0) {
    throw new Error("messages must contain at least one user message");
  }

  const source = propertySource();
  const [resolved, overlay] = await Promise.all([
    options.model ? Promise.resolve(options.model) : resolveModel({}, options.credential),
    fetchOverlay(),
  ]);

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
  const secrets = [options.credential.apiKey];
  let result;
  try {
    result = await agent.generate({ messages: modelMessages, abortSignal: options.abortSignal });
  } catch (error: unknown) {
    throw classifyProviderError(error, safeMessage(error, secrets), "user");
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
