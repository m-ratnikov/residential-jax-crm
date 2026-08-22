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
const boundsEnv = process.env.NEXT_PUBLIC_MAP_BOUNDS;
const gatewaysEnv = process.env.NEXT_PUBLIC_IPFS_GATEWAYS;
const attachTimeoutEnv = process.env.NEXT_PUBLIC_ATTACH_TIMEOUT_MS;
const probeTimeoutEnv = process.env.NEXT_PUBLIC_GATEWAY_PROBE_TIMEOUT_MS;

function pick(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** A positive integer from an environment string, or the fallback. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
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

/* --------------------------------------------------------------- gateways */

/**
 * Where else the same artifact can be read from when the primary gateway is
 * slow or down.
 *
 * A CID is the same object whichever gateway serves it, so failover here is a
 * string rewrite and not a second copy of the data. These two were chosen
 * because they support byte range requests and permissive CORS, which is what
 * DuckDB-WASM needs to range read rather than download 49.5 MB.
 */
export const DEFAULT_IPFS_GATEWAYS = ["https://ipfs.io", "https://dweb.link"] as const;

/** How long one gateway gets to attach before the next one is tried. */
export const ATTACH_TIMEOUT_MS = positiveInt(attachTimeoutEnv, 45_000);

/**
 * How long one gateway gets to answer a single byte before it is written off.
 *
 * This is the bound that matters for first impressions. An unresponsive gateway
 * previously held the whole surface for as long as it felt like - two minutes
 * was observed - because nothing ever gave up on it.
 */
export const GATEWAY_PROBE_TIMEOUT_MS = positiveInt(probeTimeoutEnv, 8_000);

/**
 * Split a gateway URL into the part that identifies the content and the part
 * that identifies the gateway serving it.
 *
 * Returns null for anything that is not gateway addressed - the bundled sample
 * at `/sample/query-table.parquet`, or a plain HTTP host - because there is no
 * second place to look for those and pretending otherwise would generate URLs
 * that 404.
 */
export function splitGatewayUrl(url: string): { origin: string; contentPath: string } | null {
  const match = /^(https?:\/\/[^/]+)(\/(?:ipfs|ipns)\/.+)$/i.exec(url.trim());
  if (!match) return null;
  const [, origin, contentPath] = match;
  if (!origin || !contentPath) return null;
  return { origin, contentPath };
}

/**
 * The ordered list of URLs to try for one artifact: the configured one first,
 * then the same content path on each fallback gateway.
 *
 * The configured URL always leads, so a deployment that has been pointed at a
 * private or paid gateway keeps using it and only borrows a public one when its
 * own is not answering.
 */
export function ipfsGatewayCandidates(
  primaryUrl: string,
  gateways: readonly string[] = DEFAULT_IPFS_GATEWAYS,
): readonly string[] {
  const split = splitGatewayUrl(primaryUrl);
  if (!split) return [primaryUrl];

  const seen = new Set<string>([primaryUrl]);
  const candidates: string[] = [primaryUrl];

  for (const gateway of gateways) {
    const base = gateway.trim().replace(/\/+$/, "");
    if (!base || !/^https?:\/\//i.test(base)) continue;
    const candidate = `${base}${split.contentPath}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

/** `NEXT_PUBLIC_IPFS_GATEWAYS` is a comma or whitespace separated list. */
export function parseGatewayList(
  value: string | undefined,
  fallback: readonly string[] = DEFAULT_IPFS_GATEWAYS,
): readonly string[] {
  const parsed = (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\//i.test(entry));
  return parsed.length ? parsed : fallback;
}

/* ---------------------------------------------------------------- viewport */

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Where the map opens.
 *
 * Bounds rather than a centre and a zoom, because a zoom number frames a
 * different amount of county on a laptop than on a wide monitor, and the thing
 * being asserted here is *which places are on screen*, not how far out the
 * camera is.
 *
 * This is a Jacksonville CRM, so it opens over Jacksonville: downtown, the
 * riverfront neighbourhoods, Mandarin, the Southside, Arlington, the Northside
 * and the beaches. Duval also contains Baldwin, a town of 1,400 at the far
 * western edge thirty kilometres from downtown, and the map used to open wide
 * enough that Baldwin led the frame. Every screenshot of the product then
 * advertised the one part of the county nobody opened the product to see.
 *
 * The rectangle is centred east of downtown rather than on it, because the
 * housing stock this CRM is about is. That is not cosmetic: fitBounds keeps the
 * requested rectangle and spends the container's spare width on more map, so on
 * a wide monitor the viewport grows outwards from the centre. Centred on
 * downtown, Baldwin reappears at about 2:1; centred here it stays out past
 * 2.5:1, which is wider than any panel this layout produces. Beyond that the
 * county is simply wider than the frame and there is nothing to be done.
 */
export const JACKSONVILLE_BOUNDS: MapBounds = {
  west: -81.76,
  south: 30.15,
  east: -81.36,
  north: 30.47,
};

/** `NEXT_PUBLIC_MAP_BOUNDS` is "west,south,east,north" in degrees. */
export function parseMapBounds(value: string | undefined, fallback: MapBounds): MapBounds {
  // Length is checked before the numbers are, not after. Dropping the entries
  // that are not numbers and then counting what is left accepts
  // "-81.8,30.15,-81.36,30.47,extra" as a valid rectangle, which is a typo the
  // map would silently honour.
  const parts = (value ?? "").split(",").map((entry) => Number(entry.trim()));
  if (parts.length !== 4 || !parts.every((entry) => Number.isFinite(entry))) return fallback;
  const [west, south, east, north] = parts as [number, number, number, number];
  // A rectangle with no area, or one turned inside out, is a typo rather than a
  // viewport. Fall back rather than hand MapLibre something it cannot fit.
  if (west >= east || south >= north) return fallback;
  return { west, south, east, north };
}

/** True when a point is inside the rectangle. Used by the viewport tests. */
export function boundsContain(bounds: MapBounds, lng: number, lat: number): boolean {
  return lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

/* ------------------------------------------------------------------ config */

export interface PublicDataConfig {
  /** The parquet URL DuckDB-WASM range reads, straight from the tab. */
  queryTableUrl: string;
  /** The same artifact on every gateway worth trying, best first. */
  queryTableUrls: readonly string[];
  runHistoryUrl: string;
  /** True when no published artifact is configured and the bundled sample answers. */
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  center: { lat: number; lng: number; zoom: number };
  /** The rectangle the map opens on. Overrides `center` when the map can fit it. */
  initialBounds: MapBounds;
  attachTimeoutMs: number;
  probeTimeoutMs: number;
}

const isSample = !queryTableEnv?.trim();
const countyName = pick(countyEnv, "Duval");
const queryTableUrl = isSample
  ? SAMPLE_QUERY_TABLE_URL
  : resolvePublicArtifactUrl(queryTableEnv as string, "query-table.parquet");

export const publicDataConfig: PublicDataConfig = {
  queryTableUrl,
  queryTableUrls: ipfsGatewayCandidates(queryTableUrl, parseGatewayList(gatewaysEnv)),
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
    zoom: Number(pick(zoomEnv, "11")),
  },
  initialBounds: parseMapBounds(boundsEnv, JACKSONVILLE_BOUNDS),
  attachTimeoutMs: ATTACH_TIMEOUT_MS,
  probeTimeoutMs: GATEWAY_PROBE_TIMEOUT_MS,
};
