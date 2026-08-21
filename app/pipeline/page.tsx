/**
 * The evidence page.
 *
 * This is where a reviewer goes to answer "is this thing actually driven by a
 * continuous pipeline, or by a static snapshot someone dropped in". So it shows
 * the upstream pipeline's runs with their real per-source inserted / updated /
 * unchanged counts and declared limitations, and next to them every matcher
 * pass this CRM has made - including the passes that raised nothing, because a
 * history that only records the passes that fired cannot answer "why did
 * nothing arrive last night".
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Empty, Panel, Spinner, Stat, ago, count, when } from "@/components/ui";
import { api, del, type MatcherRunRow } from "@/lib/client";
import { useDataset, useServerStatus } from "@/lib/data/status";
import { runMatcherPass } from "@/lib/notify/client-matcher";

interface PipelineRunRow {
  runId: string;
  county: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string | null;
  tracks: string[];
  limitations: string[];
  delta: { inserted: number; updated: number; unchanged: number };
  sources: {
    track: string;
    sourceSystem: string | null;
    sourceUrl: string | null;
    inserted: number;
    updated: number;
    unchanged: number;
    tableTotalAfter: number;
    status: string;
    limitations: string[];
  }[];
}

export default function PipelinePage() {
  const [status, reloadStatus] = useServerStatus();
  const dataset = useDataset();
  const [runs, setRuns] = useState<PipelineRunRow[] | null>(null);
  const [passes, setPasses] = useState<MatcherRunRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    reloadStatus();
    api<{ pipelineRuns: PipelineRunRow[]; matcherRuns: MatcherRunRow[] }>("/api/runs?limit=25")
      .then((body) => {
        setRuns(body.pipelineRuns);
        setPasses(body.matcherRuns);
      })
      .catch(() => setRuns([]));
  }, [reloadStatus]);

  useEffect(load, [load]);

  const runMatcher = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await runMatcherPass({ trigger: "manual" });
      setMessage(
        `Evaluated ${count(result.searchesEvaluated)} saved searches and raised ${count(result.alertsCreated)} alerts${
          result.alertsSuppressed
            ? `, suppressing ${count(result.alertsSuppressed)} beyond the per-search cap`
            : ""
        }.`,
      );
      load();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The pass failed.");
    } finally {
      setBusy(false);
    }
  };

  const clearSimulation = async () => {
    setBusy(true);
    try {
      const result = await del<{ changes: number; courtRecords: number }>("/api/simulate");
      setMessage(
        `Removed ${count(result.changes)} simulated field changes and ${count(result.courtRecords)} simulated court filings. Published values are restored.`,
      );
      load();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "Nothing to clear.");
    } finally {
      setBusy(false);
    }
  };

  const latest = runs?.[0] ?? null;
  const lastPass = passes[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Pipeline and matcher</h1>
          <p className="text-xs text-ink-500">
            What this CRM is reading, when it last read it, and what it did about the change.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={runMatcher} disabled={busy}>
            {busy ? "Running" : "Run matcher now"}
          </Button>
          {(status?.overlay.simulatedProperties ?? 0) > 0 && (
            <Button variant="danger" onClick={clearSimulation} disabled={busy}>
              Clear simulation
            </Button>
          )}
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-accent-500/40 bg-accent-500/10 px-4 py-3 text-xs text-accent-400">
          {message}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Parcels loaded"
          value={dataset ? count(dataset.rowCount) : "-"}
          hint={dataset?.isSample ? "bundled sample extract" : "published county table"}
          tone={dataset?.isSample ? "warn" : "good"}
        />
        <Stat
          label="Published columns"
          value={dataset ? count(dataset.columnCount) : "-"}
          hint="all readable on a parcel"
        />
        <Stat
          label="Pipeline runs seen"
          value={runs ? count(runs.length) : "-"}
          hint={latest ? `latest ${ago(latest.startedAt)}` : "no run history"}
        />
        <Stat
          label="Matcher passes"
          value={count(passes.length)}
          hint={lastPass ? `latest ${ago(lastPass.startedAt)}` : "none yet"}
          tone={lastPass?.error ? "bad" : "default"}
        />
      </div>

      <Panel
        title="Data source"
        subtitle="Swapping this is one environment variable, not a code change."
      >
        {!status ? (
          <Spinner />
        ) : (
          <dl className="space-y-1.5 text-[11px]">
            <Row label="Label" value={dataset?.label ?? "attaching"} />
            <Row label="Location" value={dataset?.location ?? "attaching"} mono />
            <Row
              label="Kind"
              value={
                dataset?.isSample
                  ? "bundled sample extract - set PROPERTY_DATA_URL to read the full published artifact"
                  : "published county query table read over HTTP range requests"
              }
            />
            <Row label="Produced by run" value={dataset?.runId ?? "unknown"} mono />
            <Row label="As of" value={dataset?.generatedAt ?? "unknown"} />
            <Row
              label="CRM store"
              value={`${status.crmStore.kind} - ${status.crmStore.location}${
                status.crmStore.writable ? "" : " (read only)"
              }`}
            />
            <Row
              label="Court records"
              value={
                status.overlay.courtDataAvailable
                  ? `${count(status.overlay.courtProperties)} parcels carry filings`
                  : "no court source"
              }
            />
            {status.overlay.simulatedProperties > 0 && (
              <Row
                label="Simulated"
                value={`${count(status.overlay.simulatedProperties)} parcels, runs ${status.overlay.simulatedRunIds.join(", ")}`}
              />
            )}
          </dl>
        )}
      </Panel>

      <Panel title="Matcher passes" subtitle="Every pass, including the ones that raised nothing.">
        {passes.length === 0 ? (
          <Empty title="No passes yet">
            Save a criteria set, then run the matcher. In deployment a GitHub Actions cron calls the
            same endpoint on a schedule.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="border-b border-[var(--line)] uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-2 py-1.5">Started</th>
                  <th className="px-2 py-1.5">Trigger</th>
                  <th className="px-2 py-1.5">Pipeline run</th>
                  <th className="px-2 py-1.5">Searches</th>
                  <th className="px-2 py-1.5">Parcels</th>
                  <th className="px-2 py-1.5">Alerts</th>
                  <th className="px-2 py-1.5">Suppressed</th>
                  <th className="px-2 py-1.5">Sent</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {passes.map((pass) => (
                  <tr key={pass.id} className="border-b border-[var(--line)] last:border-0">
                    <td className="px-2 py-1.5 text-ink-300" title={when(pass.startedAt)}>
                      {ago(pass.startedAt)}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={pass.trigger === "simulation" ? "warn" : "outline"}>
                        {pass.trigger}
                      </Badge>
                    </td>
                    <td className="mono max-w-[220px] truncate px-2 py-1.5 text-ink-400">
                      {pass.pipelineRunId ?? "unknown"}
                      {pass.pipelineRunIsNew && <span className="ml-1 text-good-500">new</span>}
                    </td>
                    <td className="px-2 py-1.5 text-ink-300">{count(pass.searchesEvaluated)}</td>
                    <td className="px-2 py-1.5 text-ink-300">{count(pass.propertiesEvaluated)}</td>
                    <td className="px-2 py-1.5 text-ink-100">{count(pass.alertsCreated)}</td>
                    <td className="px-2 py-1.5 text-ink-500">{count(pass.alertsSuppressed)}</td>
                    <td className="px-2 py-1.5 text-ink-500">{count(pass.notificationsSent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Upstream pipeline runs"
        subtitle="Published by the Duval Oracle pipeline. Per-source counts are its own, not this app's."
      >
        {runs === null ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <Empty title="No run history reachable">
            Set RUN_HISTORY_URL to the pipeline&apos;s published run-history.json.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => {
              const open = expanded === run.runId;
              const moved = run.delta.inserted > 0 || run.delta.updated > 0;
              return (
                <li key={run.runId} className="rounded-lg border border-[var(--line)]">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : run.runId)}
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--panel-raised)]"
                  >
                    <Badge tone={run.status === "completed" ? "good" : "warn"}>{run.status}</Badge>
                    <span className="mono text-[11px] text-ink-300">{run.runId}</span>
                    <span className="text-[11px] text-ink-500">{ago(run.startedAt)}</span>
                    <span className="tabular ml-auto text-[11px] text-ink-400">
                      {moved
                        ? `+${count(run.delta.inserted)} new, ${count(run.delta.updated)} updated, ${count(run.delta.unchanged)} unchanged`
                        : `${count(run.delta.unchanged)} unchanged`}
                    </span>
                    {run.limitations.length > 0 && (
                      <Badge tone="warn">{run.limitations.length} limitations</Badge>
                    )}
                  </button>

                  {open && (
                    <div className="border-t border-[var(--line)] px-3 py-2">
                      <table className="w-full text-left text-[11px]">
                        <thead className="uppercase tracking-wide text-ink-500">
                          <tr>
                            <th className="py-1">Track</th>
                            <th className="py-1">Source</th>
                            <th className="py-1">Inserted</th>
                            <th className="py-1">Updated</th>
                            <th className="py-1">Unchanged</th>
                            <th className="py-1">Total after</th>
                          </tr>
                        </thead>
                        <tbody className="tabular">
                          {run.sources.map((source) => (
                            <tr key={`${run.runId}-${source.track}`}>
                              <td className="py-1 text-ink-200">{source.track}</td>
                              <td className="max-w-[200px] truncate py-1 text-ink-500">
                                {source.sourceSystem ?? "-"}
                              </td>
                              <td className="py-1 text-ink-300">{count(source.inserted)}</td>
                              <td className="py-1 text-ink-300">{count(source.updated)}</td>
                              <td className="py-1 text-ink-500">{count(source.unchanged)}</td>
                              <td className="py-1 text-ink-300">{count(source.tableTotalAfter)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {run.limitations.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {run.limitations.map((limitation) => (
                            <li key={limitation} className="text-[11px] text-warn-500">
                              {limitation}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-ink-500">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all text-ink-200 ${mono ? "mono" : ""}`}>{value}</dd>
    </div>
  );
}
