import type { NextConfig } from "next";

/**
 * Two things here are load-bearing and both were learned the hard way in the
 * pipeline repository.
 *
 * 1. `@duckdb/node-api` is a native addon. It must stay external so the
 *    bindings binary is traced rather than bundled.
 *
 * 2. `@duckdb/node-bindings` resolves a per-platform package and requires its
 *    `duckdb.node`. That binary then dynamically links a shared library sitting
 *    next to it (`libduckdb.so` on Linux). Next traces the `.node` it can see in
 *    the require() call but not the `.so` the loader pulls in afterwards, so on
 *    Vercel the route dies at module load with "libduckdb.so: cannot open
 *    shared object file". The whole Linux platform package has to be traced,
 *    under both spellings, because pnpm installs it as a symlink into `.pnpm`.
 *
 * Unlike the pipeline UI, where only the agent route touched DuckDB, almost
 * every API route here reads the parcel data, so the trace is declared for the
 * whole `/api` tree rather than one route.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@duckdb/node-api"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./public/sample/**/*",
      "./node_modules/@duckdb/node-bindings-linux-x64/**/*",
      "./node_modules/.pnpm/@duckdb+node-bindings-linux-x64@*/node_modules/@duckdb/node-bindings-linux-x64/**/*",
    ],
  },
};

export default nextConfig;
