/**
 * Parsing the pipeline's published run history, with no I/O.
 *
 * Split from the loader so both runtimes can use it: the browser fetches the
 * JSON itself, and Node reads it from a file or a gateway. The shapes are the
 * pipeline's, not this application's, so every field is read defensively - a
 * run history that gains a field must not break a CRM that has not been taught
 * about it.
 */

import type { PipelineRun, PipelineSourceDelta } from "./types";

interface RawSource {
  track?: unknown;
  source_system?: unknown;
  source_url?: unknown;
  rows_staged?: unknown;
  inserted?: unknown;
  updated?: unknown;
  unchanged?: unknown;
  table_total_after?: unknown;
  status?: unknown;
  limitations?: unknown;
}

interface RawRun {
  run_id?: unknown;
  county?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  status?: unknown;
  trigger?: unknown;
  tracks?: unknown;
  sources?: unknown;
  limitations?: unknown;
  totals?: unknown;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function toSource(raw: RawSource): PipelineSourceDelta {
  return {
    track: text(raw.track) ?? "unknown",
    sourceSystem: text(raw.source_system),
    sourceUrl: text(raw.source_url),
    rowsStaged: num(raw.rows_staged),
    inserted: num(raw.inserted),
    updated: num(raw.updated),
    unchanged: num(raw.unchanged),
    tableTotalAfter: num(raw.table_total_after),
    status: text(raw.status) ?? "unknown",
    limitations: stringArray(raw.limitations),
  };
}

function toRun(raw: RawRun): PipelineRun | null {
  const runId = text(raw.run_id);
  if (!runId) return null;
  const totals: Record<string, number> = {};
  if (raw.totals && typeof raw.totals === "object") {
    for (const [key, value] of Object.entries(raw.totals as Record<string, unknown>)) {
      totals[key] = num(value);
    }
  }
  return {
    runId,
    county: text(raw.county) ?? "unknown",
    startedAt: text(raw.started_at) ?? "",
    finishedAt: text(raw.finished_at),
    status: text(raw.status) ?? "unknown",
    trigger: text(raw.trigger),
    tracks: stringArray(raw.tracks),
    sources: Array.isArray(raw.sources)
      ? raw.sources.map((item) => toSource(item as RawSource))
      : [],
    limitations: stringArray(raw.limitations),
    totals,
  };
}

/** A published run history, with the runs a caller asked for and the total it holds. */
export interface RunHistoryDocument {
  /** Newest first, capped at the requested limit. */
  runs: readonly PipelineRun[];
  /**
   * How many runs the published document holds, BEFORE the display cap.
   *
   * The pipeline stamps `runCount` on the envelope, and that is preferred
   * because it is the number a reviewer sees when they open the artifact. It
   * falls back to counting the array for a bare-array history that has no
   * envelope to carry it.
   */
  publishedCount: number;
  /** When the pipeline published this document, if it said. */
  generatedAt: string | null;
  county: string | null;
}

/**
 * Normalise a parsed run-history document into runs, newest first, and report
 * how many runs it actually holds.
 *
 * The count is separate from `runs.length` on purpose. `/pipeline` asked this
 * for 25 runs and then printed "PIPELINE RUNS SEEN 25" from the length of what
 * came back, while the published artifact held 40 - so the page reported its
 * own page size as if it were the pipeline's history, and a reviewer who opened
 * the IPNS document saw a number that did not match. A display cap is a
 * property of the request; the total is a property of the document; they are
 * now two fields and cannot be confused for one another again.
 *
 * Accepts either the `{ county, runs: [...] }` envelope the pipeline publishes
 * or a bare array, because both have been seen.
 */
export function parseRunHistory(payload: unknown, limit = 25): RunHistoryDocument {
  const container = payload as { runs?: unknown; runCount?: unknown } | unknown[];
  const bare = Array.isArray(container);
  const rawRuns = bare
    ? container
    : Array.isArray((container as { runs?: unknown }).runs)
      ? (container as { runs: unknown[] }).runs
      : [];

  const runs = rawRuns
    .map((raw) => toRun(raw as RawRun))
    .filter((run): run is PipelineRun => run !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));

  const envelope = bare ? null : (container as { runCount?: unknown; generatedAt?: unknown });
  const declared = envelope ? Number(envelope.runCount) : Number.NaN;
  // A declared count is trusted only when it is a sane whole number that is not
  // smaller than what the document actually carries. A stale or truncated
  // `runCount` must never make the page claim fewer runs than it is listing.
  const publishedCount =
    Number.isInteger(declared) && declared >= runs.length ? declared : runs.length;

  return {
    runs: runs.slice(0, Math.max(limit, 1)),
    publishedCount,
    generatedAt: envelope ? text(envelope.generatedAt) : null,
    county: bare ? null : text((container as { county?: unknown }).county),
  };
}

/** The runs alone, for callers that only render the list. */
export function loadRunHistoryFrom(payload: unknown, limit = 25): readonly PipelineRun[] {
  return parseRunHistory(payload, limit).runs;
}

/** Total rows inserted and updated across every track in a run. */
export function runDelta(run: PipelineRun): {
  inserted: number;
  updated: number;
  unchanged: number;
} {
  return run.sources.reduce(
    (totals, source) => ({
      inserted: totals.inserted + source.inserted,
      updated: totals.updated + source.updated,
      unchanged: totals.unchanged + source.unchanged,
    }),
    { inserted: 0, updated: 0, unchanged: 0 },
  );
}

/** True when a run actually moved data, as opposed to confirming nothing changed. */
export function runMovedData(run: PipelineRun): boolean {
  const delta = runDelta(run);
  return delta.inserted > 0 || delta.updated > 0;
}
