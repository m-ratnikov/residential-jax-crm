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

/**
 * Normalise a parsed run-history document into runs, newest first.
 *
 * Accepts either the `{ county, runs: [...] }` envelope the pipeline publishes
 * or a bare array, because both have been seen.
 */
export function loadRunHistoryFrom(payload: unknown, limit = 25): readonly PipelineRun[] {
  const container = payload as { runs?: unknown } | unknown[];
  const rawRuns = Array.isArray(container)
    ? container
    : Array.isArray((container as { runs?: unknown }).runs)
      ? (container as { runs: unknown[] }).runs
      : [];

  return rawRuns
    .map((raw) => toRun(raw as RawRun))
    .filter((run): run is PipelineRun => run !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, Math.max(limit, 1));
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
