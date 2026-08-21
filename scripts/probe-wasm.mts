/**
 * Does DuckDB-WASM, in Node, range read a remote parquet and answer the same
 * SQL the native engine answers?
 *
 * Throwaway probe. Run before committing to the engine swap:
 *   npx tsx scripts/probe-wasm.mts <parquet url or path>
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const target = process.argv[2] ?? "public/sample/query-table.parquet";
  const isHttp = /^https?:\/\//i.test(target);

  const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const DUCKDB_DIST = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const distDir = resolve(DUCKDB_DIST, "..");

  // The bundle map is keyed by wasm feature set: mvp, then eh (exception
  // handling). createDuckDB picks eh when the runtime supports it.
  const bundle = {
    mvp: {
      mainModule: resolve(distDir, "duckdb-mvp.wasm"),
      mainWorker: resolve(distDir, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
      mainModule: resolve(distDir, "duckdb-eh.wasm"),
      mainWorker: resolve(distDir, "duckdb-node-eh.worker.cjs"),
    },
  };

  console.log("wasm:", bundle.eh.mainModule);

  const logger = new duckdb.VoidLogger();
  const db = await duckdb.createDuckDB(bundle, logger, duckdb.NODE_RUNTIME);
  await db.instantiate(() => {});

  const connection = db.connect();

  const started = Date.now();
  const source = isHttp ? target : pathToFileURL(resolve(target)).pathname;

  if (isHttp) {
    // duckdb-wasm does not take a bare URL in read_parquet: the file has to be
    // registered with its virtual filesystem first, which is also what makes it
    // range read rather than download the whole object.
    await db.registerFileURL("remote.parquet", target, duckdb.DuckDBDataProtocol.HTTP, false);
  } else {
    // A local file has to be registered with the virtual filesystem.
    const { readFileSync } = await import("node:fs");
    db.registerFileBuffer("local.parquet", new Uint8Array(readFileSync(resolve(target))));
  }

  const path = isHttp ? "remote.parquet" : "local.parquet";
  connection.query(`CREATE OR REPLACE VIEW properties AS SELECT * FROM read_parquet('${path}')`);

  const count = connection.query(`SELECT count(*) AS n FROM properties`);
  console.log("rows:", count.toArray()[0]?.n, `${Date.now() - started} ms`);

  const scored = connection.query(`
    SELECT property_id, address_street, years_since_last_sale, roof_age_years,
           round(100.0 * (3 * CASE WHEN years_since_last_sale >= 10 THEN 1 ELSE 0 END
                        + 3 * CASE WHEN roof_age_years >= 15 THEN 1 ELSE 0 END) / 6.0, 1) AS match_score
    FROM properties
    WHERE property_type = 'RESIDENTIAL' AND years_since_last_sale >= 10 AND roof_age_years >= 15
    ORDER BY match_score DESC, years_since_last_sale DESC
    LIMIT 3
  `);
  for (const row of scored.toArray()) {
    console.log(" -", row.address_street, "| held", row.years_since_last_sale, "| roof", row.roof_age_years);
  }

  connection.close();
  await db.terminate?.();
  console.log("ok");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
