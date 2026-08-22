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
import { publicDataConfig } from "./public-config";
import { parseRunHistory } from "./runs-parse";
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
    fetch("/api/datasource", { cache: "no-store" })
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

/**
 * The published run-history document, as the artifact itself describes it.
 *
 * `url` and `isSample` are known before anything is fetched, because they come
 * from the build-time configuration; `publishedCount` and `generatedAt` arrive
 * once the document has been read. `reachable` is false while it is loading and
 * stays false if no gateway answers, so a caller can tell "not yet" and "not
 * ever" apart from a count that happens to be zero.
 */
export interface RunHistorySource {
  url: string;
  /** True when the bundled 8-run sample is what is being read. */
  isSample: boolean;
  /** How many runs the published document holds, before any display cap. */
  publishedCount: number | null;
  generatedAt: string | null;
  reachable: boolean;
}

/**
 * Read the published run history in the tab, for its totals.
 *
 * `/api/runs` answers with a capped page of runs and nothing about the document
 * they came from, so a page built only on it can report its own page size and
 * believe it is reporting the pipeline's history - which is exactly what
 * "PIPELINE RUNS SEEN 25" was, against a document holding 40. The artifact is a
 * small public JSON on the same gateway the tab already range reads the parquet
 * from, so the honest number is one fetch away and needs no server round trip.
 *
 * Failure is a missing total, not an error: the page falls back to describing
 * what it listed.
 */
export function useRunHistorySource(): RunHistorySource {
  const [source, setSource] = useState<RunHistorySource>({
    url: publicDataConfig.runHistoryUrl,
    isSample: publicDataConfig.runHistoryIsSample,
    publishedCount: null,
    generatedAt: null,
    reachable: false,
  });

  useEffect(() => {
    let cancelled = false;

    const read = async (): Promise<void> => {
      for (const candidate of publicDataConfig.runHistoryUrls) {
        try {
          const response = await fetch(candidate, {
            cache: "no-store",
            signal: AbortSignal.timeout(publicDataConfig.probeTimeoutMs),
          });
          if (!response.ok) continue;
          // One run is enough: the totals come off the envelope, and parsing
          // forty runs to display a number would be work for nothing.
          const document = parseRunHistory(await response.json(), 1);
          if (cancelled) return;
          setSource((current) => ({
            ...current,
            url: candidate,
            publishedCount: document.publishedCount,
            generatedAt: document.generatedAt,
            reachable: true,
          }));
          return;
        } catch {
          // Try the next gateway. A history this tab cannot read is a page
          // without a total, not a broken page.
        }
      }
    };

    void read();
    return () => {
      cancelled = true;
    };
  }, []);

  return source;
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
