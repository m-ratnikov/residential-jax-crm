/**
 * Build the bundled sample from the published Duval query table.
 *
 * The sample is a real geographic slice of the county roll, not synthetic rows.
 * Arlington and the Southside were chosen because they are the areas the
 * assignment's own demo script names, they are dense enough that the map reads
 * as a real market, and every value in them is a genuine county record with its
 * provenance intact.
 *
 * It exists so that `git clone && pnpm install && pnpm dev` works with no
 * network and no credentials. It is not the deliverable dataset: the deployed
 * runtime reads the full county artifact over PROPERTY_DATA_URL, and the header
 * says which of the two is answering.
 *
 *   pnpm sample -- --source ../path/to/query-table.parquet \
 *                  --run-history ../path/to/run-history.json
 */

import { mkdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/** Arlington, Southside and the Beaches corridor. */
const SAMPLE_ZIPS = ["32211", "32277", "32225", "32246", "32216"];

const OUT_DIR = resolve(process.cwd(), "public", "sample");
const OUT_PARQUET = resolve(OUT_DIR, "query-table.parquet");
const OUT_RUNS = resolve(OUT_DIR, "run-history.json");

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function sqlPath(value: string): string {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  const source = arg("source");
  if (!source || !existsSync(source)) {
    console.error(
      "usage: pnpm sample -- --source <query-table.parquet> [--run-history <run-history.json>]",
    );
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const zipList = SAMPLE_ZIPS.map((zip) => `'${zip}'`).join(", ");
    const where = `address_zip IN (${zipList})`;

    const counted = await connection.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet(${sqlPath(source)}) WHERE ${where}`,
    );
    const rows = Number((await counted.getRowObjects())[0]?.["n"] ?? 0);
    if (!rows) throw new Error(`no rows matched ${where} in ${source}`);

    await connection.run(
      `COPY (SELECT * FROM read_parquet(${sqlPath(source)}) WHERE ${where})
       TO ${sqlPath(OUT_PARQUET)} (FORMAT parquet, COMPRESSION zstd)`,
    );

    console.log(
      `wrote ${OUT_PARQUET}: ${rows.toLocaleString("en-US")} parcels from ${SAMPLE_ZIPS.join(", ")}`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  const runHistory = arg("run-history");
  if (runHistory && existsSync(runHistory)) {
    mkdirSync(dirname(OUT_RUNS), { recursive: true });
    copyFileSync(runHistory, OUT_RUNS);
    console.log(`wrote ${OUT_RUNS}`);
  } else {
    writeFileSync(OUT_RUNS, JSON.stringify({ county: "duval", runs: [] }, null, 2));
    console.log(`wrote ${OUT_RUNS} (empty; pass --run-history to copy the real one)`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
