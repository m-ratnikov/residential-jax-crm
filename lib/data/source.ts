/**
 * The one place the application asks for a property data source.
 *
 * Everything else imports `getPropertyDataSource()` and talks to the interface.
 * Which implementation answers is decided here, from configuration, and can be
 * overridden in tests with `setPropertyDataSource`.
 *
 * The instance is cached per process and per resolved source, so a warm Vercel
 * invocation reuses the open DuckDB instance and its httpfs extension, and a
 * changed URL in development is picked up without a restart.
 */

import { createDuckDbSource, DuckDbPropertyDataSource } from "./duckdb";
import { dataConfig } from "./config";
import type { PropertyDataSource } from "./types";

export interface PropertyDataSourceHandle {
  source: PropertyDataSource;
  /** True when court-derived predicates can be evaluated. */
  courtDataAvailable: boolean;
}

interface Cache {
  key: string;
  handle: PropertyDataSourceHandle;
}

const globalCache = globalThis as unknown as {
  __jaxCrmDataSource?: Cache;
  __jaxCrmDataSourceOverride?: PropertyDataSourceHandle;
};

function cacheKey(): string {
  const cfg = dataConfig();
  return `${cfg.queryTableSource}::${cfg.courtSource ?? ""}::${cfg.runHistoryUrl ?? ""}`;
}

/**
 * Replace the data source, for tests and for the in-memory fallback. Passing
 * null restores configuration-driven resolution.
 */
export function setPropertyDataSource(handle: PropertyDataSourceHandle | null): void {
  if (handle) globalCache.__jaxCrmDataSourceOverride = handle;
  else delete globalCache.__jaxCrmDataSourceOverride;
}

export function getPropertyDataSource(): PropertyDataSourceHandle {
  const override = globalCache.__jaxCrmDataSourceOverride;
  if (override) return override;

  const key = cacheKey();
  const cached = globalCache.__jaxCrmDataSource;
  if (cached && cached.key === key) return cached.handle;

  const source: DuckDbPropertyDataSource = createDuckDbSource();
  const handle: PropertyDataSourceHandle = {
    source,
    courtDataAvailable: source.courtDataAvailable,
  };
  globalCache.__jaxCrmDataSource = { key, handle };
  return handle;
}

export type { PropertyDataSource } from "./types";
