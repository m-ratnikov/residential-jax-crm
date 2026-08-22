"use client";

/**
 * `PropertyDataSource`, implemented in the visitor's tab.
 *
 * This is the deployed read path, and it is the one the assignment actually
 * asks for. The story requires the CRM to run "without requiring Oracle to
 * carry ongoing hosted-database cost beyond the existing Duval pipeline +
 * DuckDB / Elephant IPFS pattern". DuckDB-WASM range reading the published
 * parquet straight off the gateway IS that pattern: nothing is copied, nothing
 * is converted, and no server is involved in answering a query. When the
 * pipeline re-points its IPNS name, the next page load reads the new data with
 * no redeploy.
 *
 * The engine underneath (lib/oracle/duckdb.ts) is vendored from the pipeline
 * repository, where it already does this at 404,023 parcels. What is new here
 * is only the mapping from this application's interface onto it, so the browser
 * and the Node matcher answer the same criteria with the same SQL and the same
 * scoring.
 */

import {
  runQuery,
  ensureLoaded,
  getState,
  resetEngine,
  attachCachedBuffer,
  precacheArtifact,
} from "@/lib/oracle/duckdb";
import { cacheLookup } from "@/lib/oracle/opfs";
import {
  ARTIFACT_CACHE_MAX_BYTES,
  ARTIFACT_MIN_BYTES,
  ARTIFACT_PRECACHE,
  ATTACH_BUDGET_MS,
  GATEWAY_ATTEMPTS,
  GATEWAY_PASSES,
  GATEWAY_RETRY_BACKOFF_MS,
} from "./public-config";
import { COLUMN_MEANINGS } from "@/lib/oracle/agent/schema";
import { EXTRA_COLUMNS, PROVENANCE_COLUMNS } from "@/lib/oracle/columns";
import { guardSql } from "@/lib/oracle/sql";
import { buildSearch, SCORE_ALIAS, TOTAL_ALIAS, str, VIEW } from "@/lib/criteria/sql";
import { matchHashOf, rationaleFor } from "@/lib/criteria/score";
import { buildOverlay, EMPTY_OVERLAY, isEmptyOverlay, type Overlay } from "./overlay";
import { toRecord } from "./map";
import type {
  AttachFailed,
  AttachReady,
  AttachState,
  CachedArtifactInfo,
  ColumnDescriptor,
  DataSourceInfo,
  GatewayAttempt,
  PipelineRun,
  PropertyDataSource,
  PropertyRecord,
  PropertySearchQuery,
  PropertySearchResult,
  QueryResult,
  ScoredProperty,
} from "./types";
import { loadRunHistoryFrom } from "./runs-parse";

const DERIVED = new Set<string>(EXTRA_COLUMNS);
const PROVENANCE = new Set<string>(PROVENANCE_COLUMNS);

/* ------------------------------------------------------------------ attach */

/**
 * Everything the attach controller does to the outside world, in one object it
 * is handed rather than reaches for.
 *
 * The controller is the part with the interesting behaviour - give up on a
 * gateway, ask it again, move to the next one, come back round, fall back to
 * the cache, say all of it out loud - and that behaviour has to be provable
 * without a WASM engine, a network, or a two minute wait. So the network, the
 * engine, the cache and the clock all arrive as functions, and a test supplies
 * ones that refuse, hang or answer on demand and never spend a real second.
 *
 * The five required members are the ones every caller needs. The rest are
 * optional, which is not decoration: it keeps a test that cares only about
 * failover four functions long, and it means the vendored engine is reached for
 * by the default implementation and by nothing else.
 */
export interface AttachDeps {
  /** Ask a gateway for one byte. Rejects if it will not answer in time. */
  probe(url: string, signal: AbortSignal): Promise<void>;
  /** Attach the artifact at this URL to the query engine. */
  load(url: string): Promise<void>;
  /** Abandon whatever the engine was doing, so the next gateway starts clean. */
  reset(): Promise<void>;
  /** Byte level progress for the URL being attached, when the engine has any. */
  progress(url: string): EngineProgress | null;
  now(): number;

  /**
   * Attach this browser's own cached copy of the artifact, with no network at
   * all. Resolves to what was attached, or null when there is nothing cached.
   *
   * Optional so that a test that does not care about the cache stays four
   * functions long, and so that the vendored engine is only reached for by the
   * default implementation.
   */
  attachCached?(): Promise<CachedArtifactInfo | null>;

