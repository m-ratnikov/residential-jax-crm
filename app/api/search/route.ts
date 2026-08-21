/**
 * The search the map and the list both use.
 *
 * One request returns three things a reviewer needs together: the ranked page
 * of parcels, the total that matched before paging, and the SQL that produced
 * them. Showing the SQL is not a debug affordance - it is what makes a claimed
 * match count arguable rather than something to be taken on trust.
 *
 * Map points come back separately and unpaged, because a map that only plots
 * the first two hundred of forty thousand matches is lying about the geography.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { needsCourtData } from "@/lib/criteria/sql";
import { displayAddress } from "@/lib/data/map";
import { getPropertyDataSource } from "@/lib/data/source";
import { loadOverlay } from "@/lib/crm/overlay";
import { hasDatabase, tryDb } from "@/lib/crm/db";
import { opportunities } from "@/lib/crm/schema";
import { inArray } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Plotting more than this many points makes the browser, not the query, the bottleneck. */
const MAP_POINT_CAP = 4_000;

const requestSchema = z.object({
  criteria: criteriaSetSchema,
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  orderBy: z.enum(["score", "assessed_value", "roof_age", "tenure"]).default("score"),
  /** Ask for map points as well as the list page. */
  includeMap: z.boolean().default(true),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = requestSchema.parse(await readJson(request));
    const { source } = getPropertyDataSource();
    const overlay = await loadOverlay();

    const wantsCourt = needsCourtData(parsed.criteria.filters);
    if (wantsCourt && !overlay.courtDataAvailable) {
      return fail(
        "court_data_unavailable",
        "These criteria ask for court signals (liens, foreclosures, probate or code enforcement) and no court source is attached. Attach a CRM store to enable them, or remove those filters.",
        409,
      );
    }

    const page = await source.search({
      criteria: parsed.criteria,
      limit: parsed.limit,
      offset: parsed.offset,
      orderBy: parsed.orderBy,
      overlay: overlay.overlay,
    });

    // Which of these are already being worked, so the list can say so and a
    // second analyst does not start over on the same house.
    const tracked = await trackedOpportunities(page.rows.map((row) => row.property.propertyId));

    const rows = page.rows.map((row) => ({
      propertyId: row.property.propertyId,
      address: displayAddress(row.property),
      city: row.property.addressCity,
      zip: row.property.addressZip,
      latitude: row.property.latitude,
      longitude: row.property.longitude,
      ownerName: row.property.ownerName,
      ownerOccupied: row.property.ownerOccupied,
      ownerRegionClass: row.property.ownerRegionClass,
      assessedValue: row.property.assessedValue,
      marketValue: row.property.marketValue,
      builtYear: row.property.builtYear,
      livableFloorArea: row.property.livableFloorArea,
      roofAgeYears: row.property.roofAgeYears,
      roofAgeBasis: row.property.roofAgeBasis,
      yearsSinceLastSale: row.property.yearsSinceLastSale,
      lastSaleDate: row.property.lastSaleDate,
      tenureBasis: row.property.tenureBasis,
      waterViewFlag: row.property.waterViewFlag,
      nearestTransitStopM: row.property.nearestTransitStopM,
      courtDistressScore: row.property.raw["court_distress_score"] ?? null,
      courtLienCount: row.property.raw["court_lien_count"] ?? null,
      courtForeclosureCount: row.property.raw["court_foreclosure_count"] ?? null,
      simulated: Boolean(row.property.raw["overlay_run_id"]),
      score: row.score,
      rationale: row.rationale,
      components: row.components,
      provenance: row.property.provenance,
      opportunityId: tracked.get(row.property.propertyId) ?? null,
    }));

    let mapPoints: {
      id: string;
      lat: number;
      lng: number;
      score: number;
    }[] = [];
    let mapTruncated = false;

    if (parsed.includeMap) {
      const plotted = await source.search({
        criteria: parsed.criteria,
        limit: MAP_POINT_CAP,
        offset: 0,
        orderBy: "score",
        overlay: overlay.overlay,
      });
      mapPoints = plotted.rows
        .filter((row) => row.property.latitude !== null && row.property.longitude !== null)
        .map((row) => ({
          id: row.property.propertyId,
          lat: row.property.latitude as number,
          lng: row.property.longitude as number,
          score: row.score,
        }));
      mapTruncated = page.total > mapPoints.length;
    }

    return ok({
      total: page.total,
      returned: rows.length,
      offset: parsed.offset,
      rows,
      map: { points: mapPoints, truncated: mapTruncated, cap: MAP_POINT_CAP },
      sql: page.sql,
      tookMs: page.tookMs,
      courtDataAvailable: overlay.courtDataAvailable,
      crmStoreConfigured: hasDatabase(),
    });
  } catch (error: unknown) {
    return handleError("POST /api/search", error);
  }
}

/** propertyId -> opportunityId for the parcels on this page. */
async function trackedOpportunities(propertyIds: string[]): Promise<Map<string, string>> {
  const database = tryDb();
  if (!database || !propertyIds.length) return new Map();
  try {
    const rows = await database
      .select({ id: opportunities.id, propertyId: opportunities.propertyId })
      .from(opportunities)
      .where(inArray(opportunities.propertyId, propertyIds));
    return new Map(rows.map((row) => [row.propertyId, row.id]));
  } catch {
    // A store that is configured but not migrated must not break search.
    return new Map();
  }
}
