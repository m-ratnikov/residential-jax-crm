"use client";

/**
 * The property export, built where the property data is.
 *
 * It deliberately re-runs the search rather than exporting the rows on screen:
 * an analyst who has scrolled two pages into a forty thousand parcel match set
 * and presses Export means "give me the matches", not "give me the two hundred
 * I happen to have looked at".
 *
 * Provenance travels with the data. Every row carries the source system, the
 * source URL, when it was collected and the pipeline run it came from, so an
 * exported file cannot lose its audit trail the moment it leaves the app.
 */

import type { CriteriaSet } from "@/lib/criteria/types";
import { tenureCaveat } from "@/lib/criteria/score";
import { tenureConfidenceOf } from "@/lib/criteria/sql";
import { toDate } from "@/components/ui";
import { displayAddress } from "./map";
import { fetchOverlay, propertySource } from "./client-source";

/** Above this the browser is doing the county's job; the file says it stopped. */
const MAX_ROWS = 10_000;

const HEADERS = [
  "property_id",
  "parcel_identifier",
  "situs_address",
  "city",
  "zip",
  "latitude",
  "longitude",
  "owner_name",
  "owner_occupied",
  "owner_region_class",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "assessed_value",
  "market_value",
  "built_year",
  "livable_floor_area",
  "roof_age_years",
  "roof_age_basis",
  "years_since_last_sale",
  "last_sale_date",
  "tenure_basis",
  // The roll's placeholder sale dates produce tenures like 127 years on a house
  // built in 1986. The published number is exported unaltered, and these two say
  // whether it can be relied on - an export that drops the caveat sends the
  // number downstream with nothing attached to it.
  "tenure_confidence",
  "tenure_caveat",
  "water_view",
  "nearest_transit_stop_m",
  "court_distress_score",
  "match_score",
  "match_rationale",
  "source_system",
  "source_url",
  "fetched_at",
  "pipeline_run_id",
] as const;

/**
 * The collection time, as a timestamp rather than a number.
 *
 * `fetched_at` is a parquet TIMESTAMP, so it crosses Arrow into the tab as
 * epoch milliseconds and shipped as "1787320736294" in the provenance column of
 * a file sold for downstream analysis. The drawer already runs it through
 * `toDate` before showing it; the export now recognises it the same way, so one
 * parser decides what the value is on both surfaces.
 *
 * ISO 8601 in UTC rather than the drawer's readable string, because the two
 * surfaces are read by different things. A person reads the drawer, so it gets
 * a local time with its zone named. A spreadsheet or a dataframe reads this, so
 * it gets the form every one of them parses without being told a format, and
 * with the zone carried in the value.
 */
export function provenanceInstant(value: unknown): string | null {
  const at = toDate(value);
  return at ? at.toISOString() : (value ?? null) === null ? null : String(value);
}

/** RFC 4180: quote anything that could be misread, double the quotes inside. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function buildPropertyCsv(criteria: CriteriaSet): Promise<string> {
  const source = propertySource();
  const overlay = await fetchOverlay();

  const result = await source.search({
    criteria,
    limit: MAX_ROWS,
    orderBy: "score",
    overlay: overlay.overlay,
  });

  const lines = [HEADERS.join(",")];

  for (const scored of result.rows) {
    const property = scored.property;
    lines.push(
      [
        property.propertyId,
        property.parcelIdentifier,
        displayAddress(property),
        property.addressCity,
        property.addressZip,
        property.latitude,
        property.longitude,
        property.ownerName,
        property.ownerOccupied,
        property.ownerRegionClass,
        property.ownerMailingAddress,
        property.ownerMailingCity,
        property.ownerMailingState,
        property.ownerMailingZip,
        property.assessedValue,
        property.marketValue,
        property.builtYear,
        property.livableFloorArea,
        property.roofAgeYears,
        property.roofAgeBasis,
        property.yearsSinceLastSale,
        property.lastSaleDate,
        property.tenureBasis,
        tenureConfidenceOf(property),
        tenureCaveat(property),
        property.waterViewFlag,
        property.nearestTransitStopM,
        property.raw["court_distress_score"] ?? null,
        scored.score,
        scored.rationale,
        property.provenance.sourceSystem,
        property.provenance.sourceUrl,
        provenanceInstant(property.provenance.fetchedAt),
        property.provenance.runId,
      ]
        .map(cell)
        .join(","),
    );
  }

  if (result.total > result.rows.length) {
    // Saying so in the file itself, because a silently truncated export reads
    // as a complete one on the other end.
    lines.push("");
    lines.push(
      cell(
        `Truncated: ${result.total.toLocaleString("en-US")} parcels matched, ${result.rows.length.toLocaleString("en-US")} exported. Narrow the criteria to export the rest.`,
      ),
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}

export async function downloadPropertyCsv(criteria: CriteriaSet): Promise<void> {
  const csv = await buildPropertyCsv(criteria);
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));

  const link = document.createElement("a");
  link.href = url;
  link.download = `duval-properties-${stamp}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