  /**
   * Called once, after a gateway has answered, to make sure a cached copy
   * exists for next time. Must not block and must not throw.
   */
  precache?(url: string): void;

  /** Wait between retries. Injected so a test spends no real time waiting. */
  sleep?(ms: number): Promise<void>;
}

export interface EngineProgress {
  message: string;
  progress: number | null;
  accessMode: string | null;
}

export interface AttachOptions {
  /** The same artifact on every gateway worth trying, best first. */
  candidates: readonly string[];
  /** How long one gateway gets to attach before the next is tried. */
  attachTimeoutMs: number;
  /** How long one gateway gets to answer a single byte before it is written off. */
  probeTimeoutMs: number;
  /** How many times one gateway is asked before moving on, within one pass. */
  attemptsPerGateway?: number;
  /** How many times the whole candidate list is swept. */
  passes?: number;
  /** First wait before re-trying a gateway. Doubles per attempt, capped at 8x. */
  retryBackoffMs?: number;
  /** Wall clock bound on the whole attach, across every gateway and pass. */
  budgetMs?: number;
  deps: AttachDeps;
}

class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    // Rounded to seconds because that is the unit a person waiting reads in,
    // except below a second, where rounding would report a bound of "0s".
    const bound = ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${ms}ms`;
    super(`${what} did not answer within ${bound}`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `work` under a deadline, and abort it when the deadline passes.
 *
 * The signal is for work that can be cancelled (a fetch). Work that cannot -
 * the engine's own load, which takes no signal - is raced instead and left to
 * finish into a void; the caller resets the engine so its late result cannot
 * land on top of the gateway that has since answered.
 */
async function withDeadline<T>(
  what: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(what, ms));
      controller.abort();
    }, ms);
  });

  // Aborting the work makes it reject with the platform's own abort error, and
  // that reject can win the race. "aborted" tells a person nothing; the whole
  // reason for the deadline is to be able to say which gateway ran out of time
  // and how long it had, so a post-deadline failure is relabelled here.
  const guarded = work(controller.signal).catch((cause: unknown) => {
    if (timedOut) throw new TimeoutError(what, ms);
    throw cause;
  });

  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this failure is worth asking the same gateway about again.
 *
 * A timeout is not. It already had the full deadline and spent all of it, so a
 * second ask buys the same silence at twice the price - and on a five gateway
 * list that price is the difference between a bounded wait and an abandoned
 * one. A refusal is different: a 502, a rate limit, a reset connection and a
 * transient DNS failure are all things a public gateway does for a few seconds
 * at a time, and writing a gateway off for one of them is how a working
 * fallback list turns into an empty one.
 */
function worthRetrying(error: unknown): boolean {
  return !(error instanceof TimeoutError);
}

/** Exponential backoff from a base, capped at eight times it. */
export function backoffFor(base: number, attempt: number): number {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), base * 8);
}

const asSeconds = (ms: number): string => `${Math.round(ms / 1_000)}s`;

/**
 * The sentence a person reads when nothing worked.
 *
 * Everything in it is here because "the data could not be loaded" leaves the
 * reader with no next move. What was tried, what each one said, how long it
 * took, and the two things that actually help - wait, or point the deployment
 * at a gateway you can reach.
 */
export function exhaustedMessage(
  attempts: readonly GatewayAttempt[],
  passes: number,
  elapsedMs: number,
): string {
  if (attempts.length === 0) return "no gateway was configured for this artifact";

  const detail = attempts
    .map((attempt) => {
      const count = attempt.tries > 1 ? ` (asked ${attempt.tries} times)` : "";
      return `${hostOf(attempt.url)} - ${attempt.error}${count}`;
    })
    .join("; ");

  const sweeps = passes > 1 ? ` over ${passes} passes` : "";
  return (
    `No IPFS gateway could serve the county query table, and this browser has no cached copy ` +
    `to fall back on. Tried ${attempts.length} gateway${attempts.length === 1 ? "" : "s"}` +
    `${sweeps} in ${asSeconds(elapsedMs)}: ${detail}. ` +
    `Public gateways usually recover within a few minutes, so retrying is worth a try; ` +
    `a deployment that keeps seeing this should set NEXT_PUBLIC_IPFS_GATEWAYS to a gateway ` +
    `it can reach.`
  );
}

/** How the surface should describe a dataset that came out of the cache. */
export function cachedLocationLabel(cached: CachedArtifactInfo): string {
  const megabytes = (cached.bytes / 1024 / 1024).toFixed(1);
  const taken = cached.cachedAt.slice(0, 19).replace("T", " ");
  return `${cached.sourceUrl} (cached copy, ${megabytes} MB, taken ${taken} UTC, no gateway reachable)`;
}

/**
 * Attach the published artifact, and keep trying until there is genuinely
 * nothing left to try.
 *
 * The previous version bounded the wait and failed over, which stopped the app
 * lying and stopped it hanging. What it did not do was *recover*: one bad
 * response wrote a gateway off for the session, the list ran out in order, and
 * the visitor was handed a retry button for something the machine could have
 * done itself. A reviewer driving the live deployment hit exactly that.
 *
 * Five things this owns:
 *
 * 1. **A bound.** Every gateway gets a probe deadline and an attach deadline,
 *    and the whole attempt gets a wall clock budget on top, so the worst case
 *    is a number rather than a multiplication.
 * 2. **Retry.** A gateway that *refuses* - 502, rate limit, reset - is asked
 *    again after a backoff. A gateway that goes *silent* is not, because it
 *    already spent the whole deadline proving nothing.
 * 3. **Failover, then round again.** A CID is the same object whichever gateway
 *    serves it, so the fallback is a URL rewrite rather than a second copy of
 *    the data. When the list is exhausted it is swept again rather than
 *    abandoned; a public gateway's bad thirty seconds is not a bad session.
 * 4. **The cache as a real fallback.** After the first sweep fails, this
 *    browser's own copy from a previous visit is attached, with no network at
 *    all. That is what lets a demo machine open the app with every gateway
 *    down - and the state says so out loud, because serving last week's
 *    artifact silently would be its own kind of lie.
 * 5. **A state a caller can render honestly.** `attaching` carries elapsed time
 *    and progress; `ready` carries whether it came from the cache and when that
 *    copy was taken; `failed` carries what each gateway did and what to do next.
 */
export class GatewayAttach {
  readonly #options: AttachOptions;

  #startedAt: number | null = null;
  #index = 0;
  #failedOver = false;
  #note: string | null = null;
  #outcome: AttachReady | AttachFailed | null = null;
  #attachedUrl: string | null = null;
  #run: Promise<void> | null = null;
  /** First-try order, so the terminal message reads like the attempt did. */
  #attempts = new Map<string, { tries: number; error: string; timedOut: boolean }>();

  constructor(options: AttachOptions) {
    this.#options = options;
  }

  /** The URL that actually attached, once one has. */
  attachedUrl(): string | null {
    return this.#attachedUrl;
  }

  state(): AttachState {
    if (this.#outcome) return this.#outcome;

    const { candidates, deps } = this.#options;
    const gateway = candidates[this.#index] ?? candidates[0] ?? "";
    const progress = this.#startedAt === null ? null : deps.progress(gateway);

    return {
      phase: "attaching",
      // Engine progress wins when there is any: real bytes beat a description
      // of what is being attempted. The note is what fills the gap before the
      // engine has been handed anything, which is where a retry happens.
      message: progress?.message ?? this.#note ?? "Attaching the published query table",
      progress: progress?.progress ?? null,
      elapsedMs: this.#startedAt === null ? 0 : Math.max(0, deps.now() - this.#startedAt),
      gateway,
      gatewayIndex: this.#index,
      gatewayCount: candidates.length,
      failedOver: this.#failedOver,
    };
  }

  /** Idempotent: every page calls this, only the first call does work. */
  start(): Promise<void> {
    this.#run ??= this.#attach();
    return this.#run;
  }

  /** Start over from the first gateway after a failure. */
  retry(): Promise<void> {
    this.#run = null;
    this.#outcome = null;
    this.#attachedUrl = null;
    this.#index = 0;
    this.#failedOver = false;
    this.#note = null;
    this.#attempts = new Map();
    this.#startedAt = null;
    return this.start();
  }

  #elapsed(): number {
    const { deps } = this.#options;
    return Math.max(0, deps.now() - (this.#startedAt ?? deps.now()));
  }

  #spent(): boolean {
    return this.#elapsed() >= (this.#options.budgetMs ?? ATTACH_BUDGET_MS);
  }

  #record(url: string, error: unknown): void {
    const existing = this.#attempts.get(url);
    this.#attempts.set(url, {
      tries: (existing?.tries ?? 0) + 1,
      error: messageOf(error),
      timedOut: error instanceof TimeoutError,
    });
  }

  #attemptList(): readonly GatewayAttempt[] {
    return [...this.#attempts].map(([url, attempt]) => ({ url, ...attempt }));
  }

  /**
   * One gateway, one attempt. Resolves true when the artifact is attached.
   *
   * Every failure resets the engine before returning: a half attached engine
   * would answer the next gateway's queries out of the previous one's file
   * handle, which is a wrong answer rather than a slow one.
   */
  async #tryOnce(url: string): Promise<boolean> {
    const { deps, attachTimeoutMs, probeTimeoutMs } = this.#options;

    try {
      // The probe is the cheap half, and it asks the exact question the attach
      // will: a cross-origin ranged GET. A gateway that cannot answer that in
      // eight seconds is not going to range read 49.5 MB, and finding that out
      // costs one request rather than the whole attach deadline.
      await withDeadline(`the gateway at ${hostOf(url)}`, probeTimeoutMs, (signal) =>
        deps.probe(url, signal),
      );

      const load = deps.load(url);
      // The orphan of a timed out load must not surface as an unhandled
      // rejection; the reset below is what actually disowns it.
      load.catch(() => undefined);
      await withDeadline(`the query table at ${hostOf(url)}`, attachTimeoutMs, () => load);

      this.#attachedUrl = url;
      this.#outcome = {
        phase: "ready",
        gateway: url,
        failedOver: this.#failedOver,
        elapsedMs: this.#elapsed(),
        accessMode: deps.progress(url)?.accessMode ?? null,
        cached: null,
      };
      // A range read touches a few hundred kilobytes of a 49.5 MB file, so
      // nothing is left behind for next time unless something asks for it.
      deps.precache?.(url);
      return true;
    } catch (cause: unknown) {
      this.#record(url, cause);
      await deps.reset().catch(() => undefined);
      if (worthRetrying(cause)) throw cause;
      return false;
    }
  }

  /** Every candidate once through, retrying the ones that refused outright. */
  async #sweep(pass: number): Promise<boolean> {
    const { candidates, deps } = this.#options;
    const attemptsPerGateway = Math.max(1, this.#options.attemptsPerGateway ?? GATEWAY_ATTEMPTS);
    const backoffBase = this.#options.retryBackoffMs ?? GATEWAY_RETRY_BACKOFF_MS;
    const wait = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let index = 0; index < candidates.length; index += 1) {
      const url = candidates[index];
      if (!url) continue;

      this.#index = index;

      for (let attempt = 1; attempt <= attemptsPerGateway; attempt += 1) {
        if (this.#spent()) return false;

        this.#failedOver = !(pass === 0 && index === 0 && attempt === 1);
        this.#note =
          attempt > 1
            ? `Retrying ${hostOf(url)} (attempt ${attempt} of ${attemptsPerGateway})`
            : pass > 0
              ? `Trying ${hostOf(url)} again`
              : null;

        try {
          if (await this.#tryOnce(url)) return true;
          // A timeout: it had its whole deadline and used all of it. Asking a
          // second time spends the same deadline for the same silence.
          break;
        } catch {
          // A refusal, which is worth one more ask after a pause.
          if (attempt >= attemptsPerGateway) break;
          await wait(backoffFor(backoffBase, attempt));
        }
      }
    }

    return false;
  }

  /**
   * The bytes this machine already has, when no gateway will give us any.
   *
   * Deliberately after the first sweep and not before it. Before it, a stale
   * copy would be served while a perfectly healthy gateway sat there holding
   * this morning's publish; after it, the choice is between last week's data
   * clearly labelled as last week's, and a dead page. The engine's own load
   * path still prefers a *fresh* cached copy over the network, so the fast
   * second visit costs no gateway traffic either way.
   */
  async #serveFromCache(): Promise<boolean> {
    const { deps } = this.#options;
    if (!deps.attachCached) return false;

    this.#note = "Falling back to this browser's cached copy";
    const cached = await deps.attachCached().catch(() => null);
    if (!cached) {
      // Nothing there. The note must not outlive the attempt, or the next pass
      // would report it is falling back to a cache that does not exist.
      this.#note = null;
      return false;
    }

    this.#attachedUrl = cached.sourceUrl;
    this.#outcome = {
      phase: "ready",
      gateway: cached.sourceUrl,
      failedOver: true,
      elapsedMs: this.#elapsed(),
      accessMode: "cached",
      cached,
    };
    return true;
  }

  async #attach(): Promise<void> {
    const { candidates, deps } = this.#options;
    this.#startedAt = deps.now();

    const passes = Math.max(1, this.#options.passes ?? GATEWAY_PASSES);

    for (let pass = 0; pass < passes; pass += 1) {
      if (await this.#sweep(pass)) return;

      // Tried exactly once, after the first full sweep. A cache miss does not
      // become a hit by asking again, and a hit ends the attach here.
      if (pass === 0 && (await this.#serveFromCache())) return;

      if (this.#spent()) break;
    }

    this.#note = null;
    const attempts = this.#attemptList();
    this.#outcome = {
      phase: "failed",
      error:
        candidates.length === 0
          ? "no gateway was configured"
          : exhaustedMessage(attempts, passes, this.#elapsed()),
      tried: attempts.map((attempt) => attempt.url),
      elapsedMs: this.#elapsed(),
      attempts,
    };
  }
}

/** The host of a URL, for a message a person reads. Falls back to the URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The engine's own progress, but only when it is talking about the URL we are
 * currently attaching.
 *
 * The engine keeps one module level state. After a failover its previous,
 * abandoned load can still write into it, and reporting that as this gateway's
 * progress would be exactly the class of lie this whole change exists to remove.
 */
export function engineProgressFor(
  state: {
    stage: string;
    message: string;
    progress: number | null;
    sourceUrl: string | null;
    accessMode: string | null;
  },
  url: string,
): EngineProgress | null {
  const source = state.sourceUrl;
  if (!source) return null;
  if (source !== url && !source.endsWith(url)) return null;
  return { message: state.message, progress: state.progress, accessMode: state.accessMode };
}

/**
 * A gateway is alive if it answered at all, and can serve this artifact.
 *
 * The question the probe asks is deliberately narrow. It is not "does this
 * gateway support range reads" - the engine already handles a gateway that does
 * not, by downloading the object once instead - so answering that question here
 * would fail a gateway over something it can cope with.
 *
 * 405 and 501 mean the gateway is there and does not do HEAD, which is an
 * answer. 404 means it does not have this content, so the next gateway is the
 * right move. Anything 5xx or rate limited will not serve 49.5 MB either.
 */
export function gatewayIsAlive(status: number): boolean {
  if (status === 405 || status === 501) return true;
  return status >= 200 && status < 400;
}

export interface RangeVerdict {
  /** Whether this gateway is worth handing to the engine at all. */
  readonly ok: boolean;
  /** True when it answered 206, so the engine can range read rather than download. */
  readonly ranged: boolean;
  /** The object size the gateway claims, from `Content-Range`. */
  readonly totalBytes: number | null;
  /** Why, in words that end up in the terminal message. */
  readonly reason: string;
}

/** The total from a `Content-Range: bytes 0-0/49974055` header. */
export function contentRangeTotal(header: string | null): number | null {
  const match = /\/(\d+)\s*$/.exec(header ?? "");
  if (!match?.[1]) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * What a ranged probe response actually proves.
 *
 * The old probe was a `HEAD`, chosen to avoid the CORS preflight that a `Range`
 * header triggers. That preflight turned out to be the single most important
 * thing to test: `https://dweb.link/ipns/<name>` answers `HEAD` with a 301 and
 * answers the *preflight* with a 301 too, and a redirected preflight is a hard
 * failure by specification - the browser never sends the real request. The
 * probe passed a gateway that could not have worked, on any browser, ever.
 *
 * A 200 is still a pass. It means the gateway ignored the range and will hand
 * over the whole object, which the engine copes with by downloading once; that
 * is slower, not broken, and failing over for it would abandon a gateway that
 * works.
 */
