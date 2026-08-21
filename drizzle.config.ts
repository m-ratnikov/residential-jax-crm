import type { Config } from "drizzle-kit";

/**
 * Migrations are generated from lib/crm/schema.ts and committed. Applying them
 * needs a connection string; generating them does not, so `pnpm db:generate`
 * works on a clone with no database attached.
 */
export default {
  schema: "./lib/crm/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://unset" },
  strict: true,
  verbose: true,
} satisfies Config;
