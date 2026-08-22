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

import { runQuery, ensureLoaded, getState, resetEngine } from "@/lib/oracle/duckdb";
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
  ColumnDescriptor,
  DataSourceInfo,
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
 * gateway, move to the next one, say so - and that behaviour has to be provable
 * without a WASM engine, a network, or a two minute wait. So the network and the
 * engine arrive as four functions, and a test supplies four that hang on demand.
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
 * Attach the published artifact, trying each gateway in turn.
 *
 * Three things this owns that nothing else did:
 *
 * 1. **A bound.** Every gateway gets a probe deadline and an attach deadline.
 *    Nothing waits forever, which is what produced the two minute blank screen.
 * 2. **Failover.** A CID is the same object whichever gateway serves it, so the
 *    fallback is a URL rewrite rather than a second copy of the data, and the
 *    UI says which one answered.
 * 3. **A state a caller can render honestly.** `attaching` carries elapsed time
 *    and progress; `failed` carries what was tried so the retry can name it.
 */
export class GatewayAttach {
  readonly #options: AttachOptions;

  #startedAt: number | null = null;
  #index = 0;
  #failedOver = false;
  #outcome: AttachReady | AttachFailed | null = null;
  #attachedUrl: string | null = null;
  #run: Promise<void> | null = null;

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
      message: progress?.message ?? "Attaching the published query table",
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
    this.#startedAt = null;
    return this.start();
  }

  async #attach(): Promise<void> {
    const { candidates, deps, attachTimeoutMs, probeTimeoutMs } = this.#options;
    this.#startedAt = deps.now();

    const tried: string[] = [];
    let lastError = "no gateway was configured";

    for (let index = 0; index < candidates.length; index += 1) {
      const url = candidates[index];
      if (!url) continue;

      this.#index = index;
      this.#failedOver = index > 0;
      tried.push(url);

      try {
        // The probe is the cheap half. A gateway that will not return one byte
        // in eight seconds is not going to range read 49.5 MB, and finding that
        // out costs one request rather than the whole attach deadline.
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
          failedOver: index > 0,
          elapsedMs: Math.max(0, deps.now() - (this.#startedAt ?? deps.now())),
          accessMode: deps.progress(url)?.accessMode ?? null,
        };
        return;
      } catch (cause: unknown) {
        lastError = messageOf(cause);
        // A half attached engine would answer the next gateway's queries from
        // the previous one's file handle, so it is torn down before moving on.
        await deps.reset().catch(() => undefined);
      }
    }

    this.#outcome = {
      phase: "failed",
      error: lastError,
      tried,
      elapsedMs: Math.max(0, deps.now() - (this.#startedAt ?? deps.now())),
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

/** The real deps: a liveness check on the gateway, and the vendored WASM engine. */
export function browserAttachDeps(): AttachDeps {
  return {
    async probe(url, signal) {
      // HEAD rather than a ranged GET. `Range` is not a CORS-safelisted request
      // header, so a ranged probe adds a preflight this check does not need -
      // and the vendored engine already issues a HEAD against this exact URL
      // before it loads, so it is a request path known to work.
      const response = await fetch(url, { method: "HEAD", signal });
      if (!gatewayIsAlive(response.status)) {
        throw new Error(`${hostOf(url)} answered ${response.status} ${response.statusText}`);
      }
    },
    load: (url) => ensureLoaded(url),
    reset: () => resetEngine(),
    progress: (url) => engineProgressFor(getState(), url),
    now: () => Date.now(),
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
      deps: options.deps ?? browserAttachDeps(),
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

    this.#info = {
      kind: this.kind,
      label: this.options.label,
      // The gateway that actually answered, not the one that was configured.
      // After a failover those differ, and the Data page must not claim a
      // source it is not reading.
      location: this.#attach.attachedUrl() ?? this.options.urls[0] ?? "",
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
