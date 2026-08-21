/**
 * The query engine behind the DuckDB data source, and why there are two.
 *
 * **Native** (`@duckdb/node-api`) is the better engine: it range reads a remote
 * parquet, so a 50 MB artifact costs a few hundred kilobytes of transfer per
 * query and nothing is held in memory. It is what local development and the
 * scheduled matcher use.
 *
 * It cannot be deployed to this runtime. The addon links `libduckdb.so`, which
 * is 70.5 MB, and a serverless function package carrying it is rejected at
 * upload with no message - verified by deploying it alone in a single route.
 * Tracing only the two binary files rather than the package makes no difference,
 * because the shared library is the whole 70 MB.
 *
 * **WASM** (`@duckdb/duckdb-wasm`, node build) is 36 MB and deploys. The cost is
 * that its Node runtime does not implement the HTTP protocol - `registerFileURL`
 * answers "Unsupported data protocol" - so a remote artifact has to be fetched
 * whole rather than range read. It is fetched once per instance into the
 * function's temp directory and reused from there, so the price is paid on a
 * cold start and not per query.
 *
 * Which one runs is decided by what is loadable, not by a flag, so a clone with
 * the native addon available gets the better engine without configuring
 * anything. PROPERTY_ENGINE forces the choice when that matters.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { logEvent } from "@/lib/notify/log";

export type EngineKind = "native" | "wasm";

export interface QueryEngine {
  readonly kind: EngineKind;
  /** Run one statement and return plain JSON-safe rows. */
  query(sql: string): Promise<{ columns: string[]; rows: Record<string, Plain>[]; tookMs: number }>;
  close(): Promise<void>;
}

export type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

/** DuckDB values to JSON safe values, keeping numbers numeric where they fit. */
export function toPlain(value: unknown): Plain {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const maybe = value as { toString?: () => string; items?: unknown };
    if (maybe.items && Array.isArray(maybe.items)) return maybe.items.map((item) => toPlain(item));
    if (typeof maybe.toString === "function" && maybe.toString !== Object.prototype.toString) {
      return maybe.toString();
    }
    const out: Record<string, Plain> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(item);
    }
    return out;
  }
  return String(value);
}

export function sqlPath(value: string): string {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "''")}'`;
}

const isHttp = (value: string) => /^https?:\/\//i.test(value);

/* ------------------------------------------------------------------ */
/* Native                                                               */
/* ------------------------------------------------------------------ */

/**
 * Retry a query that the gateway refused for load.
 *
 * A public IPFS gateway rate limits, and native DuckDB range reads a 50 MB
 * parquet in many small requests, so a query can meet a 429 partway through.
 * Observed for real while seeding: the artifact was reachable, then answered
 * "429 Too Many Requests" once enough range reads had gone through.
 *
 * A scheduled pass that fails on a transient 429 would show as a red run and
 * raise no alerts, which is worse than waiting a few seconds. Backoff is
 * exponential and short; anything that is not a rate limit is rethrown at once,
 * because retrying a genuine error just delays the report.
 */
async function withGatewayRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1_000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /429|too many requests|rate limit/i.test(message);
      if (!rateLimited || attempt >= attempts) throw error;

      logEvent("engine.gateway_backoff", { attempt, delayMs: delay });
      await new Promise((wake) => setTimeout(wake, delay));
      delay *= 2;
    }
  }
}

async function openNative(source: string, viewSql: (path: string) => string): Promise<QueryEngine> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");

  const setup = await instance.connect();
  try {
    if (isHttp(source)) {
      // A serverless filesystem is read only except the temp directory, and
      // httpfs has to be fetched once per cold start.
      await setup.run(
        `SET extension_directory = ${sqlPath(resolve(tmpdir(), "duckdb-extensions"))}`,
      );
      await setup.run("INSTALL httpfs");
      await setup.run("LOAD httpfs");
    }
    await setup.run(viewSql(source));
  } finally {
    setup.closeSync();
  }

  return {
    kind: "native",
    async query(sql: string) {
      const started = Date.now();
      const result = await withGatewayRetry(async () => {
        const connection = await instance.connect();
        try {
          const answered = await connection.runAndReadAll(sql);
          const columns = answered.columnNames();
          const rows = (await answered.getRowObjects()).map((row) => {
            const out: Record<string, Plain> = {};
            for (const column of columns) out[column] = toPlain(row[column]);
            return out;
          });
          return { columns, rows };
        } finally {
          connection.closeSync();
        }
      });
      return { ...result, tookMs: Date.now() - started };
    },
    async close() {
      instance.closeSync();
    },
  };
}

