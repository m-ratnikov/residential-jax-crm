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

import {
  Badge,
  Button,
  Empty,
  Panel,
  Spinner,
  Stat,
  ago,
  count,
  plural,
  when,
} from "@/components/ui";
import { api, del, type MatcherRunRow } from "@/lib/client";
import { useDataset, useRunHistorySource, useServerStatus } from "@/lib/data/status";
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

/**
 * How many runs the list asks the server for.
 *
 * The cap the route enforces, rather than the 25 that was here: the published
 * history holds 40 today and asking for 25 listed 25 of them. The total shown
 * above the list is read from the artifact itself, so it stays right whatever
 * this number is - but there is no reason to page a document this small.
 */
const RUN_PAGE_SIZE = 100;

/**
 * The run-history stat: its number, and what that number is a count of.
 *
 * A pure function rather than three ternaries in the JSX, because the two bugs
 * this replaces were both decisions and not markup. The page printed
 * `runs.length` under "Pipeline runs seen" - so a display cap of 25 was shown
 * against a published document holding 40, and nothing on the page said which
 * of the two a reader was looking at. And an unset RUN_HISTORY_URL served the
 * bundled 8-run sample with no badge at all, which is the pre-fix symptom one
 * missing variable away.
 *
 * Both are now decided here, where a test can drive them.
 */
export function runHistoryStat(input: {
  /** True when the bundled sample is what is being read. */
  isSample: boolean;
  /** The published document's own count, or null if it could not be read. */
  publishedCount: number | null;
  /** How many runs the list below is showing. */
  listed: number;
  /** False while the list is still loading. */
  loaded: boolean;
  /** "3 hours ago" for the newest run, when there is one. */
  latestAgo: string | null;
}): { label: string; value: string; hint: string; tone: "default" | "warn" } {
  const label = "Pipeline runs published";

  if (input.isSample) {
    return {
      label,
      value: input.publishedCount !== null ? count(input.publishedCount) : count(input.listed),
      hint: "bundled sample history - set RUN_HISTORY_URL for the published one",
      tone: "warn",
    };
  }

  if (input.publishedCount === null) {
    return {
      label,
      value: input.loaded ? count(input.listed) : "-",
      hint: `${plural(input.listed, "run")} listed, published total not reachable`,
      tone: "default",
    };
  }

  return {
    label,
    value: count(input.publishedCount),
    hint:
      input.publishedCount > input.listed
        ? `latest ${count(input.listed)} listed below`
        : `all listed below${input.latestAgo ? `, latest ${input.latestAgo}` : ""}`,
    tone: "default",
  };
}

export default function PipelinePage() {
  const [status, reloadStatus] = useServerStatus();
  const dataset = useDataset();
  const runHistory = useRunHistorySource();
  const [runs, setRuns] = useState<PipelineRunRow[] | null>(null);
  const [passes, setPasses] = useState<MatcherRunRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    reloadStatus();
    return api<{ pipelineRuns: PipelineRunRow[]; matcherRuns: MatcherRunRow[] }>(
      `/api/runs?limit=${RUN_PAGE_SIZE}`,
    )
      .then((body) => {
        setRuns(body.pipelineRuns);
        setPasses(body.matcherRuns);
      })
      .catch(() => setRuns([]));
  }, [reloadStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const runMatcher = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await runMatcherPass({ trigger: "manual" });
      setMessage(
        `Evaluated ${plural(result.searchesEvaluated, "saved search", "saved searches")} and raised ${plural(result.alertsCreated, "alert")}${
          result.alertsSuppressed
            ? `, suppressing ${count(result.alertsSuppressed)} beyond the per-search cap`
            : ""
        }.`,
      );
      await load();
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
        `Removed ${plural(result.changes, "simulated field change")} and ${plural(result.courtRecords, "simulated court filing")}. Published values are restored.`,
      );
      await load();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "Nothing to clear.");
    } finally {
      setBusy(false);
    }
  };

  const latest = runs?.[0] ?? null;
  const lastPass = passes[0] ?? null;

  /**
   * The number above the run list, and what it is a number of.
   *
   * The stat used to be `runs.length` under the label "Pipeline runs seen",
   * which made a display cap look like the pipeline's history: the page asked
   * for 25, the published document held 40, and the two never reconciled for
   * anyone who opened the artifact. The value is now the document's own count,
   * and the hint says how many of them are listed below - so the page states
   * both numbers rather than conflating them.
   */
  const listed = runs?.length ?? 0;
  const published = runHistory.publishedCount;
  const runsStat = runHistoryStat({
    isSample: runHistory.isSample,
    publishedCount: published,
    listed,
    loaded: runs !== null,
    latestAgo: latest ? ago(latest.startedAt) : null,
  });

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
          label={runsStat.label}
          value={runsStat.value}
          hint={runsStat.hint}
          tone={runsStat.tone}
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
            <Row label="Run history" value={runHistory.url} mono />
            <Row
              label="History kind"
              value={
                runHistory.isSample
                  ? "bundled sample extract - set RUN_HISTORY_URL to read the published run history"
                  : `published run history${
                      runHistory.publishedCount !== null
                        ? `, ${plural(runHistory.publishedCount, "run")}`
                        : " (not reachable from this tab)"
                    }${runHistory.generatedAt ? `, as of ${runHistory.generatedAt}` : ""}`
              }
            />
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
                    {/* The run id and the new-run marker are separate elements
                        with a gap between them. Rendered as adjacent text they
                        read as one identifier - "…CWV2M8Vnew" - which is the
                        one thing a provenance column must never do. */}
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="mono max-w-[200px] truncate text-ink-400"
                          title={pass.pipelineRunId ?? undefined}
                        >
                          {pass.pipelineRunId ?? "unknown"}
                        </span>
                        {pass.pipelineRunIsNew && (
                          <Badge tone="good" title="A pipeline run this CRM had not seen before.">
                            new
                          </Badge>
                        )}
                      </div>
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
        title={
          <span className="flex flex-wrap items-center gap-2">
            Upstream pipeline runs
            {runHistory.isSample && (
              <Badge tone="warn" testId="run-history-sample">
                sample
              </Badge>
            )}
          </span>
        }
        subtitle={
          runHistory.isSample
            ? "RUN_HISTORY_URL is not set, so this is the bundled 8-run sample shipped with the app and NOT the pipeline's published history."
            : `Published by the Duval Oracle pipeline. Per-source counts are its own, not this app's.${
                published !== null && published > listed
                  ? ` Showing the latest ${count(listed)} of ${count(published)}.`
                  : ""
              }`
        }
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
