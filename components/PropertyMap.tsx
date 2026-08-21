/**
 * The map.
 *
 * MapLibre GL with a raster basemap. The basemap is deliberately a raster
 * source declared inline rather than a hosted style document: it is one HTTP
 * dependency instead of two, it needs no API key, and if the tile host is
 * unreachable the parcels still render over an empty ground rather than the map
 * failing to initialise at all.
 *
 * Parcels are drawn as a single GeoJSON circle layer coloured by match score.
 * Beyond a few thousand points a browser starts to struggle, so the search
 * route caps what it returns and the map says when it is showing a subset -
 * a map that silently plots the first two hundred of forty thousand matches is
 * lying about the geography, which is worse than admitting the cap.
 *
 * Drawing is hand rolled rather than taken from mapbox-gl-draw: the app needs
 * exactly two shapes, a circle and a polygon, and a draw library is a large
 * dependency and a compatibility risk for two click handlers.
 */

"use client";

import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type LngLatLike,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

import type { Geometry } from "@/lib/criteria/types";
import { Badge, Button, cx, count } from "./ui";

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  score: number;
}

export type DrawMode = "none" | "circle" | "polygon";

export interface PropertyMapProps {
  points: MapPoint[];
  center: { lat: number; lng: number; zoom: number };
  /** The geometry currently applied to the search, drawn as an overlay. */
  geometry: Geometry | null;
  onGeometryChange: (geometry: Geometry | null) => void;
  onSelect: (propertyId: string) => void;
  selectedId?: string | null;
  truncated?: boolean;
  total?: number;
  loading?: boolean;
}

const POINTS_SOURCE = "parcels";
const SHAPE_SOURCE = "draw-shape";
const DRAFT_SOURCE = "draw-draft";

/** Metres per degree of latitude. Good enough for drawing a search radius. */
const METRES_PER_DEGREE = 111_320;

function circleToPolygon(lat: number, lng: number, radiusM: number, steps = 72): number[][] {
  const ring: number[][] = [];
  const latRadius = radiusM / METRES_PER_DEGREE;
  const lngRadius = radiusM / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    ring.push([lng + lngRadius * Math.cos(angle), lat + latRadius * Math.sin(angle)]);
  }
  return ring;
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

function geometryToFeature(geometry: Geometry | null): GeoJSON.FeatureCollection {
  if (!geometry) return { type: "FeatureCollection", features: [] };

  let ring: number[][] = [];
  if (geometry.type === "circle") {
    ring = circleToPolygon(geometry.lat, geometry.lng, geometry.radiusM);
  } else if (geometry.type === "polygon") {
    ring = [...geometry.ring.map(([lng, lat]) => [lng, lat])];
    if (ring.length && ring[0]) ring.push(ring[0]);
  } else {
    ring = [
      [geometry.west, geometry.south],
      [geometry.east, geometry.south],
      [geometry.east, geometry.north],
      [geometry.west, geometry.north],
      [geometry.west, geometry.south],
    ];
  }

  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
    ],
  };
}

const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0e1116" } },
    { id: "basemap", type: "raster", source: "basemap", paint: { "raster-opacity": 0.85 } },
  ],
};