export function rangeProbeVerdict(
  status: number,
  contentRange: string | null,
  minBytes: number,
): RangeVerdict {
  if (!gatewayIsAlive(status)) {
    return { ok: false, ranged: false, totalBytes: null, reason: `answered ${status}` };
  }

  if (status !== 206) {
    return {
      ok: true,
      ranged: false,
      totalBytes: null,
      reason: "does not honour byte ranges, so the whole object will be downloaded once",
    };
  }

  const totalBytes = contentRangeTotal(contentRange);
  if (totalBytes !== null && totalBytes < minBytes) {
    // A gateway is allowed to answer 206 with an error page. gw3.io does, and
    // reports a total of 965 bytes for a 49.5 MB parquet. Believing it costs a
    // whole attach deadline and then an unreadable DuckDB error.
    return {
      ok: false,
      ranged: true,
      totalBytes,
      reason: `served a ${totalBytes} byte object, which is too small to be the query table`,
    };
  }

  return { ok: true, ranged: true, totalBytes, reason: "range reads the artifact" };
}

/** Run `work` when the tab is idle, so a background top-up costs no interaction. */
function whenIdle(work: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") idle(work, { timeout: 30_000 });
  else setTimeout(work, 2_000);
}

export interface BrowserDepsOptions {
  /**
   * The candidate URLs, only so the cache can be addressed.
   *
   * Any one of them will do: entries are keyed on the content a URL addresses
   * rather than on the gateway that served it, so the copy taken from ipfs.io
   * last week is found when the configured Filebase URL is the one being asked
   * about today.
   */
  urls?: readonly string[];
  /** Smallest object this deployment will believe is the query table. */
  minArtifactBytes?: number;
  /** Whether a successful load tops the browser cache up in the background. */
  precache?: boolean;
  cacheMaxBytes?: number;
}

