import type { NextConfig } from "next";

/**
 * There is no query engine on the server any more, and that is the point.
 *
 * Parcel queries run in the visitor's tab with DuckDB-WASM, range reading the
 * published parquet straight off the IPFS gateway. That is the pattern the
 * assignment names - "the existing Duval pipeline + DuckDB / Elephant IPFS
 * pattern" - and it is what the pipeline UI already does at 404,023 parcels.
 *
 * It also settles a fight with the platform that four deploys could not win.
 * The native addon links `libduckdb.so` at 70.5 MB and a function package
 * carrying it is rejected at upload with an empty error message, verified with
 * the bindings traced into a single route. The WASM build deploys but its Node
 * runtime cannot fetch the `parquet` extension, because that runtime has no
 * HTTP implementation. In a browser both problems disappear: the wasm is a
 * static asset and the extension loads over the network like anything else.
 *
 * Two things still have to hold in the server bundles, both learned the hard
 * way:
 *
 * 1. Nothing on a traced path may call existsSync or path.resolve on a value
 *    the bundler cannot see statically. Next responds by tracing the ENTIRE
 *    project - node_modules and public/ included - into every function, and the
 *    upload is then rejected. See lib/data/config.ts.
 * 2. The bundled sample parquet must stay out of the function bundles. Its path
 *    is a constant, so the tracer folds it and packs 9 MB into every function
 *    that imports the data config.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingExcludes: {
    "**": ["./public/sample/**", "./public/duckdb/**"],
  },
  async headers() {
    return [
      {
        // The wasm and its worker are immutable per release; let the browser
        // keep them rather than refetching 34 MB on every visit.
        source: "/duckdb/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
