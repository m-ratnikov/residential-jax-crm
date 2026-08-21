/**
 * Apply the committed migrations.
 *
 *   DATABASE_URL=postgres://... pnpm db:migrate
 *
 * Uses the same Neon HTTP driver the application uses, so a connection string
 * that works here works at runtime. Safe to re-run: drizzle records what it has
 * applied in its own table.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

function loadEnvFile(): void {
  // A .env.local is the ordinary place to keep this in development, and Next
  // loads it automatically at runtime but a plain script does not.
  for (const name of [".env.local", ".env"]) {
    try {
      const contents = readFileSync(resolve(process.cwd(), name), "utf8");
      for (const line of contents.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (!key || process.env[key]) continue;
        process.env[key] = (rawValue ?? "").replace(/^["']|["']$/g, "");
      }
    } catch {
      // Absent is fine.
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      "DATABASE_URL is not set. Create a free Postgres database (Neon works and needs no card),\n" +
        "then either export DATABASE_URL or put it in .env.local.",
    );
    process.exit(2);
  }

  const database = drizzle(neon(url));
  await migrate(database, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  console.log("migrations applied");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