/* ------------------------------------------------------------------ */
/* WASM                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fetch a remote artifact once per instance and keep it in the temp directory.
 *
 * The WASM runtime cannot range read over HTTP, so the whole object is needed.
 * Caching it means the cost lands on the first request an instance serves
 * rather than on every query, and a warm instance never pays it again.
 */
async function materialise(source: string): Promise<string> {
  if (!isHttp(source)) return resolve(source);

  const dir = join(tmpdir(), "duval-parcels");
  const name = `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.parquet`;
  const path = join(dir, name);

  try {
    const existing = statSync(path);
    if (existing.size > 0) return path;
  } catch {
    // Not cached yet.
  }

  const started = Date.now();
  const response = await fetch(source);
  if (!response.ok)
    throw new Error(`could not fetch the artifact: ${response.status} from ${source}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, bytes);

  logEvent("engine.artifact_cached", {
    source,
    bytes: bytes.byteLength,
    ms: Date.now() - started,
  });

  return path;
}

interface WasmBindings {
  registerFileBuffer(name: string, buffer: Uint8Array): void;
  connect(): {
    query(sql: string): {
      toArray(): Record<string, unknown>[];
      schema: { fields: { name: string }[] };
    };
    close(): void;
  };
  terminate?(): Promise<void>;
}

async function openWasm(source: string, viewSql: (path: string) => string): Promise<QueryEngine> {
  const require = createRequire(import.meta.url);

  // Required by specifier, not by a computed path: a computed require is a
  // build error under webpack ("module not found"), and the package is listed
  // in serverExternalPackages so this survives to runtime untouched.
  const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
  const duckdb = require(entry) as any;

  // require.resolve is rewritten inside a Next build to return a numeric module
  // id, and handing that to path.resolve fails with `"paths[0]" argument must
  // be of type string`. Use it when it really is a path, and otherwise join
  // from the working directory - the traced files land under the function root
  // with their node_modules layout intact.
  const resolved: unknown = require.resolve(entry);
  const distDir =
    typeof resolved === "string"
      ? resolve(resolved, "..")
      : join(process.cwd(), "node_modules", "@duckdb", "duckdb-wasm", "dist");

  // The bundle map is keyed by wasm feature set. createDuckDB takes the
  // exception-handling build when the runtime supports it, which Node does.
  const bundles = {
    mvp: {
      mainModule: resolve(distDir, "duckdb-mvp.wasm"),
      mainWorker: resolve(distDir, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
      mainModule: resolve(distDir, "duckdb-eh.wasm"),
      mainWorker: resolve(distDir, "duckdb-node-eh.worker.cjs"),
    },
  };

  const db = (await duckdb.createDuckDB(
    bundles,
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  )) as WasmBindings & { instantiate(progress: () => void): Promise<void> };
  await db.instantiate(() => {});

  const local = await materialise(source);
  const registered = "parcels.parquet";
  db.registerFileBuffer(registered, new Uint8Array(readFileSync(local)));

  const connection = db.connect();
  connection.query(viewSql(registered));

  return {
    kind: "wasm",
    async query(sql: string) {
      const started = Date.now();
      const result = connection.query(sql);
      const columns = result.schema.fields.map((field) => field.name);
      const rows = result.toArray().map((row) => {
        const out: Record<string, Plain> = {};
        for (const column of columns) out[column] = toPlain(row[column]);
        return out;
      });
      return { columns, rows, tookMs: Date.now() - started };
    },
    async close() {
      connection.close();
      await db.terminate?.();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Selection                                                            */
/* ------------------------------------------------------------------ */

export function preferredEngine(env: NodeJS.ProcessEnv = process.env): EngineKind | null {
  const forced = env.PROPERTY_ENGINE?.trim().toLowerCase();
  if (forced === "native" || forced === "wasm") return forced;
  return null;
}

/**
 * Open the best engine available.
 *
 * Native is tried first because it range reads. If its addon is not loadable -
 * which is the case on a serverless deployment, where the 70 MB shared library
 * cannot be shipped - the WASM engine takes over and the failure is logged
 * rather than swallowed.
 */
export async function openEngine(
  source: string,
  viewSql: (path: string) => string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueryEngine> {
  const forced = preferredEngine(env);

  if (forced !== "wasm") {
    try {
      const engine = await openNative(source, viewSql);
      logEvent("engine.opened", { kind: "native", source });
      return engine;
    } catch (error: unknown) {
      if (forced === "native") throw error;
      logEvent("engine.native_unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const engine = await openWasm(source, viewSql);
  logEvent("engine.opened", { kind: "wasm", source });
  return engine;
}
