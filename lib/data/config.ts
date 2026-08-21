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

export const QUERY_TABLE_OBJECT = "query-table.parquet";
export const RUN_HISTORY_OBJECT = "run-history.json";

export interface DataConfig {
  /** Parquet path or URL DuckDB reads. */
  queryTableSource: string;
  runHistoryUrl: string | null;
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  /** Default map centre. Downtown Jacksonville unless overridden. */
  center: { lat: number; lng: number; zoom: number };
}

/**
 * Resolve a configured artifact URL to the exact object DuckDB should read.
 *
 * A trailing slash means "this is a directory, append the object name"; anything
 * else addresses the object directly and is used unchanged.
 *
 * The trailing slash has to carry that meaning because nothing else can. The
 * pipeline points each IPNS name at a single file's CID, so the query table
 * lives at `/ipns/k51...` with nothing after it - while the Elephant convention
 * also permits a name pointing at a directory, which looks identical as a
 * string. Guessing from a file extension decides a bare `/ipns/k51...` must be
 * a directory and requests `/ipns/k51.../query-table.parquet`; the gateway
 * returns 404 against a perfectly good artifact. That bug was found and fixed
 * in the pipeline UI, and this is the corrected rule rather than a second
 * independent guess.
 */
export function resolveArtifactUrl(baseUrl: string, objectName: string): string {
  const [withoutHash] = baseUrl.split("#");
  const [path = "", query] = (withoutHash ?? "").split("?");
  if (!path.endsWith("/")) return baseUrl;
  const joined = `${path.replace(/\/+$/, "")}/${objectName}`;
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

  return {
    queryTableSource,
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
