"use client";

/**
 * One data source per tab, and the overlay it needs.
 *
 * The engine underneath is a module-level singleton (it holds a WASM instance
 * and an attached parquet), so this hands out one `BrowserPropertyDataSource`
 * for the whole session rather than constructing one per component.
 *
 * The overlay - court filings and simulated pipeline updates - lives in
 * Postgres, so it is fetched once and passed into each query. It is small by
 * construction: court-flagged parcels and hand-made simulations, not the county.
 */

import { BrowserPropertyDataSource } from "./browser";
import { EMPTY_OVERLAY, type Overlay } from "./overlay";
import { publicDataConfig } from "./public-config";

let source: BrowserPropertyDataSource | null = null;

export function propertySource(): BrowserPropertyDataSource {
  source ??= new BrowserPropertyDataSource({
    // Every gateway the same artifact can be read from, configured first. The
    // tab tries them in order rather than waiting on one that is not answering.
    urls: publicDataConfig.queryTableUrls,
    isSample: publicDataConfig.isSample,
    label: publicDataConfig.label,
    countyName: publicDataConfig.countyName,
    stateCode: publicDataConfig.stateCode,
    runHistoryUrl: publicDataConfig.runHistoryUrl,
    attachTimeoutMs: publicDataConfig.attachTimeoutMs,
    probeTimeoutMs: publicDataConfig.probeTimeoutMs,
  });
  return source;
}

export interface OverlayStatus {
  overlay: Overlay;
  courtDataAvailable: boolean;
  courtProperties: number;
  simulatedProperties: number;
  simulatedRunIds: string[];
}

export const EMPTY_OVERLAY_STATUS: OverlayStatus = {
  overlay: EMPTY_OVERLAY,
  courtDataAvailable: false,
  courtProperties: 0,
  simulatedProperties: 0,
  simulatedRunIds: [],
};

/**
 * Fetch the overlay. A deployment with no CRM store has none, which is a
 * supported state: court filters are disabled with that reason shown rather
 * than offered and then matching nothing.
 */
export async function fetchOverlay(): Promise<OverlayStatus> {
  try {
    const response = await fetch("/api/overlay", { cache: "no-store" });
    if (!response.ok) return EMPTY_OVERLAY_STATUS;
    return (await response.json()) as OverlayStatus;
  } catch {
    return EMPTY_OVERLAY_STATUS;
  }
}
