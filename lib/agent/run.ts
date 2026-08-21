/**
 * One agent turn: a ToolLoopAgent over the tools, with the transcript and
 * evidence lifted out of the trace into the response contract the chat page
 * renders.
 *
 * Adapted from the pipeline repository's loop - same Vercel AI SDK shape, same
 * redaction discipline, same injectable model so the loop can be tested with
 * `ai/test` mocks - with this application's tools and prompt.
 */

import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";

import { getPropertyDataSource } from "@/lib/data/source";
import type { PropertyDataSource } from "@/lib/data/types";
import { classifyProviderError } from "@/lib/oracle/agent/errors";
import { logAgent } from "@/lib/oracle/agent/log";
import { resolveModel, type ResolvedModel } from "@/lib/oracle/agent/model";
import type { UserCredential } from "@/lib/oracle/agent/credentials";
import { keyFingerprint, safeMessage } from "@/lib/oracle/agent/redact";
import type { AgentChatMessage, AgentResponse, AgentUsage, Env } from "@/lib/oracle/agent/types";
import { SYSTEM_PROMPT } from "./prompt";
import { createAgentTools, createToolContext, newTrace, TOOL_ORDER } from "./tools";

export const MAX_STEPS = 12;
export const MAX_HISTORY_MESSAGES = 12;

export interface RunAgentOptions {
  messages: AgentChatMessage[];
  /** Injected for tests; resolved from the environment otherwise. */
  model?: ResolvedModel;
  /** Injected for tests; the configured source otherwise. */
  source?: PropertyDataSource;
  /**
   * The visitor's own credential for this one request. Beats the server
   * environment when present, and is dropped when the turn ends: nothing here
   * writes it anywhere, and every error path that could quote it is redacted.
   */
  credential?: UserCredential | null;
  env?: Env;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

export function toModelMessages(messages: AgentChatMessage[]): ModelMessage[] {
  const trimmed = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.content.trim(),
    )
    .slice(-MAX_HISTORY_MESSAGES);
  // The conversation has to end on the user's turn; drop a dangling assistant message.
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

export async function runAgent(options: RunAgentOptions): Promise<AgentResponse> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const modelMessages = toModelMessages(options.messages);
  if (modelMessages.length === 0) {
    throw new Error("messages must contain at least one user message");
  }

  const source = options.source ?? getPropertyDataSource().source;
  const [resolved, toolContext] = await Promise.all([
    options.model ? Promise.resolve(options.model) : resolveModel(env, options.credential),
    createToolContext(source),
  ]);

  const trace = newTrace();
  const tools = createAgentTools(toolContext, trace);

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

  // The provider call is the one place a caller's key can come back at us:
  // several providers quote the offending credential in the body of a 401.
  // Redact first, classify second, never let the raw error escape.
  const secrets = [options.credential?.apiKey];
  let result;
  try {
    result = await agent.generate({ messages: modelMessages, abortSignal: options.abortSignal });
  } catch (error: unknown) {
    const safe = safeMessage(error, secrets);
    const typed = classifyProviderError(error, safe, resolved.source);
    logAgent("warn", "provider call failed", {
      provider: resolved.provider,
      model: resolved.modelId,
      credential_source: resolved.source,
      error_name: typed.name,
      error: safe,
    });
    throw typed;
  }

  let answer = result.text.trim();
  if (!answer) {
    answer =
      result.finishReason === "tool-calls"
        ? "I ran out of tool steps before writing an answer. The transcript and evidence panels show everything retrieved so far; ask a narrower question, or ask me to continue."
        : "The model returned no text. The transcript shows the tool calls that were made.";
  }

  // The freshness badge is always populated: if no tool happened to read the
  // pipeline status, read it here rather than leaving the answer undated.
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
  const response: AgentResponse = {
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

  logAgent("info", "agent turn", {
    provider: resolved.provider,
    model: resolved.modelId,
    credential_source: resolved.source,
    // A fingerprint, not the key. See redact.ts for why this is not a prefix.
    key: keyFingerprint(options.credential?.apiKey),
    steps: result.steps.length,
    tool_calls: trace.calls.length,
    evidence_rows: trace.evidence.length,
    finish_reason: result.finishReason,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    elapsed_ms: response.elapsed_ms,
    is_sample: trace.isSample,
  });

  return response;
}