export function PropertyMap({
  points,
  center,
  geometry,
  onGeometryChange,
  onSelect,
  selectedId,
  truncated,
  total,
  loading,
}: PropertyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<DrawMode>("none");
  const [draftRing, setDraftRing] = useState<[number, number][]>([]);
  const [circleAnchor, setCircleAnchor] = useState<{ lat: number; lng: number } | null>(null);

  // Handlers change identity on every render; the map listeners are registered
  // once, so they read the current values through a ref instead.
  const stateRef = useRef({ mode, draftRing, circleAnchor, onGeometryChange, onSelect });
  stateRef.current = { mode, draftRing, circleAnchor, onGeometryChange, onSelect };

  const geojson = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: points.map((point) => ({
        type: "Feature",
        id: point.id,
        properties: { id: point.id, score: point.score },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] },
      })),
    }),
    [points],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [center.lng, center.lat] as LngLatLike,
      zoom: center.zoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ScaleControl({ unit: "imperial" }), "bottom-left");

    map.on("load", () => {
      map.addSource(POINTS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(SHAPE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(DRAFT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "shape-fill",
        type: "fill",
        source: SHAPE_SOURCE,
        paint: { "fill-color": "#2b7fe0", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "shape-line",
        type: "line",
        source: SHAPE_SOURCE,
        paint: { "line-color": "#4f9cf0", "line-width": 1.5, "line-dasharray": [2, 2] },
      });

      map.addLayer({
        id: "parcels",
        type: "circle",
        source: POINTS_SOURCE,
        paint: {
          // Points grow with zoom so a dense block is legible when you go in.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 13, 4, 16, 7],
          // Colour by match score. The legend states the bands.
          "circle-color": ["step", ["get", "score"], "#6b7689", 45, "#c8871d", 75, "#2f9e6b"],
          "circle-opacity": 0.85,
          "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 2, 0],
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "draft-line",
        type: "line",
        source: DRAFT_SOURCE,
        paint: { "line-color": "#4f9cf0", "line-width": 2 },
      });

      setReady(true);
    });

    map.on("click", "parcels", (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const id = feature?.properties?.["id"];
      if (typeof id === "string") {
        event.preventDefault();
        stateRef.current.onSelect(id);
      }
    });

    map.on("mouseenter", "parcels", () => {
      if (stateRef.current.mode === "none") map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "parcels", () => {
      map.getCanvas().style.cursor = "";
    });

    map.on("click", (event: MapMouseEvent) => {
      if (event.defaultPrevented) return;
      const { mode: currentMode, circleAnchor: anchor } = stateRef.current;
      const point = { lat: event.lngLat.lat, lng: event.lngLat.lng };

      if (currentMode === "circle") {
        if (!anchor) {
          setCircleAnchor(point);
          return;
        }
        const radiusM = Math.max(150, Math.round(haversine(anchor, point)));
        stateRef.current.onGeometryChange({
          type: "circle",
          lat: anchor.lat,
          lng: anchor.lng,
          radiusM,
        });
        setCircleAnchor(null);
        setMode("none");
        return;
      }

      if (currentMode === "polygon") {
        setDraftRing((ring) => [...ring, [point.lng, point.lat]]);
      }
    });

    // A double click closes a polygon, which is the convention every mapping
    // tool uses, so it needs no instruction.
    map.on("dblclick", (event: MapMouseEvent) => {
      if (stateRef.current.mode !== "polygon") return;
      event.preventDefault();
      const ring = stateRef.current.draftRing;
      if (ring.length >= 3) {
        stateRef.current.onGeometryChange({ type: "polygon", ring });
      }
      setDraftRing([]);
      setMode("none");
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount once. Centre changes are handled by the caller re-flying the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(POINTS_SOURCE) as GeoJSONSource | undefined)?.setData(geojson);
  }, [geojson, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined)?.setData(
      geometryToFeature(geometry),
    );
  }, [geometry, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data: GeoJSON.FeatureCollection =
      draftRing.length >= 2
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: draftRing },
              },
            ],
          }
        : { type: "FeatureCollection", features: [] };
    (map.getSource(DRAFT_SOURCE) as GeoJSONSource | undefined)?.setData(data);
  }, [draftRing, ready]);

  // Selection is feature state rather than a re-render of the whole source:
  // repainting four thousand points to highlight one is wasteful and visible.
  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (previousSelection.current) {
      map.setFeatureState(
        { source: POINTS_SOURCE, id: previousSelection.current },
        { selected: false },
      );
    }
    if (selectedId) {
      map.setFeatureState({ source: POINTS_SOURCE, id: selectedId }, { selected: true });
    }
    previousSelection.current = selectedId ?? null;
  }, [selectedId, ready]);

  const startDraw = useCallback((next: DrawMode) => {
    setDraftRing([]);
    setCircleAnchor(null);
    setMode((current) => (current === next ? "none" : next));
  }, []);

  const fitToPoints = useCallback(() => {
    const map = mapRef.current;
    if (!map || !points.length) return;
    const bounds = new LngLatBounds(
      [points[0]!.lng, points[0]!.lat],
      [points[0]!.lng, points[0]!.lat],
    );
    for (const point of points) bounds.extend([point.lng, point.lat]);
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 600 });
  }, [points]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-[var(--line)]">
      <div
        ref={containerRef}
        className={cx("h-full w-full", mode !== "none" && "map-draw-active")}
      />

      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
        <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel)]/95 p-1.5 backdrop-blur">
          <Button
            size="sm"
            variant={mode === "circle" ? "primary" : "default"}
            onClick={() => startDraw("circle")}
            title="Click the centre, then click again to set the radius."
          >
            Radius
          </Button>
          <Button
            size="sm"
            variant={mode === "polygon" ? "primary" : "default"}
            onClick={() => startDraw("polygon")}
            title="Click each corner, then double click to close the shape."
          >
            Polygon
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              const map = mapRef.current;
              if (!map) return;
              const bounds = map.getBounds();
              onGeometryChange({
                type: "bbox",
                west: bounds.getWest(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                north: bounds.getNorth(),
              });
            }}
            title="Use the current view as the search area."
          >
            This view
          </Button>
          {geometry && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onGeometryChange(null);
                setDraftRing([]);
                setCircleAnchor(null);
                setMode("none");
              }}
            >
              Clear area
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={fitToPoints}
            title="Zoom to the current matches."
          >
            Fit
          </Button>
        </div>

        {mode !== "none" && (
          <div className="pointer-events-none rounded-md border border-accent-500/40 bg-[var(--panel)]/95 px-2.5 py-1.5 text-[11px] text-accent-400 backdrop-blur">
            {mode === "circle"
              ? circleAnchor
                ? "Now click to set the radius."
                : "Click the centre of the area."
              : "Click each corner. Double click to close."}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1.5">
        {loading && (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel)]/95 px-2 py-1 text-[11px] text-ink-300 backdrop-blur">
            Searching
          </div>
        )}
        {truncated && total !== undefined && (
          <div className="pointer-events-auto max-w-[260px] rounded-md border border-warn-500/40 bg-[var(--panel)]/95 px-2.5 py-1.5 text-[11px] text-warn-500 backdrop-blur">
            Showing the {count(points.length)} highest scoring of {count(total)} matches. Narrow the
            criteria or draw an area to see the rest.
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-8 right-3 flex flex-col gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)]/95 px-2.5 py-2 text-[11px] backdrop-blur">
        <span className="text-ink-500">Match score</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-good-500" /> 75 and above
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-warn-500" /> 45 to 74
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-ink-500" /> below 45
        </span>
      </div>

      {geometry && (
        <div className="pointer-events-none absolute bottom-8 left-3">
          <Badge tone="accent">
            {geometry.type === "circle"
              ? `${(geometry.radiusM / 1609.34).toFixed(1)} mi radius`
              : geometry.type === "polygon"
                ? `${geometry.ring.length} point polygon`
                : "Map view area"}
          </Badge>
        </div>
      )}
    </div>
  );
}
