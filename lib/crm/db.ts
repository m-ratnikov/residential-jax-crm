/**
 * The CRM database handle.
 *
 * Neon over HTTP rather than a pooled TCP connection, because the runtime is
 * serverless: every request is a fresh isolate, a connection pool would be a
 * pool of one, and Neon's HTTP driver avoids the cold-start handshake entirely.
 *
 * `DATABASE_URL` absent is a supported state, not a crash. The property side of
 * this application - map, search, criteria, agent - needs no database at all,
 * so an unconfigured deployment still demonstrates everything the pipeline
 * feeds, and the CRM surfaces say plainly that no store is attached rather than
 * throwing a 500 into the user's face.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

export type CrmDatabase = ReturnType<typeof drizzle<typeof schema>>;

const globalCache = globalThis as unknown as { __jaxCrmDb?: CrmDatabase };

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim();
  return url && url.length > 0 ? url : null;
}

export function hasDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return databaseUrl(env) !== null;
}

/** The handle, or null when no store is configured. */
export function tryDb(): CrmDatabase | null {
  if (globalCache.__jaxCrmDb) return globalCache.__jaxCrmDb;
  const url = databaseUrl();
  if (!url) return null;
  const client = neon(url);
  const database = drizzle(client, { schema });
  globalCache.__jaxCrmDb = database;
  return database;
}

export class CrmStoreNotConfiguredError extends Error {
  readonly code = "crm_store_not_configured";
  constructor() {
    super(
      "No CRM store is attached. Set DATABASE_URL to a Postgres connection string and run `pnpm db:migrate`. Search, the map and the agent work without one.",
    );
    this.name = "CrmStoreNotConfiguredError";
  }
}

/** The handle, throwing a typed error the API routes turn into a 503. */
export function db(): CrmDatabase {
  const database = tryDb();
  if (!database) throw new CrmStoreNotConfiguredError();
  return database;
}

export { schema };
