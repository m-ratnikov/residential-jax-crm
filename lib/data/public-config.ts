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
const attemptsEnv = process.env.NEXT_PUBLIC_GATEWAY_ATTEMPTS;
const passesEnv = process.env.NEXT_PUBLIC_GATEWAY_PASSES;
const backoffEnv = process.env.NEXT_PUBLIC_GATEWAY_RETRY_BACKOFF_MS;
const budgetEnv = process.env.NEXT_PUBLIC_ATTACH_BUDGET_MS;
const precacheEnv = process.env.NEXT_PUBLIC_ARTIFACT_PRECACHE;
const cacheMaxEnv = process.env.NEXT_PUBLIC_ARTIFACT_CACHE_MAX_BYTES;
const minBytesEnv = process.env.NEXT_PUBLIC_ARTIFACT_MIN_BYTES;

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
 * A boolean from an environment string.
 *
 * "0", "false", "off" and "no" turn a default-on feature off; anything else
 * that is set turns it on. An unset variable keeps the default, which is the
 * only reason this is not just `value === "1"`.
 */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return fallback;
  return !["0", "false", "off", "no"].includes(trimmed);
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
 * string rewrite and not a second copy of the data. Every entry below was
 * verified against the deployment's own `/ipns/` name on 2026-08-22, with the
 * request DuckDB-WASM actually makes rather than the one that is convenient to
 * test - a cross-origin `GET` carrying a `Range` header:
 *
 *   https://ipfs.io/ipns/<name>              preflight 200 (Range allowed), 206
 *   https://<name>.ipns.dweb.link/           preflight 200 (Range allowed), 206
 *   https://ipfs.filebase.io/ipns/<name>     preflight 204 (Range allowed), 206
 *
 * `https://dweb.link/ipns/<name>` - which used to be the second entry in this
 * list - is NOT here, and its removal is the single most useful line in this
 * change. The path form answers `HEAD` with a 301 to the subdomain form, so the
 * liveness probe passed it happily, and a 301 on a CORS *preflight* is a hard
 * failure by specification: the browser never issues the real request. Half the
 * configured fallback capacity could not have worked, on any browser, ever.
 * The subdomain form it redirects to serves the identical bytes with no hop.
 *
 * Also tried and rejected, so nobody has to test them again: w3s.link (301 on
 * preflight, same defect), 4everland.io (301 then 504), trustless-gateway.link
 * (406 without a block Accept header), gateway.pinata.cloud and storry.tv (403
 * without an account), gw3.io (206 of a 965 byte error page), gateway.ipfs.io
 * and nftstorage.link (redirect to ipfs.io, so no added redundancy), and
 * cloudflare-ipfs.com, cf-ipfs.com, flk-ipfs.xyz, hardbin.com, dlunar.net,
 * ipfs-gateway.cloud and ipfs.eth.aragon.network (no DNS or no connection).
 */
export const DEFAULT_IPFS_GATEWAYS = [
  "https://ipfs.io",
  "https://{id}.{ns}.dweb.link",
  "https://ipfs.filebase.io",
] as const;

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
 * How many times one gateway is tried before moving on, within a single pass.
 *
 * Only a *fast* failure is retried - a 502, a rate limit, a connection reset.
 * A gateway that consumed its whole deadline and said nothing has already had
 * its chance, and asking again just spends the deadline twice.
 */
export const GATEWAY_ATTEMPTS = positiveInt(attemptsEnv, 2);

/**
 * How many times the whole candidate list is swept.
 *
 * Failover on its own treats a bad thirty seconds as permanent: the first
 * gateway is written off, the list runs out, and the app gives up while the
 * gateway that stumbled is already answering again. A second sweep costs
 * nothing when the first one works and is the difference between a retry the
 * visitor has to click and one they never see.
 */
export const GATEWAY_PASSES = positiveInt(passesEnv, 2);

