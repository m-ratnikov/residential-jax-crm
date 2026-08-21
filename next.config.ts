import type { NextConfig } from "next";

/**
 * Getting a DuckDB onto a serverless function took four failed deploys, and the
 * conclusions are worth keeping because none of them announced themselves.
 *
 * 1. **The native addon cannot ship here.** `@duckdb/node-api` links
 *    `libduckdb.so`, which is 70.5 MB. A function package carrying it is
 *    rejected at upload with an empty error message. Verified by deploying it
 *    alone in a single route, and again by tracing only the two binary files
 *    rather than the whole package - the shared library IS the 70 MB.
 *
 * 2. **WASM ships.** The Node build of `@duckdb/duckdb-wasm` is about 38 MB
 *    across three files and deploys cleanly. Only the exception-handling build
 *    is traced; the MVP fallback is another 41 MB and Node always supports
 *    exceptions, so shipping it would double the payload for a path never
 *    taken. lib/data/engine.ts picks the engine by what actually loads.
 *
 * 3. **pnpm's default symlinked node_modules breaks packaging.** Any function
 *    tracing a binary asset fails with "the framework produced an invalid
 *    deployment package ... files in symlinked directories". Fixed with
 *    `nodeLinker: hoisted` in pnpm-workspace.yaml.
 *
 * 4. **Nothing on a traced path may call existsSync or path.resolve on a value
 *    the bundler cannot see statically.** Next responds by tracing the ENTIRE
 *    project - node_modules and public/ included - into every function, and the
 *    upload is then rejected. See lib/data/config.ts, which resolves paths
 *    without touching the filesystem for exactly this reason.
 */

const DUCKDB_WASM = [
  "./node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs",
  "./node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs",
  "./node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm",
];

/** Every route that opens a query engine over the parcel data. */
const PARCEL_ROUTES = [
  "/api/datasource",
  "/api/search",
  "/api/property/[id]",
  "/api/export",
  "/api/agent",
  "/api/matcher/run",
  "/api/simulate",
  "/api/runs",
  "/api/searches/[id]/run",
  "/api/opportunities",
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Native DuckDB stays external so its dynamic import can fail cleanly at
  // runtime rather than being bundled; the engine then falls back to WASM.
  serverExternalPackages: ["@duckdb/node-api"],
  outputFileTracingIncludes: Object.fromEntries(PARCEL_ROUTES.map((route) => [route, DUCKDB_WASM])),
  outputFileTracingExcludes: {
    "**": [
      // The sample path is a constant, so the tracer folds it and packs the
      // 9 MB parquet into every function that imports the data config - for a
      // fallback a deployed instance never takes, because it reads the sample
      // over HTTP from its own static output. It is still deployed as a static
      // asset.
      "./public/sample/**",
      // Sourcemaps for the WASM build are around 15 MB and are never read at
      // runtime.
      "./node_modules/@duckdb/duckdb-wasm/dist/**/*.map",
    ],
  },
};

export default nextConfig;
