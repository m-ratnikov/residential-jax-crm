/**
 * Choosing the CRM store.
 *
 * In order: the git document store when a repository is configured, Postgres
 * when a connection string is, and an in-process store otherwise. The order is
 * deliberate - the zero-infrastructure backend is the default, and the database
 * is the opt-in, which is the way round the story's cost criterion asks for.
 *
 * There is no "not configured" failure any more. A fresh clone gets a working
 * CRM immediately on the memory store; it simply does not survive a restart,
 * and the app says so rather than leaving it to be discovered.
 */

import type { CrmStore } from "./store";
import { githubStoreFromEnv } from "./store-github";
import { memoryStore } from "./store-memory";
import { postgresStoreFromEnv } from "./store-postgres";

export type { CrmStore } from "./store";
export { CrmStoreNotWritableError } from "./store";

const globalCache = globalThis as unknown as { __jaxCrmStore?: CrmStore };

export function crmStore(env: NodeJS.ProcessEnv = process.env): CrmStore {
  if (globalCache.__jaxCrmStore) return globalCache.__jaxCrmStore;
  const store = githubStoreFromEnv(env) ?? postgresStoreFromEnv(env) ?? memoryStore();
  globalCache.__jaxCrmStore = store;
  return store;
}

/** Replace the store, for tests. Passing null restores selection from the environment. */
export function setCrmStore(store: CrmStore | null): void {
  if (store) globalCache.__jaxCrmStore = store;
  else delete globalCache.__jaxCrmStore;
}

export interface StoreStatus {
  kind: string;
  location: string;
  writable: boolean;
  /** True when state is lost on restart, which the UI says out loud. */
  ephemeral: boolean;
  /**
   * True when the store is serving a cached copy because the upstream refused a
   * read - GitHub counts its 5,000 requests an hour per user, so every token
   * this account owns shares one budget. Surfaced so the UI can say it is
   * showing state a few minutes old instead of implying it is current.
   */
  degraded?: boolean;
}

export function storeStatus(env: NodeJS.ProcessEnv = process.env): StoreStatus {
  const store = crmStore(env);
  return {
    kind: store.kind,
    location: store.location,
    writable: store.writable,
    ephemeral: store.kind === "memory",
    degraded: "degraded" in store ? Boolean((store as { degraded?: boolean }).degraded) : false,
  };
}
