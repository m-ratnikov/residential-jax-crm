/**
 * The configuration the browser needs, inlined at build time.
 *
 * NEXT_PUBLIC_* values are baked into the bundle and are visible to anyone who
 * opens the page. That is correct for every value here: they are public,
 * content-addressed artifact URLs, and the tab talks to the IPFS gateway
 * directly with no server in between. Nothing secret can live in this file.
 *
 * `process.env.NEXT_PUBLIC_*` has to be referenced with a literal key for the
 * compiler to inline it, so these cannot be refactored into a loop.
 */

export const SAMPLE_QUERY_TABLE_URL = "/sample/query-table.parquet";
export const SAMPLE_RUN_HISTORY_URL = "/sample/run-history.json";

const queryTableEnv = process.env.NEXT_PUBLIC_PROPERTY_DATA_URL;
const runHistoryEnv = process.env.NEXT_PUBLIC_RUN_HISTORY_URL;
const countyEnv = process.env.NEXT_PUBLIC_COUNTY_NAME;
const stateEnv = process.env.NEXT_PUBLIC_STATE_CODE;
const latEnv = process.env.NEXT_PUBLIC_MAP_LAT;
const lngEnv = process.env.NEXT_PUBLIC_MAP_LNG;
const zoomEnv = process.env.NEXT_PUBLIC_MAP_ZOOM;

function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * An IPNS pointer can name a directory or an object, and the two look identical
 * as strings. A trailing slash means directory; anything else addresses the
 * object and is used unchanged. Guessing from a file extension turns a bare
 * `/ipns/k51...` into a 404 against a perfectly good artifact, which is a bug
 * the pipeline UI already found and fixed.
 */
export function resolvePublicArtifactUrl(baseUrl: string, objectName: string): string {
  const [withoutHash] = baseUrl.split("#");
  const [path = "", query] = (withoutHash ?? "").split("?");
  if (!path.endsWith("/")) return baseUrl;
  const joined = `${path.replace(/\/+$/, "")}/${objectName}`;
  return query ? `${joined}?${query}` : joined;
}

export interface PublicDataConfig {
  /** The parquet URL DuckDB-WASM range reads, straight from the tab. */
  queryTableUrl: string;
  runHistoryUrl: string;
  /** True when no published artifact is configured and the bundled sample answers. */
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  center: { lat: number; lng: number; zoom: number };
}

const isSample = !queryTableEnv?.trim();
const countyName = pick(countyEnv, "Duval");

export const publicDataConfig: PublicDataConfig = {
  queryTableUrl: isSample
    ? SAMPLE_QUERY_TABLE_URL
    : resolvePublicArtifactUrl(queryTableEnv as string, "query-table.parquet"),
  runHistoryUrl: runHistoryEnv?.trim()
    ? resolvePublicArtifactUrl(runHistoryEnv, "run-history.json")
    : SAMPLE_RUN_HISTORY_URL,
  isSample,
  label: isSample
    ? `${countyName} County sample extract`
    : `${countyName} County query table (published)`,
  countyName,
  stateCode: pick(stateEnv, "FL"),
  center: {
    lat: Number(pick(latEnv, "30.3322")),
    lng: Number(pick(lngEnv, "-81.6557")),
    zoom: Number(pick(zoomEnv, "10.5")),
  },
};
