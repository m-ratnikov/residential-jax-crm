/**
 * Natural language exploration.
 *
 * The answer is only half of what this page shows. Under every reply sit the
 * tool calls the agent made, the rows those calls returned, and the caveats the
 * tools observed - a sample dataset, a roof age that is really a proxy, a value
 * that came from a simulated update. That is deliberate: an acquisitions
 * analyst is about to spend money on the strength of this, and a fluent
 * paragraph with nothing behind it is worse than no answer.
 */

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge, Button, Panel, Spinner, TextArea, ago, count, cx } from "@/components/ui";
import type { AgentProvider } from "@/lib/agent/providers";
import { runClientAgent } from "@/lib/agent/client-run";
import { isAgentError } from "@/lib/agent/errors";
import type { AgentResponse } from "@/lib/agent/types";

const SUGGESTIONS = [
  "Which residential properties in the Arlington area match a distressed profile - roofs older than 15 years, no ownership change in 10 or more years - and have not been contacted yet?",
  "How many parcels have I got in each acquisition stage, and what is the total assessed value of the live ones?",
  "Show me the ten cheapest absentee-owned houses with a roof past 20 years, and say which of them already have an opportunity open.",
  "What did the last pipeline run actually change, and did any of my saved searches gain matches because of it?",
];

interface Turn {
  question: string;
  response: AgentResponse | null;
  error: string | null;
}

/** One entry of what GET /api/agent publishes as `server_models`. */
interface ServerModel {
  provider: AgentProvider;
  provider_label: string;
  id: string;
  label: string;
  free: boolean;
  notes: string;
}

/** A stable value for the <select>, since a model id is only unique per provider. */
const key = (model: ServerModel) => `${model.provider}:${model.id}`;

