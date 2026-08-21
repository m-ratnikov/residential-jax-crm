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
import { credentialHeaders, useAgentSettings } from "@/lib/agent/settings-client";
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

export default function AgentPage() {
  const { settings, loaded } = useAgentSettings();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/agent")
      .then((response) => (response.ok || response.status === 501 ? response.json() : null))
      .then((body: { active?: unknown } | null) => setConfigured(Boolean(body?.active)))
      .catch(() => setConfigured(false));
  }, [settings]);

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
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json", ...credentialHeaders(settings) },
        body: JSON.stringify({ messages: [...history, { role: "user", content: trimmed }] }),
      });
      const body = (await response.json()) as AgentResponse;
      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last) {
          if (response.ok) last.response = body;
          else last.error = body.message ?? body.hint ?? "The agent could not answer.";
        }
        return next;
      });
    } catch {
      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last) last.error = "The request could not reach the server.";
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
        {loaded && configured === false && (
          <Link href="/settings">
            <Button variant="primary">Add a model key</Button>
          </Link>
        )}
      </div>

      {loaded && configured === false && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          <p className="font-medium">No model is configured, so this page cannot answer yet.</p>
          <p className="mt-1 text-warn-500/80">
            This deployment ships no key of its own on purpose: a public agent endpoint with a
            server-side key attached is a bill any stranger can run up. Add your own on the settings
            page - several providers have a free tier that needs no card. Nothing else in this
            application needs a model.
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
            <Button variant="primary" onClick={() => void ask(question)} disabled={busy || !question.trim()}>
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
                <span className="tabular ml-auto text-[11px] text-ink-600">{call.elapsed_ms} ms</span>
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
                  <tr key={`${String(row.property_id)}-${index}`} className="border-t border-[var(--line)]">
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