/** First wait before re-trying a gateway. Doubles per attempt, capped at 8x. */
export const GATEWAY_RETRY_BACKOFF_MS = positiveInt(backoffEnv, 750);

/**
 * The wall clock bound on the whole attach, across every gateway and pass.
 *
 * Passes times candidates times attempts times two deadlines multiplies out to
 * a quarter of an hour, which is not a wait, it is an abandonment. No new
 * attempt starts once this is spent, so the worst case is this budget plus
 * whatever the attempt already in flight has left.
 */
export const ATTACH_BUDGET_MS = positiveInt(budgetEnv, 120_000);

/**
 * Whether a successful load tops the browser cache up in the background.
 *
 * On by default, and it is what makes the cache a real fallback rather than a
 * decoration: a range read deliberately never touches most of the file, so
 * without this one deliberate whole-object fetch there is nothing on disk to
 * fall back to when the gateways go down. It costs the visitor one transfer,
 * once per publish, after the page is already usable.
 */
export const ARTIFACT_PRECACHE = envFlag(precacheEnv, true);

/** Refuse to cache an artifact larger than this. 128 MB by default. */
export const ARTIFACT_CACHE_MAX_BYTES = positiveInt(cacheMaxEnv, 134_217_728);

/**
 * The smallest object this deployment will accept as the query table.
 *
 * A gateway is allowed to answer a range request with `206` and hand back an
 * error page; gw3.io does exactly that, reporting a total size of 965 bytes for
 * a 49.5 MB parquet. Believing it costs a full attach deadline and then a
 * baffling DuckDB parse error, so the probe checks the total it is told.
 */
export const ARTIFACT_MIN_BYTES = positiveInt(minBytesEnv, 1_048_576);

/**
 * Split a gateway URL into the part that identifies the content and the part
 * that identifies the gateway serving it.
 *
 * Returns null for anything that is not gateway addressed - the bundled sample
 * at `/sample/query-table.parquet`, or a plain HTTP host - because there is no
 * second place to look for those and pretending otherwise would generate URLs
 * that 404.
 */
export interface GatewayUrlParts {
  origin: string;
  contentPath: string;
  /** "ipfs" or "ipns", lower case. */
  namespace: string;
  /** The CID or IPNS name itself. */
  id: string;
  /** Anything addressed under it, leading slash included. Usually empty. */
  suffix: string;
}