export default function AgentPage() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // The models this deployment can answer with on its own key. Fetched rather
  // than compiled in, because whether a key exists is a property of the
  // deployment and not of the build.
  const [offered, setOffered] = useState<ServerModel[] | null>(null);
  const [chosen, setChosen] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { server_models?: ServerModel[] } | null) => {
        if (cancelled) return;
        const models = body?.server_models ?? [];
        setOffered(models);
        setChosen((current) => current || (models[0] ? key(models[0]) : ""));
      })
      .catch(() => {
        if (!cancelled) setOffered([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = (offered ?? []).find((model) => key(model) === chosen) ?? offered?.[0] ?? null;

  // Null while the list is still loading, so the page does not flash a warning
  // at somebody whose model is about to arrive.
  const nothingAvailable = offered !== null && offered.length === 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setQuestion("");
    setBusy(true);
    const history = turns
      .filter((turn) => turn.response)
      .flatMap((turn) => [
        { role: "user" as const, content: turn.question },
        { role: "assistant" as const, content: turn.response?.answer ?? "" },
      ]);

    setTurns((current) => [...current, { question: trimmed, response: null, error: null }]);

    try {
      if (!selected) {
        throw new Error(
          "This deployment has no model configured, so the agent cannot answer. Everything else in the application works without one.",
        );
      }

      // The loop runs here, in the tab, because its tools have to reach the
      // parcel data and the query engine is here. The key does not: the model
      // call is forwarded by /api/llm, which attaches it server-side.
      const body = await runClientAgent({
        messages: [...history, { role: "user", content: trimmed }],
        serverModel: { provider: selected.provider, modelId: selected.id },
      });

      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last) last.response = body;
        return next;
      });
    } catch (cause: unknown) {
      const message = isAgentError(cause)
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : "The agent could not answer.";
      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last) last.error = message;
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Ask about the pipeline</h1>
          <p className="text-xs text-ink-500">
            Answers come from tool calls against the same data the map reads. Every claim is shown
            with the rows behind it.
          </p>
        </div>
        {offered !== null && offered.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
            Model
            <select
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              disabled={busy}
              className="rounded-md border border-[var(--line)] bg-[var(--panel-raised)] px-2 py-1 text-[12px] text-ink-100 outline-none focus:border-accent-500"
            >
              {offered.map((model) => (
                <option key={key(model)} value={key(model)} title={model.notes}>
                  {model.provider_label} - {model.label}
                  {model.free ? " (free tier)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {nothingAvailable && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          <p className="font-medium">This deployment has no model configured.</p>
          <p className="mt-1 text-warn-500/80">
            Set a provider key in the environment and the models it offers appear here. Nothing else
            in this application needs a model: the map, search, saved criteria, alerts and the
            acquisition board all work without one.
          </p>
        </div>
      )}

      {turns.length === 0 && (
        <Panel title="Try one of these">
          <div className="space-y-1.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => void ask(suggestion)}
                className="w-full rounded-md border border-[var(--line)] px-3 py-2 text-left text-[12px] text-ink-300 transition-colors hover:bg-[var(--panel-raised)] hover:text-ink-100"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </Panel>
      )}

      <div className="space-y-3">
        {turns.map((turn, index) => (
          <div key={`${index}-${turn.question.slice(0, 24)}`} className="space-y-2">
            <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-raised)] px-3 py-2 text-[13px] text-ink-100">
              {turn.question}
            </div>

            {turn.error && (
              <div className="rounded-lg border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
                {turn.error}
              </div>
            )}

            {turn.response && <AnswerBlock response={turn.response} />}

            {!turn.response && !turn.error && (
              <div className="rounded-lg border border-[var(--line)] px-3 py-3">
                <Spinner label="Working through the data" />
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-3">
        <Panel bodyClassName="p-2.5">
          <div className="flex gap-2">
            <div className="flex-1">
              <TextArea
                value={question}
                onChange={setQuestion}
                rows={2}
                placeholder="Ask about parcels, saved criteria, alerts or the pipeline"
              />
            </div>
            <Button
              variant="primary"
              onClick={() => void ask(question)}
              disabled={busy || !question.trim()}
            >
              {busy ? "Asking" : "Ask"}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function AnswerBlock({ response }: { response: AgentResponse }) {
  const [tab, setTab] = useState<"answer" | "transcript" | "evidence">("answer");

  return (
    <Panel
      bodyClassName="p-0"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>Answer</span>
          {response.model && <Badge tone="outline">{response.model}</Badge>}
          {response.data_freshness && (
            <Badge
              tone={response.data_freshness.is_sample ? "warn" : "good"}
              title={`Pipeline run ${response.data_freshness.run_id ?? "unknown"}`}
            >
              {response.data_freshness.is_sample ? "sample data" : "published data"}
              {response.data_freshness.finished_at
                ? ` - ${ago(response.data_freshness.finished_at)}`
                : ""}
            </Badge>
          )}
          {response.usage?.steps ? (
            <Badge tone="neutral">{count(response.usage.steps)} steps</Badge>
          ) : null}
        </span>
      }
      actions={
        <div className="flex gap-1">
          {(["answer", "transcript", "evidence"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTab(option)}
              className={cx(
                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                tab === option
                  ? "bg-[var(--panel-raised)] text-ink-100"
                  : "text-ink-500 hover:text-ink-200",
              )}
            >
              {option === "transcript"
                ? `Tools (${count(response.tool_calls?.length ?? 0)})`
                : option === "evidence"
                  ? `Rows (${count(response.evidence?.length ?? 0)})`
                  : "Answer"}
            </button>
          ))}
        </div>
      }
    >
      {tab === "answer" && (
        <div className="px-4 py-3">
          <div className="prose-invert space-y-2 text-[13px] leading-relaxed text-ink-200 [&_a]:text-accent-400 [&_code]:mono [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:text-[12px] [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_table]:w-full [&_table]:text-[11px] [&_td]:border-t [&_td]:border-[var(--line)] [&_td]:px-1.5 [&_td]:py-1 [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:text-ink-500">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{response.answer}</ReactMarkdown>
          </div>

          {response.assumptions.length > 0 && (
            <div className="mt-3 rounded-md border border-warn-500/30 bg-warn-500/5 px-3 py-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warn-500">
                Caveats the tools observed
              </h3>
              <ul className="mt-1 space-y-0.5">
                {response.assumptions.map((assumption) => (
                  <li key={assumption} className="text-[11px] text-warn-500/90">
                    {assumption}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "transcript" && (
        <ul className="divide-y divide-[var(--line)]">
          {(response.tool_calls ?? []).map((call, index) => (
            <li key={`${call.name}-${index}`} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-[12px] text-accent-400">{call.name}</span>
                <span className="text-[11px] text-ink-500">{call.output_summary}</span>
                <span className="tabular ml-auto text-[11px] text-ink-600">
                  {call.elapsed_ms} ms
                </span>
              </div>
              {call.error && <p className="mt-1 text-[11px] text-bad-500">{call.error}</p>}
              <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 text-[10px] text-ink-500">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </li>
          ))}
          {!response.tool_calls?.length && (
            <li className="px-4 py-4 text-[11px] text-ink-500">No tools were called.</li>
          )}
        </ul>
      )}

      {tab === "evidence" && (
        <div className="max-h-[420px] overflow-auto px-4 py-3">
          {response.evidence?.length ? (
            <table className="w-full text-left text-[11px]">
              <thead className="text-ink-500">
                <tr>
                  <th className="py-1">Parcel</th>
                  <th className="py-1">Address</th>
                  <th className="py-1">Source</th>
                  <th className="py-1">Collected</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {response.evidence.map((row, index) => (
                  <tr
                    key={`${String(row.property_id)}-${index}`}
                    className="border-t border-[var(--line)]"
                  >
                    <td className="mono py-1 text-ink-300">{String(row.property_id)}</td>
                    <td className="max-w-[280px] truncate py-1 text-ink-200">
                      {String(row.address ?? "")}
                    </td>
                    <td className="py-1 text-ink-500">{String(row.source_system ?? "")}</td>
                    <td className="py-1 text-ink-500">{String(row.fetched_at ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-ink-500">
              No rows were quoted. Ask a question that names parcels.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
