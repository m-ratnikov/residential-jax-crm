"use client";

/**
 * What a page needs to know about this deployment, from the two places that
 * actually know it.
 *
 * The split is the whole architecture in miniature. The **tab** owns the parcel
 * dataset: it holds the query engine and the attached parquet, so it is the
 * only thing that can truthfully say how many rows are loaded and which
 * pipeline run produced them. The **server** owns the CRM store, the overlay
 * and the published run history, because those need a credential or a write.
 *
 * These were previously declared three times, in three components, as one
 * server payload carrying both halves. That was true until the query engine
 * moved into the browser, and then quietly stopped being: the server kept
 * answering, the `dataSource` half of its answer disappeared, and the pages
 * read through it. One hook per source of truth, declared once, so the next
 * move of that boundary is a compile error rather than a blank dashboard.
 */

import { useCallback, useEffect, useState } from "react";

import { propertySource } from "./client-source";
import type { DataSourceInfo } from "./types";

/** The CRM store as the UI cares about it: can it write, and does it forget. */
export interface StoreStatus {
  kind: string;
  location: string;
  writable: boolean;
  ephemeral: boolean;
  /** Serving a cached copy because the upstream refused a read. */
  degraded?: boolean;
}

export interface ServerStatus {
  crmStore: StoreStatus;
  overlay: {
    courtDataAvailable: boolean;
    courtProperties: number;
    simulatedProperties: number;
    simulatedRunIds: string[];
  };
  pipeline: {
    runId: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    tracks: string[];
    limitations: string[];
  } | null;
  county: { name: string; state: string };
}

/**
 * Returns the status and a way to ask for it again.
 *
 * The reload matters on the pipeline page: simulating or clearing a pipeline
 * update changes the overlay counts this endpoint reports, and a panel that
 * kept showing the pre-simulation numbers would make the demo look broken.
 */
export function useServerStatus(): [ServerStatus | null, () => void] {
  const [status, setStatus] = useState<ServerStatus | null>(null);

  const reload = useCallback(() => {
    fetch("/api/datasource")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ServerStatus | null) => {
        if (body) setStatus(body);
      })
      .catch(() => undefined);
  }, []);

  useEffect(reload, [reload]);

  return [status, reload];
}

/**
 * The loaded dataset, resolved once the parquet has attached in this tab.
 *
 * Null while it is attaching, which is a real state and not an error: the first
 * query against a 50 MB artifact over a public gateway takes a moment, and a
 * page that claims a row count before then would be making it up.
 */
export function useDataset(): DataSourceInfo | null {
  const [info, setInfo] = useState<DataSourceInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void propertySource()
      .info()
      .then((loaded) => {
        if (!cancelled) setInfo(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}

/** One sentence about the store, for a banner. Null when there is nothing to say. */
export function storeWarning(store: StoreStatus | undefined): string | null {
  if (!store) return null;
  if (store.degraded) {
    return "The CRM store is being rate limited upstream, so this is the last state it read rather than the current one. Reads recover on their own within the hour; writes will fail until then.";
  }
  if (!store.writable) {
    return `The CRM store (${store.location}) is attached read only, so saved criteria, alerts and opportunities can be read but not changed. Set CRM_STORE_TOKEN to make it writable.`;
  }
  if (store.ephemeral) {
    return "This deployment is running on an in-process store, so saved criteria, alerts and opportunities are lost when it restarts. Set CRM_STORE_REPO and CRM_STORE_TOKEN to keep them.";
  }
  return null;
}
