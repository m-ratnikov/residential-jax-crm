import type { NextConfig } from "next";

/**
 * `@duckdb/node-api` is a native addon, and getting it onto a serverless
 * function correctly took two lessons, both learned the hard way.
 *
 * 1. It has to stay external, so the bindings binary is traced rather than
 *    bundled.
 *
 * 2. `@duckdb/node-bindings` resolves a per-platform package and requires its
 *    `duckdb.node`. That binary then dynamically links a shared library sitting
 *    next to it (`libduckdb.so` on Linux). Next traces the `.node` it can see in
 *    the require() call but not the `.so` the loader pulls in afterwards, so the
 *    route dies at module load with "libduckdb.so: cannot open shared object
 *    file". The whole Linux platform package has to be traced, under both
 *    spellings, because pnpm installs it as a symlink into `.pnpm`.
 *
 * The trace is declared per route rather than across the whole `/api` tree.
 * DuckDB's bindings are tens of megabytes; attaching them to every function -
 * including the ones that only touch Postgres - inflated the deployment past
 * what the platform would accept. Only the routes that actually read parcel
 * data carry them.
 *
 * The bundled sample parquet is deliberately NOT traced. When no artifact URL
 * is configured, a serverless deployment reads the sample over HTTP from its own
 * static output instead (see lib/data/config.ts), which keeps a 9 MB file out of
 * every function for a fallback path that a configured deployment never takes.
 */

const DUCKDB_BINDINGS = [
  "./node_modules/@duckdb/node-bindings-linux-x64/**/*",
  "./node_modules/.pnpm/@duckdb+node-bindings-linux-x64@*/node_modules/@duckdb/node-bindings-linux-x64/**/*",
];

/** Every route that opens a DuckDB connection over the parcel data. */
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
  serverExternalPackages: ["@duckdb/node-api"],
  outputFileTracingIncludes: Object.fromEntries(
    PARCEL_ROUTES.map((route) => [route, DUCKDB_BINDINGS]),
  ),
};

export default nextConfig;