/** The real deps: a ranged probe on the gateway, and the vendored WASM engine. */
export function browserAttachDeps(options: BrowserDepsOptions = {}): AttachDeps {
  const minBytes = options.minArtifactBytes ?? ARTIFACT_MIN_BYTES;
  const artifactUrl = options.urls?.[0] ?? null;
  const precacheEnabled = options.precache ?? ARTIFACT_PRECACHE;
  const cacheMaxBytes = options.cacheMaxBytes ?? ARTIFACT_CACHE_MAX_BYTES;

  return {
    async probe(url, signal) {
      // A ranged GET rather than a HEAD, and one byte of it. This is the exact
      // request the engine will make, preflight included, which is the only
      // version of the question worth asking - see rangeProbeVerdict.
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal,
      });
      // Never read the body: a gateway that ignored the range is offering all
      // 49.5 MB of it, and the probe is not the place to accept.
      void response.body?.cancel().catch(() => undefined);

      const verdict = rangeProbeVerdict(
        response.status,
        response.headers.get("content-range"),
        minBytes,
      );
      if (!verdict.ok) throw new Error(`${hostOf(url)} ${verdict.reason}`);
    },

    load: (url) => ensureLoaded(url),
    reset: () => resetEngine(),
    progress: (url) => engineProgressFor(getState(), url),
    now: () => Date.now(),

    async attachCached() {
      if (!artifactUrl) return null;
      const entry = await cacheLookup(artifactUrl).catch(() => null);
      if (!entry) return null;
      await attachCachedBuffer(entry);
      return {
        sourceUrl: entry.sourceUrl,
        bytes: entry.bytes,
        cachedAt: entry.cachedAt,
        version: entry.version,
      };
    },

    precache(url) {
      if (!precacheEnabled) return;
      whenIdle(() => {
        void precacheArtifact(url, cacheMaxBytes).catch(() => undefined);
      });
    },

    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

