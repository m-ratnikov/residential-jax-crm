"use client";

/**
 * The search the map and the list share, run in the tab.
 *
 * Owns the three things every parcel-facing page needs and none of them should
 * repeat: attaching the published artifact to the engine, fetching the overlay,
 * and turning a scored row into the flat shape the list renders.
 *
 * Debounced rather than run from a button, because an acquisitions analyst
 * adjusts a threshold and wants to see the count move. The count is the
 * feedback; making them press Search to get it hides the thing they came for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CriteriaSet } from "@/lib/criteria/types";
import { needsCourtData } from "@/lib/criteria/sql";
import { displayAddress } from "./map";
import type { ScoredProperty } from "./types";
import { fetchOverlay, propertySource, EMPTY_OVERLAY_STATUS, type OverlayStatus } from "./client-source";
import type { SearchRow } from "@/lib/client";

/** Plotting more than this makes the browser, not the query, the bottleneck. */
export const MAP_POINT_CAP = 4_000;

const PAGE_SIZE = 100;

export function toSearchRow(scored: ScoredProperty, opportunityId: string | null = null): SearchRow {
  const property = scored.property;
  return {
    propertyId: property.propertyId,
    address: displayAddress(property),
    city: property.addressCity,
    zip: property.addressZip,
    latitude: property.latitude,
    longitude: property.longitude,
    ownerName: property.ownerName,
    ownerOccupied: property.ownerOccupied,
    ownerRegionClass: property.ownerRegionClass,
    assessedValue: property.assessedValue,
    marketValue: property.marketValue,
    builtYear: property.builtYear,
    livableFloorArea: property.livableFloorArea,
    roofAgeYears: property.roofAgeYears,
    roofAgeBasis: property.roofAgeBasis,
    yearsSinceLastSale: property.yearsSinceLastSale,
    lastSaleDate: property.lastSaleDate,
    tenureBasis: property.tenureBasis,
    waterViewFlag: property.waterViewFlag,
    nearestTransitStopM: property.nearestTransitStopM,
    courtDistressScore: (property.raw["court_distress_score"] as number | null) ?? null,
    courtLienCount: (property.raw["court_lien_count"] as number | null) ?? null,
    courtForeclosureCount: (property.raw["court_foreclosure_count"] as number | null) ?? null,
    simulated: Boolean(property.raw["overlay_run_id"]),
    score: scored.score,
    rationale: scored.rationale,
    components: [...scored.components],
    provenance: property.provenance,
    opportunityId,
  };
}

export type OrderBy = "score" | "assessed_value" | "roof_age" | "tenure";

export interface SearchState {
  rows: SearchRow[];
  scored: ScoredProperty[];
  total: number;
  sql: string;
  tookMs: number;
  loading: boolean;
  error: string | null;
  mapPoints: { id: string; lat: number; lng: number; score: number }[];
  mapTruncated: boolean;
  overlay: OverlayStatus;
  /** Engine load progress, for the banner while the artifact attaches. */
  engineStage: string;
  engineMessage: string;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

export function useParcelSearch(criteria: CriteriaSet, orderBy: OrderBy): SearchState {
  const [scored, setScored] = useState<ScoredProperty[]>([]);
  const [total, setTotal] = useState(0);
  const [sql, setSql] = useState("");
  const [tookMs, setTookMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [mapPoints, setMapPoints] = useState<SearchState["mapPoints"]>([]);
  const [mapTruncated, setMapTruncated] = useState(false);
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY_STATUS);
  const [tracked, setTracked] = useState<Map<string, string>>(new Map());
  const [engine, setEngine] = useState({ stage: "booting", message: "Starting the query engine" });

  const source = propertySource();
  const requestId = useRef(0);

  useEffect(() => {
    void fetchOverlay().then(setOverlay);
  }, []);

  // Poll the engine's own state while it attaches, so a slow first load shows
  // progress instead of an empty screen.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const state = source.engineState();
      setEngine({ stage: state.stage, message: state.message });
      if (state.stage !== "ready" && state.stage !== "error") setTimeout(tick, 300);
    };
    void source.prefetch().catch(() => undefined);
    tick();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const queryKey = useMemo(
    () => JSON.stringify({ filters: criteria.filters, weights: criteria.weights, orderBy }),
    [criteria.filters, criteria.weights, orderBy],
  );

  const run = useCallback(
    async (nextOffset: number, append: boolean) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);

      try {
        if (needsCourtData(criteria.filters) && !overlay.courtDataAvailable) {
          throw new Error(
            "These criteria ask for court signals and no court source is attached. Attach a CRM store to enable them, or remove those filters.",
          );
        }

        const page = await source.search({
          criteria,
          limit: PAGE_SIZE,
          offset: nextOffset,
          orderBy,
          overlay: overlay.overlay,
        });
        // A slow earlier request must not overwrite a faster later one.
        if (id !== requestId.current) return;

        setScored((current) => (append ? [...current, ...page.rows] : [...page.rows]));
        setTotal(page.total);
        setSql(page.sql);
        setTookMs(page.tookMs);
        setOffset(nextOffset);

        if (!append) {
          const plotted = await source.search({
            criteria,
            limit: MAP_POINT_CAP,
            offset: 0,
            orderBy: "score",
            overlay: overlay.overlay,
          });
          if (id !== requestId.current) return;
          const points = plotted.rows
            .filter((row) => row.property.latitude !== null && row.property.longitude !== null)
            .map((row) => ({
              id: row.property.propertyId,
              lat: row.property.latitude as number,
              lng: row.property.longitude as number,
              score: row.score,
            }));
          setMapPoints(points);
          setMapTruncated(page.total > points.length);
        }
      } catch (cause: unknown) {
        if (id !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : "The search failed.");
        if (!append) {
          setScored([]);
          setTotal(0);
          setMapPoints([]);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [criteria, orderBy, overlay, source],
  );

  useEffect(() => {
    const timer = setTimeout(() => void run(0, false), 250);
    return () => clearTimeout(timer);
    // run closes over criteria, orderBy and overlay; queryKey covers the first
    // two and the overlay is included explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, overlay]);

  // Which of these are already being worked, so the list can say so and a
  // second analyst does not start over on the same house.
  useEffect(() => {
    if (!scored.length) return;
    let cancelled = false;
    fetch("/api/opportunities?limit=1000")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { opportunities?: { opportunity: { id: string; propertyId: string } }[] } | null) => {
        if (cancelled || !body?.opportunities) return;
        setTracked(
          new Map(body.opportunities.map((row) => [row.opportunity.propertyId, row.opportunity.id])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scored.length]);

  const rows = useMemo(
    () => scored.map((row) => toSearchRow(row, tracked.get(row.property.propertyId) ?? null)),
    [scored, tracked],
  );

  return {
    rows,
    scored,
    total,
    sql,
    tookMs,
    loading,
    error,
    mapPoints,
    mapTruncated,
    overlay,
    engineStage: engine.stage,
    engineMessage: engine.message,
    hasMore: rows.length < total,
    loadMore: () => void run(offset + PAGE_SIZE, true),
    refresh: () => void run(0, false),
  };
}