export function splitGatewayUrl(url: string): GatewayUrlParts | null {
  const match = /^(https?:\/\/[^/]+)(\/(ipfs|ipns)\/([^/?#]+)([^?#]*))$/i.exec(url.trim());
  if (!match) return null;
  const [, origin, contentPath, namespace, id, suffix] = match;
  if (!origin || !contentPath || !namespace || !id) return null;
  return { origin, contentPath, namespace: namespace.toLowerCase(), id, suffix: suffix ?? "" };
}

/**
 * A subdomain gateway addresses content as `<id>.<ns>.<host>` rather than
 * `<host>/<ns>/<id>`, and only base32/base36 identifiers survive the move: DNS
 * labels are case insensitive and capped at 63 characters, so a CIDv0 (`Qm...`,
 * case sensitive base58) cannot be written that way at all.
 */
function isSubdomainSafe(id: string): boolean {
  return /^[a-z0-9]{1,63}$/.test(id);
}

/**
 * One gateway entry applied to one piece of content, or null if it cannot be.
 *
 * Two shapes are accepted, because the two public gateway conventions are not
 * interchangeable and the one that matters most here is the subdomain form:
 *
 *   https://ipfs.io                 -> https://ipfs.io/ipns/<id>
 *   https://{id}.{ns}.dweb.link     -> https://<id>.ipns.dweb.link/
 *
 * The template form exists because dweb.link's *path* form only answers with a
 * 301 to its subdomain form, and a redirect on a CORS preflight is fatal - the
 * browser gives up before it ever sends the ranged request. Addressing the
 * subdomain directly removes the hop and the failure with it.
 */
export function applyGateway(gateway: string, parts: GatewayUrlParts): string | null {
  const entry = gateway.trim();
  if (!entry || !/^https?:\/\//i.test(entry)) return null;

  if (entry.includes("{id}") || entry.includes("{ns}")) {
    if (!isSubdomainSafe(parts.id)) return null;
    const base = entry
      .replace(/\/+$/, "")
      .replaceAll("{id}", parts.id)
      .replaceAll("{ns}", parts.namespace);
    return parts.suffix ? `${base}${parts.suffix}` : `${base}/`;
  }

  return `${entry.replace(/\/+$/, "")}${parts.contentPath}`;
}

/**
 * The ordered list of URLs to try for one artifact: the configured one first,
 * then the same content on each fallback gateway.
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
    const candidate = applyGateway(gateway, split);
    if (!candidate || seen.has(candidate)) continue;
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
  /** The same run history on every gateway worth trying, best first. */
  runHistoryUrls: readonly string[];
  /**
   * True when NEXT_PUBLIC_RUN_HISTORY_URL is unset and the bundled 8-run sample
   * is what `/pipeline` is reading.
   *
   * Separate from `isSample`, which is about the parcel dataset only. The two
   * fall back independently, and a deployment reading real parcels against a
   * sample history used to look exactly like a deployment reading both for
   * real. See resolveRunHistorySource.
   */
  runHistoryIsSample: boolean;
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
  /** How many times one gateway is tried before moving on, within a pass. */
  attemptsPerGateway: number;
  /** How many times the whole candidate list is swept. */
  passes: number;
  retryBackoffMs: number;
  /** Wall clock bound on the whole attach, across every gateway and pass. */
  budgetMs: number;
  /** Whether a successful load tops the browser cache up in the background. */
  precache: boolean;
  cacheMaxBytes: number;
  /** Smallest object this deployment will believe is the query table. */
  minArtifactBytes: number;
}

/**
 * Where the run history is read from, and whether that is the bundled sample.
 *
 * Pulled out of the config object and exported so the fallback is a testable
 * decision rather than a ternary nobody looks at. An unset variable silently
 * served the 8-run sample on `/pipeline` with no SAMPLE badge - which is the
 * exact symptom this app already badges for the parcel dataset - so the
 * fallback now returns the fact along with the URL and the page has no way to
 * render one without the other.
 */
export function resolveRunHistorySource(configured: string | undefined): {
  url: string;
  isSample: boolean;
} {
  const trimmed = configured?.trim();
  if (!trimmed) return { url: SAMPLE_RUN_HISTORY_URL, isSample: true };
  return { url: resolvePublicArtifactUrl(trimmed, "run-history.json"), isSample: false };
}

const isSample = !queryTableEnv?.trim();
const countyName = pick(countyEnv, "Duval");
const queryTableUrl = isSample
  ? SAMPLE_QUERY_TABLE_URL
  : resolvePublicArtifactUrl(queryTableEnv as string, "query-table.parquet");
const runHistory = resolveRunHistorySource(runHistoryEnv);

export const publicDataConfig: PublicDataConfig = {
  queryTableUrl,
  queryTableUrls: ipfsGatewayCandidates(queryTableUrl, parseGatewayList(gatewaysEnv)),
  runHistoryUrl: runHistory.url,
  runHistoryUrls: ipfsGatewayCandidates(runHistory.url, parseGatewayList(gatewaysEnv)),
  runHistoryIsSample: runHistory.isSample,
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
  attemptsPerGateway: GATEWAY_ATTEMPTS,
  passes: GATEWAY_PASSES,
  retryBackoffMs: GATEWAY_RETRY_BACKOFF_MS,
  budgetMs: ATTACH_BUDGET_MS,
  precache: ARTIFACT_PRECACHE,
  cacheMaxBytes: ARTIFACT_CACHE_MAX_BYTES,
  minArtifactBytes: ARTIFACT_MIN_BYTES,
};
