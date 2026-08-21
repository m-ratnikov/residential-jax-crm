/**
 * Where the property data comes from, and how the app says so out loud.
 *
 * The whole point of this module is that swapping the sample for the published
 * county artifact is an environment change, not a code change:
 *
 *   PROPERTY_DATA_URL=https://ipfs.filebase.io/ipns/k51.../query-table.parquet
 *   RUN_HISTORY_URL=https://ipfs.filebase.io/ipns/k51.../run-history.json
 *
 * With neither set, the bundled sample answers and every surface that shows
 * data carries a SAMPLE badge. There is no third state where the app is running
 * on a subset and not saying so.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const SAMPLE_QUERY_TABLE = "public/sample/query-table.parquet";
export const SAMPLE_RUN_HISTORY = "public/sample/run-history.json";
export const SAMPLE_COURT_DATA = "public/sample/court-records.parquet";

export const QUERY_TABLE_OBJECT = "query-table.parquet";
export const RUN_HISTORY_OBJECT = "run-history.json";

export interface DataConfig {
  /** Parquet path or URL DuckDB reads. */
  queryTableSource: string;
  /** Court dataset, when one is configured or bundled. */
  courtSource: string | null;
  runHistoryUrl: string | null;
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  /** Default map centre. Downtown Jacksonville unless overridden. */
  center: { lat: number; lng: number; zoom: number };
}

/**
 * An IPNS pointer published by the pipeline is a directory root. DuckDB cannot
 * range read a directory, so append the object name when the configured URL
 * does not already name a file. Shared behaviour with the pipeline UI.
 */
export function resolveArtifactUrl(baseUrl: string, objectName: string): string {
  const [withoutHash] = baseUrl.split("#");
  const [path, query] = (withoutHash ?? "").split("?");
  const last = (path ?? "").split("/").filter(Boolean).pop() ?? "";
  if (/\.[a-z0-9]{2,8}$/i.test(last)) return baseUrl;
  const joined = `${(path ?? "").replace(/\/+$/, "")}/${objectName}`;
  return query ? `${joined}?${query}` : joined;
}

function firstConfigured(...candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function existsLocally(relative: string): boolean {
  try {
    return existsSync(resolve(process.cwd(), relative));
  } catch {
    return false;
  }
}

export function dataConfig(env: NodeJS.ProcessEnv = process.env): DataConfig {
  const countyName = env.NEXT_PUBLIC_COUNTY_NAME?.trim() || "Duval";
  const stateCode = env.NEXT_PUBLIC_STATE_CODE?.trim() || "FL";

  const configured = firstConfigured(
    env.PROPERTY_DATA_URL,
    env.QUERY_TABLE_URL,
    env.NEXT_PUBLIC_QUERY_TABLE_URL,
  );

  let queryTableSource: string;
  let isSample: boolean;

  if (configured && /^https?:\/\//i.test(configured)) {
    queryTableSource = resolveArtifactUrl(configured, QUERY_TABLE_OBJECT);
    isSample = false;
  } else if (configured && !configured.startsWith("/sample/") && existsSync(configured)) {
    queryTableSource = resolve(configured);
    isSample = false;
  } else {
    queryTableSource = resolve(process.cwd(), SAMPLE_QUERY_TABLE);
    isSample = true;
  }

  const runHistoryConfigured = firstConfigured(env.RUN_HISTORY_URL, env.NEXT_PUBLIC_RUN_HISTORY_URL);
  const runHistoryUrl = runHistoryConfigured
    ? /^https?:\/\//i.test(runHistoryConfigured)
      ? resolveArtifactUrl(runHistoryConfigured, RUN_HISTORY_OBJECT)
      : resolve(runHistoryConfigured)
    : existsLocally(SAMPLE_RUN_HISTORY)
      ? resolve(process.cwd(), SAMPLE_RUN_HISTORY)
      : null;

  const courtConfigured = firstConfigured(env.COURT_DATA_URL);
  const courtSource = courtConfigured
    ? /^https?:\/\//i.test(courtConfigured)
      ? courtConfigured
      : resolve(courtConfigured)
    : existsLocally(SAMPLE_COURT_DATA)
      ? resolve(process.cwd(), SAMPLE_COURT_DATA)
      : null;

  return {
    queryTableSource,
    courtSource,
    runHistoryUrl,
    isSample,
    label: isSample
      ? `${countyName} County sample extract`
      : `${countyName} County query table (published)`,
    countyName,
    stateCode,
    center: {
      lat: Number(env.NEXT_PUBLIC_MAP_LAT ?? 30.3322),
      lng: Number(env.NEXT_PUBLIC_MAP_LNG ?? -81.6557),
      zoom: Number(env.NEXT_PUBLIC_MAP_ZOOM ?? 10.5),
    },
  };
}
