// VENDORED FILE - do not edit here without reading lib/oracle/VENDORED.md.
// Origin: oracle-property-intelligence-platform-pipeline-duval-fl, ui/lib/opfs.ts, commit 28088d0.
// Deliberately diverged from the original - see the DIVERGED note below for what
// changed and why. Run scripts/sync-shared.mjs to see the drift it reports.

/**
 * DIVERGED FROM THE ORIGIN, deliberately. The origin keyed every entry on the
 * full gateway URL plus a version string, which made the cache useless for the
 * one job this application needs it for: surviving a gateway outage. Two
 * changes, described where they are made:
 *
 *  1. Entries are keyed on the CONTENT the URL addresses, not the gateway that
 *     served it (`contentAddressOf`). The same parquet fetched from ipfs.io and
 *     from a dweb.link subdomain is one entry, not two.
 *  2. Every entry carries a manifest, so `cacheLookup` can find a copy with no
 *     network at all - which is the whole point when every gateway is refusing.
 *
 * `cacheGet` / `cachePut` keep their original signatures and their original
 * strict-freshness meaning, so the vendored engine above them is unchanged.
 */

/**
 * Best effort persistent cache for the published parquet, backed by the Origin
 * Private File System with an in memory fallback.
 *
 * The query table is the only large artifact the UI downloads. Caching it means
 * the second visit, and every navigation between pages, costs no gateway
 * traffic. Every OPFS call is wrapped: Safari private windows, older Firefox and
 * locked down enterprise profiles all fail here in different ways, and none of
 * those failures should stop the app from working.
 */

const memoryCache = new Map<string, Uint8Array>();
const memoryManifests = new Map<string, CacheManifest>();

const DIRECTORY = "artifact-cache";

/** What is known about a cached copy without reading the bytes back. */
export interface CacheManifest {
  /** The gateway URL the bytes were actually read from. */
  readonly sourceUrl: string;
  /**
   * The version identifier the gateway reported at the time (`x-ipfs-roots`,
   * an ETag, or a Last-Modified). Null when the gateway reported none, which
   * means freshness cannot be checked and the copy is only usable as a
   * last-resort fallback.
   */
  readonly version: string | null;
  readonly bytes: number;
  /** ISO 8601. Shown to the user, so they know how old the fallback is. */
  readonly cachedAt: string;
}

/** A cached copy and everything known about it. */
export interface CachedArtifact extends CacheManifest {
  readonly data: Uint8Array;
}

/**
 * The content a gateway URL addresses, with the gateway stripped off.
 *
 * A CID (or an IPNS name) is the same object whichever gateway serves it, so
 * caching per gateway URL stores the same 49.97 MB up to five times and still
 * misses whenever failover lands somewhere new. Both public gateway URL shapes
 * collapse to the same address here:
 *
 *   https://ipfs.io/ipns/k51.../x.parquet        -> ipns/k51.../x.parquet
 *   https://k51....ipns.dweb.link/x.parquet      -> ipns/k51.../x.parquet
 *
 * Anything that is not gateway addressed - the bundled sample, a plain host -
 * keeps its own URL as the address, because for those the URL *is* the identity.
 */
export function contentAddressOf(url: string): string {
  const trimmed = url.trim();

  const path = /^https?:\/\/[^/]+\/(ipfs|ipns)\/([^/?#]+)([^?#]*)/i.exec(trimmed);
  if (path) {
    const [, namespace = "", id = "", rest = ""] = path;
    return `${namespace.toLowerCase()}/${id}${rest.replace(/\/+$/, "")}`;
  }

  const subdomain = /^https?:\/\/([^./]+)\.(ipfs|ipns)\.[^/?#]+([^?#]*)/i.exec(trimmed);
  if (subdomain) {
    const [, id = "", namespace = "", rest = ""] = subdomain;
    return `${namespace.toLowerCase()}/${id}${rest.replace(/\/+$/, "")}`;
  }

  return trimmed;
}

function hashOf(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function keyFor(url: string): string {
  return `qt-${hashOf(contentAddressOf(url))}.parquet`;
}

function manifestKeyFor(url: string): string {
  return `qt-${hashOf(contentAddressOf(url))}.json`;
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIRECTORY, { create: true });
  } catch {
    return null;
  }
}

/**
 * Whether a cached copy would actually survive this page being closed.
 *
 * False in a Safari private window, an older Firefox, a locked down enterprise
 * profile - anywhere OPFS is missing or refused. It matters because the memory
 * fallback is fine for a 4 KB manifest and absurd for 49.97 MB of parquet: a
 * deliberate whole-object top-up that can only ever land in a Map buys nothing
 * for the next visit and pins fifty megabytes for this one.
 */
export async function cachePersists(): Promise<boolean> {
  return (await directory()) !== null;
}

function isManifest(value: unknown): value is CacheManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sourceUrl === "string" &&
    typeof record.bytes === "number" &&
    typeof record.cachedAt === "string" &&
    (record.version === null || typeof record.version === "string")
  );
}

