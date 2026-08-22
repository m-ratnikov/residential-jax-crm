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
import { needsCourtData, type MapViewport } from "@/lib/criteria/sql";
import { displayAddress } from "./map";
import type {
  AttachAttaching,
  AttachFailed,
  AttachReady,
  AttachState,
  ScoredProperty,
} from "./types";
import {
  fetchOverlay,
  propertySource,
  EMPTY_OVERLAY_STATUS,
  type OverlayStatus,
} from "./client-source";
import type { SearchRow } from "@/lib/client";

/** Plotting more than this makes the browser, not the query, the bottleneck. */
export const MAP_POINT_CAP = 4_000;

const PAGE_SIZE = 100;

export function toSearchRow(
  scored: ScoredProperty,
  opportunityId: string | null = null,
): SearchRow {
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

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  score: number;
}

/** What every variant can do, whether or not there is anything to show yet. */
interface SearchControls {
  overlay: OverlayStatus;
  loadMore: () => void;
  refresh: () => void;
  /** Try every gateway again after they all refused. */
  retryAttach: () => void;
}

/**
 * The artifact has not attached. There are no rows, no total, and no way to ask
 * this variant for either - which is the point.
 */
export interface SearchAttaching extends SearchControls {
  readonly status: "attaching";
  readonly attach: AttachAttaching;
}

/** Every gateway refused. The surface offers a retry, not an empty list. */
export interface SearchUnavailable extends SearchControls {
  readonly status: "unavailable";
  readonly attach: AttachFailed;
}

/** The artifact is attached, so a row count is now a fact about the data. */
export interface SearchReady extends SearchControls {
  readonly status: "ready";
  readonly attach: AttachReady;
  readonly rows: SearchRow[];
  readonly scored: ScoredProperty[];
  readonly total: number;
  readonly sql: string;
  readonly tookMs: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly mapPoints: MapPoint[];
  readonly mapTruncated: boolean;
  readonly hasMore: boolean;
}

/**
 * `rows` and `total` exist on `SearchReady` and nowhere else, so "no parcels
 * match these criteria" cannot be typed while the source is still attaching:
 * reaching for the row count without narrowing past `attaching` first is a
 * compile error rather than a lie on screen.
 */
export type SearchState = SearchAttaching | SearchUnavailable | SearchReady;

/** What the result surface should render. There is exactly one right answer. */
export type ResultView = "attaching" | "unavailable" | "searching" | "empty" | "results";

/**
 * The whole defect, in one function.
 *
 * "Nothing matched" is only sayable once the data is attached and a query has
 * actually come back. Any other combination has its own honest answer, and
 * `empty` is unreachable from all of them.
 */
export function resultView(attach: AttachState, loading: boolean, rowCount: number): ResultView {
  if (attach.phase === "attaching") return "attaching";
  if (attach.phase === "failed") return "unavailable";
  if (loading) return "searching";
  return rowCount > 0 ? "results" : "empty";
}

/** One sentence for the attach banner, including how long it has been going. */
export function attachHeadline(attach: AttachAttaching): string {
  const seconds = Math.floor(attach.elapsedMs / 1000);
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const where = attach.failedOver
    ? ` (gateway ${attach.gatewayIndex + 1} of ${attach.gatewayCount})`
    : "";
  return `${attach.message}${where} - ${elapsed} elapsed`;
}

export function useParcelSearch(
  criteria: CriteriaSet,
  orderBy: OrderBy,
  /**
   * The map's current view, when results are following it.
   *
   * A separate argument rather than a filter inside the criteria set, because
   * where the map happens to be pointing is not part of an acquisition thesis.
   * Saving a search must not capture it: the scheduled matcher would then alert
   * forever on whatever was on screen when somebody pressed Save.
   */
  viewport: MapViewport | null = null,
): SearchState {
  const [scored, setScored] = useState<ScoredProperty[]>([]);
  const [total, setTotal] = useState(0);
  const [sql, setSql] = useState("");
  const [tookMs, setTookMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [mapPoints, setMapPoints] = useState<MapPoint[]>([]);
  const [mapTruncated, setMapTruncated] = useState(false);
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY_STATUS);
  const [tracked, setTracked] = useState<Map<string, string>>(new Map());

  const source = propertySource();
  const [attach, setAttach] = useState<AttachState>(() => source.attachState());
  // Bumped by a retry, to restart the poll below against a fresh attempt.
  const [attachEpoch, setAttachEpoch] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    void fetchOverlay().then(setOverlay);
  }, []);

  // Poll while it attaches, so a slow first load shows what it is doing and for
  // how long. The poll stops the moment the attach settles either way; a ready
  // source has nothing left to report.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      if (cancelled) return;
      const next = source.attachState();
      setAttach(next);
      if (next.phase === "attaching") timer = setTimeout(tick, 400);
    };

    void source
      .prefetch()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setAttach(source.attachState());
      });
    tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [source, attachEpoch]);

  const retryAttach = useCallback(() => {
    void source.retryAttach().catch(() => undefined);
    setAttach(source.attachState());
    setAttachEpoch((epoch) => epoch + 1);
  }, [source]);

  // The viewport is rounded into the key at about a metre of precision. Panning
  // a map produces a continuous stream of slightly different rectangles, and
  // without this every pixel of drift would count as a new search.
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        filters: criteria.filters,
        weights: criteria.weights,
        orderBy,
        viewport: viewport
          ? [viewport.west, viewport.south, viewport.east, viewport.north].map((value) =>
              value.toFixed(5),
            )
          : null,
      }),
    [criteria.filters, criteria.weights, orderBy, viewport],
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
          viewport,
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
            viewport,
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
    [criteria, orderBy, overlay, source, viewport],
  );

  useEffect(() => {
    // Nothing to query until something has attached. Running anyway is how the
    // surface used to reach "0 matches" before the data existed.
    if (attach.phase !== "ready") return;
    const timer = setTimeout(() => void run(0, false), 250);
    return () => clearTimeout(timer);
    // run closes over criteria, orderBy and overlay; queryKey covers the first
    // two and the overlay is included explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, overlay, attach.phase]);

  // Which of these are already being worked, so the list can say so and a
  // second analyst does not start over on the same house.
  useEffect(() => {
    if (!scored.length) return;
    let cancelled = false;
    fetch("/api/opportunities?limit=1000", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          body: { opportunities?: { opportunity: { id: string; propertyId: string } }[] } | null,
        ) => {
          if (cancelled || !body?.opportunities) return;
          setTracked(
            new Map(
              body.opportunities.map((row) => [row.opportunity.propertyId, row.opportunity.id]),
            ),
          );
        },
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scored.length]);

  const rows = useMemo(
    () => scored.map((row) => toSearchRow(row, tracked.get(row.property.propertyId) ?? null)),
    [scored, tracked],
  );

  const controls: SearchControls = {
    overlay,
    retryAttach,
    loadMore: () => void run(offset + PAGE_SIZE, true),
    refresh: () => void run(0, false),
  };

  if (attach.phase === "attaching") return { status: "attaching", attach, ...controls };
  if (attach.phase === "failed") return { status: "unavailable", attach, ...controls };

  return {
    status: "ready",
    attach,
    rows,
    scored,
    total,
    sql,
    tookMs,
    loading,
    error,
    mapPoints,
    mapTruncated,
    hasMore: rows.length < total,
    ...controls,
  };
}