/* ------------------------------------------------------------------ source */

export interface BrowserSourceOptions {
  /**
   * The parquet URLs DuckDB-WASM range reads, best first. The same content on
   * each gateway; the first one that both answers a probe and attaches is
   * the one that is used.
   */
  urls: readonly string[];
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  runHistoryUrl: string | null;
  attachTimeoutMs: number;
  probeTimeoutMs: number;
  /** How many times one gateway is asked before moving on, within one pass. */
  attemptsPerGateway?: number;
  /** How many times the whole candidate list is swept. */
  passes?: number;
  retryBackoffMs?: number;
  /** Wall clock bound on the whole attach, across every gateway and pass. */
  budgetMs?: number;
  /** Whether a successful load tops the browser cache up in the background. */
  precache?: boolean;
  cacheMaxBytes?: number;
  minArtifactBytes?: number;
  /** Overridden in tests. Defaults to the network and the vendored engine. */
  deps?: AttachDeps;
}

export class BrowserPropertyDataSource implements PropertyDataSource {
  readonly kind = "duckdb-wasm-browser";

  #info: DataSourceInfo | null = null;
  #schema: readonly ColumnDescriptor[] | null = null;
  #runs: readonly PipelineRun[] | null = null;
  readonly #attach: GatewayAttach;