/**
 * What is cached for this content, without reading the bytes.
 *
 * Cheap enough to call before deciding whether a background top-up is worth
 * 49.97 MB of somebody's bandwidth.
 */
export async function cacheManifest(url: string): Promise<CacheManifest | null> {
  const key = manifestKeyFor(url);
  const inMemory = memoryManifests.get(key);
  if (inMemory) return inMemory;

  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(key);
    const parsed: unknown = JSON.parse(await (await handle.getFile()).text());
    if (!isManifest(parsed)) return null;
    memoryManifests.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function readBytes(url: string): Promise<Uint8Array | null> {
  const key = keyFor(url);
  const inMemory = memoryCache.get(key);
  if (inMemory) return inMemory;

  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(key);
    const file = await handle.getFile();
    if (file.size === 0) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    memoryCache.set(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The cached copy for this URL, only when it is the version being asked for.
 *
 * This is the freshness-strict read the engine takes on a normal load: a copy
 * of last week's publish must not be served while the gateway is sitting there
 * ready to hand over this week's. `cacheLookup` is the relaxed one.
 */
export async function cacheGet(url: string, version: string | null): Promise<Uint8Array | null> {
  const manifest = await cacheManifest(url);
  if (!manifest) return null;
  if (manifest.version !== version) return null;
  return readBytes(url);
}

/**
 * The cached copy for this URL whatever version it is, or null if there is none.
 *
 * The relaxed read, for the case the strict one cannot help with: no gateway is
 * answering, so there is no version to compare against and nothing fresher to
 * be had. A caller that serves this MUST say it is serving a cached artifact
 * and when it was taken - see `AttachReady.cached`.
 */
export async function cacheLookup(url: string): Promise<CachedArtifact | null> {
  const manifest = await cacheManifest(url);
  if (!manifest) return null;
  const data = await readBytes(url);
  if (!data || data.byteLength === 0) return null;
  return { ...manifest, data };
}

export async function cachePut(
  url: string,
  version: string | null,
  bytes: Uint8Array,
): Promise<void> {
  const key = keyFor(url);
  const manifestKey = manifestKeyFor(url);
  const manifest: CacheManifest = {
    sourceUrl: url,
    version,
    bytes: bytes.byteLength,
    cachedAt: new Date().toISOString(),
  };

  memoryCache.set(key, bytes);
  memoryManifests.set(manifestKey, manifest);

  const dir = await directory();
  if (!dir) return;
  try {
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    // Copy into a plain ArrayBuffer so the write is not tied to the wasm heap.
    await writable.write(bytes.slice().buffer as ArrayBuffer);
    await writable.close();

    // The manifest is written second on purpose. A tab closed mid-write leaves
    // bytes with no manifest, which reads as "nothing cached"; the other order
    // would leave a manifest promising a truncated file.
    const meta = await dir.getFileHandle(manifestKey, { create: true });
    const metaWritable = await meta.createWritable();
    await metaWritable.write(JSON.stringify(manifest));
    await metaWritable.close();
  } catch {
    // Cache is an optimisation. Losing it is not an error worth surfacing.
  }
}

export async function cacheClear(): Promise<void> {
  memoryCache.clear();
  memoryManifests.clear();
  const dir = await directory();
  if (!dir) return;
  try {
    const entries = dir as unknown as {
      keys?: () => AsyncIterableIterator<string>;
      removeEntry: (name: string) => Promise<void>;
    };
    if (!entries.keys) return;
    const names: string[] = [];
    for await (const name of entries.keys()) names.push(name);
    for (const name of names) await entries.removeEntry(name);
  } catch {
    // ignore
  }
}
