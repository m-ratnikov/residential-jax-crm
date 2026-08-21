"use client";

/**
 * Running a matcher pass from the tab.
 *
 * The browser holds the query engine, so it is the browser that evaluates
 * criteria against the published parquet and posts what it found. The server
 * then applies the shared decision logic: diff against the last pass, seed a
 * new search rather than announcing it, cap alerts per search, write the
 * evidence record.
 *
 * This exists so the whole loop can be demonstrated in one sitting - define
 * criteria, simulate an update, watch the alert arrive - without waiting for
 * the half-hourly cron. The cron does exactly the same thing from GitHub
 * Actions with native DuckDB, and its alerts are indistinguishable because the
 * deciding code is the same.
 */

import { criteriaSetSchema } from "@/lib/criteria/types";
import { materialSnapshot } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import type { ScoredProperty } from "@/lib/data/types";
import { fetchOverlay, propertySource } from "@/lib/data/client-source";
import { post, type SavedSearch } from "@/lib/client";
import type { MatcherResult } from "./evaluate";

/** Matches the server-side cap, so a pass from either side sees the same set. */
export const MATCH_EVALUATION_CAP = 5_000;

function alertSnapshot(scored: ScoredProperty): Record<string, unknown> {
  const property = scored.property;
  return {
    propertyId: property.propertyId,
    address: displayAddress(property),
    addressCity: property.addressCity,
    addressZip: property.addressZip,
    latitude: property.latitude,
    longitude: property.longitude,
    ownerName: property.ownerName,
    assessedValue: property.assessedValue,
    roofAgeYears: property.roofAgeYears,
    roofAgeBasis: property.roofAgeBasis,
    yearsSinceLastSale: property.yearsSinceLastSale,
    lastSaleDate: property.lastSaleDate,
    ownerOccupied: property.ownerOccupied,
    homesteadFlag: property.homesteadFlag,
    waterViewFlag: property.waterViewFlag,
    courtDistressScore: property.raw["court_distress_score"] ?? null,
    provenance: property.provenance,
  };
}

export interface RunPassOptions {
  /** Limit the pass to these saved searches. Used right after a simulation. */
  savedSearchIds?: readonly string[];
  trigger?: "manual" | "simulation" | "browser";
  /** Called between searches so the UI can show progress on a slow pass. */
  onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * Evaluate the active saved searches in this tab and post the result.
 *
 * @throws if the CRM store is unreachable. Search itself needs no store, so the
 * caller distinguishes "nothing to match against" from "the query failed".
 */
export async function runMatcherPass(options: RunPassOptions = {}): Promise<MatcherResult> {
  const source = propertySource();

  const [{ searches }, overlay, info, runs] = await Promise.all([
    (await fetch("/api/searches").then((response) => response.json())) as Promise<{
      searches: SavedSearch[];
    }>,
    fetchOverlay(),
    source.info(),
    source.listRuns(1),
  ]);

  const wanted = options.savedSearchIds?.length
    ? searches.filter((search) => options.savedSearchIds?.includes(search.id))
    : searches.filter((search) => search.active);

  // A simulated change is its own run and takes precedence: by construction it
  // is the most recent thing that happened to the data.
  const simulated = overlay.simulatedRunIds.at(-1) ?? null;
  const latest = runs[0] ?? null;
  const pipelineRunId = simulated ?? latest?.runId ?? info.runId ?? null;

  const evaluations = [];
  let done = 0;

  for (const search of wanted) {
    options.onProgress?.(done, wanted.length, search.name);
    done += 1;

    const parsed = criteriaSetSchema.safeParse(search.criteria);
    if (!parsed.success) {
      evaluations.push({
        savedSearchId: search.id,
        matched: 0,
        rows: [],
        truncated: false,
        error: "the stored criteria set failed validation and was skipped",
      });
      continue;
    }

    try {
      const result = await source.search({
        criteria: parsed.data,
        limit: MATCH_EVALUATION_CAP,
        orderBy: "score",
        overlay: overlay.overlay,
      });

      evaluations.push({
        savedSearchId: search.id,
        matched: result.total,
        truncated: result.total > result.rows.length,
        rows: result.rows.map((scored) => ({
          propertyId: scored.property.propertyId,
          matchHash: scored.matchHash,
          snapshot: materialSnapshot(scored.property),
          score: scored.score,
          rationale: scored.rationale,
          propertySnapshot: alertSnapshot(scored),
        })),
      });
    } catch (error: unknown) {
      evaluations.push({
        savedSearchId: search.id,
        matched: 0,
        rows: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  options.onProgress?.(wanted.length, wanted.length, "");

  return post<MatcherResult>("/api/matcher/run", {
    trigger: options.trigger ?? "browser",
    pipelineRunId,
    pipelineRunStartedAt: latest?.startedAt ?? null,
    dataSource: {
      kind: info.kind,
      location: info.location,
      rowCount: info.rowCount,
      isSample: info.isSample,
    },
    evaluations,
  });
}