  constructor(private readonly options: BrowserSourceOptions) {
    this.#attach = new GatewayAttach({
      candidates: options.urls,
      attachTimeoutMs: options.attachTimeoutMs,
      probeTimeoutMs: options.probeTimeoutMs,
      attemptsPerGateway: options.attemptsPerGateway,
      passes: options.passes,
      retryBackoffMs: options.retryBackoffMs,
      budgetMs: options.budgetMs,
      deps:
        options.deps ??
        browserAttachDeps({
          urls: options.urls,
          precache: options.precache,
          cacheMaxBytes: options.cacheMaxBytes,
          minArtifactBytes: options.minArtifactBytes,
        }),
    });
  }

  /** Start attaching without waiting, so the UI can show progress. */
  prefetch(): Promise<void> {
    return this.#attach.start();
  }

  /** Whether there is anything to query yet. Never a row count. */
  attachState(): AttachState {
    return this.#attach.state();
  }

  /** Try every gateway again after they all refused. */
  retryAttach(): Promise<void> {
    this.#info = null;
    this.#schema = null;
    return this.#attach.retry();
  }

  async #query(sql: string) {
    await this.#attach.start();
    const state = this.#attach.state();
    if (state.phase === "failed") throw new Error(state.error);
    const url = this.#attach.attachedUrl();
    if (!url) throw new Error("the query table has not attached");
    return runQuery(url, sql);
  }

  async info(): Promise<DataSourceInfo> {
    if (this.#info) return this.#info;

    const [counts, schema] = await Promise.all([
      this.#query(`SELECT count(*) AS n FROM ${VIEW}`),
      this.getSchema(),
    ]);

    // features_as_of and run_id are uniform across the export, so any_value is
    // both correct and cheap.
    const meta = await this.#query(
      `SELECT any_value(run_id) AS run_id, max(features_as_of) AS as_of FROM ${VIEW}`,
    ).catch(() => null);

    // A cached artifact is a different claim from a live one, and the surfaces
    // that print "Dataset" and "Location" are where a person would find out.
    // Saying "Duval County query table (published)" over bytes taken last
    // Tuesday from a gateway that is currently refusing everything is the same
    // class of lie as "no parcels match these criteria" during a cold load.
    const attach = this.#attach.state();
    const cached = attach.phase === "ready" ? (attach.cached ?? null) : null;

    this.#info = {
      kind: this.kind,
      label: cached ? `${this.options.label} - cached copy in this browser` : this.options.label,
      // The gateway that actually answered, not the one that was configured.
      // After a failover those differ, and the Data page must not claim a
      // source it is not reading.
      location: cached
        ? cachedLocationLabel(cached)
        : (this.#attach.attachedUrl() ?? this.options.urls[0] ?? ""),
      isSample: this.options.isSample,
      countyName: this.options.countyName,
      stateCode: this.options.stateCode,
      rowCount: Number(counts.rows[0]?.["n"] ?? 0),
      columnCount: schema.length,
      generatedAt: (meta?.rows[0]?.["as_of"] as string | null) ?? null,
      runId: (meta?.rows[0]?.["run_id"] as string | null) ?? null,
    };
    return this.#info;
  }

  async getSchema(): Promise<readonly ColumnDescriptor[]> {
    if (this.#schema) return this.#schema;
    const described = await this.#query(`DESCRIBE SELECT * FROM ${VIEW}`);
    this.#schema = described.rows.map((row) => {
      const name = String(row["column_name"] ?? "");
      return {
        name,
        type: String(row["column_type"] ?? "UNKNOWN"),
        meaning: COLUMN_MEANINGS[name] ?? null,
        isProvenance: PROVENANCE.has(name),
        isDerived: DERIVED.has(name) || name.startsWith("court_"),
      };
    });
    return this.#schema;
  }

  async search(query: PropertySearchQuery): Promise<PropertySearchResult> {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 5_000);
    const offset = Math.max(query.offset ?? 0, 0);
    const overlay = buildOverlay(query.overlay ?? EMPTY_OVERLAY);

    const built = buildSearch({
      criteria: query.criteria,
      limit,
      offset,
      orderBy: query.orderBy ?? "score",
      courtJoinAvailable: overlay.courtAvailable,
      propertyIds: query.propertyIds,
      viewport: query.viewport,
      prefix: overlay.prefix,
      from: overlay.from,
    });

    const [page, count] = await Promise.all([this.#query(built.sql), this.#query(built.countSql)]);

    const totalWeight = built.score.components.reduce(
      (sum, component) => sum + component.weight,
      0,
    );

    const rows: ScoredProperty[] = page.rows.map((row) => {
      const property = toRecord(row);
      const components = built.score.components.map((component) => {
        const value = Number(row[component.alias] ?? 0);
        return {
          key: component.key,
          label: component.rule,
          value,
          weight: component.weight,
          points: totalWeight
            ? Math.round(((component.weight * value) / totalWeight) * 1000) / 10
            : 0,
          matched: value > 0,
        };
      });
      return {
        property,
        score: Number(row[SCORE_ALIAS] ?? 0),
        components,
        rationale: rationaleFor(property, components, built.score.unranked),
        matchHash: matchHashOf(property),
      };
    });

    const total = Number(count.rows[0]?.[TOTAL_ALIAS] ?? rows.length);

    return {
      rows,
      total,
      sql: built.sql,
      tookMs: Math.round(page.elapsedMs + count.elapsedMs),
      truncated: total > offset + rows.length,
    };
  }

  async getProperty(propertyId: string, overlay?: Overlay): Promise<PropertyRecord | null> {
    // Restrict the overlay to this parcel: inlining every court row to read one
    // property would be wasted work on every detail view.
    const scoped =
      overlay && !isEmptyOverlay(overlay)
        ? {
            court: overlay.court.filter((entry) => entry.propertyId === propertyId),
            overrides: overlay.overrides.filter((entry) => entry.propertyId === propertyId),
          }
        : EMPTY_OVERLAY;
    const built = buildOverlay(scoped);

    const result = await this.#query(
      `${built.prefix}SELECT * FROM ${built.from} WHERE property_id = ${str(propertyId)} LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async lookup(term: string, limit = 25): Promise<readonly PropertyRecord[]> {
    const needle = str(`%${term.trim()}%`);
    const exact = str(term.trim());
    const result = await this.#query(
      `SELECT * FROM ${VIEW}
       WHERE property_id = ${exact}
          OR parcel_identifier = ${exact}
          OR address_street ILIKE ${needle}
          OR owner_name ILIKE ${needle}
       ORDER BY CASE WHEN property_id = ${exact} THEN 0 ELSE 1 END, address_street
       LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
    );
    return result.rows.map(toRecord);
  }

  async listRuns(limit = 25): Promise<readonly PipelineRun[]> {
    if (this.#runs) return this.#runs.slice(0, limit);
    if (!this.options.runHistoryUrl) return [];
    try {
      const response = await fetch(this.options.runHistoryUrl);
      if (!response.ok) return [];
      this.#runs = loadRunHistoryFrom(await response.json(), 100);
      return this.#runs.slice(0, limit);
    } catch {
      // A run history the tab cannot reach is a degraded panel, not a broken
      // CRM. The caller renders "history unavailable".
      return [];
    }
  }

  async runSql(sql: string, limit = 200): Promise<QueryResult> {
    const guard = guardSql(sql, limit);
    if (!guard.ok || !guard.sql) {
      throw new Error(guard.reason ?? "the statement was rejected by the read-only guard");
    }
    const guarded = guard.sql;
    const result = await this.#query(guarded);
    return {
      columns: result.columns,
      rows: result.rows as Readonly<Record<string, unknown>>[],
      rowCount: result.rows.length,
      truncated: result.rows.length >= limit,
      sql: guarded,
      tookMs: Math.round(result.elapsedMs),
    };
  }

  async close(): Promise<void> {
    await resetEngine();
  }
}
