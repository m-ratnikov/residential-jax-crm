import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    // The same "@/..." alias the Next build uses, so a test imports a module by
    // the path the application imports it by.
    alias: { "@": resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The data source tests open DuckDB over a 9 MB parquet; the default 5 s
    // is tight on a cold CI runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
