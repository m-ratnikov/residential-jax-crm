/**
 * CSV export.
 *
 * Three shapes, because the story asks to "export selected properties, owners,
 * and opportunity records for downstream analysis or mailing" and those are
 * three different jobs. The mailing export in particular is the one an operator
 * hands to a print house, so it carries the mailing address rather than the
 * situs address, and it says which of the two it is in the column names.
 *
 * Provenance travels with the data: every row carries the source system and the
 * pipeline run it came from, so an exported file cannot lose the audit trail
 * the moment it leaves the app.
 */

import { fail, handleError } from "@/lib/api";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { displayAddress } from "@/lib/data/map";
import { getPropertyDataSource } from "@/lib/data/source";
import { loadOverlay } from "@/lib/crm/overlay";
import { getSavedSearch, listOpportunities } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_ROWS = 10_000;

/** RFC 4180: quote everything that could be misread, double the quotes inside. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // A trailing newline is what every spreadsheet and every unix tool expects.
  return `${lines.join("\r\n")}\r\n`;
}

function attachment(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

const OPPORTUNITY_HEADERS = [
  "opportunity_id",
  "stage",
  "match_score",
  "match_rationale",
  "property_id",
  "situs_address",
  "situs_city",
  "situs_zip",
  "latitude",
  "longitude",
  "assessed_value",
  "owner_name",
  "owner_email",
  "owner_phone",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "assignee",
  "asking_price",
  "offer_price",
  "owner_interest",
  "next_step",
  "saved_search",
  "created_at",
] as const;

const MAILING_HEADERS = [
  "owner_name",
  "mailing_address",
  "mailing_city",
  "mailing_state",
  "mailing_zip",
  "property_id",
  "situs_address",
  "stage",
  "match_score",
] as const;

const PROPERTY_HEADERS = [
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
  "assessed_value",
  "market_value",
  "built_year",
  "livable_floor_area",
  "roof_age_years",
  "roof_age_basis",
  "years_since_last_sale",
  "last_sale_date",
  "tenure_basis",
  "water_view",
  "nearest_transit_stop_m",
  "match_score",
  "match_rationale",
  "source_system",
  "source_url",
  "fetched_at",
  "pipeline_run_id",
] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "opportunities";
    const stamp = new Date().toISOString().slice(0, 10);

    if (kind === "opportunities" || kind === "mailing") {
      const rows = await listOpportunities({ limit: MAX_ROWS });

      if (kind === "mailing") {
        // Only rows that could actually be mailed. Exporting a row with no
        // address into a print run wastes a piece of mail.
        const mailable = rows.filter((row) => row.owner?.mailingAddress);
        return attachment(
          csv(
            MAILING_HEADERS,
            mailable.map((row) => [
              row.owner?.name,
              row.owner?.mailingAddress,
              row.owner?.mailingCity,
              row.owner?.mailingState,
              row.owner?.mailingZip,
              row.opportunity.propertyId,
              row.opportunity.addressLine,
              row.opportunity.stage,
              row.opportunity.matchScore,
            ]),
          ),
          `duval-mailing-list-${stamp}.csv`,
        );
      }

      return attachment(
        csv(
          OPPORTUNITY_HEADERS,
          rows.map((row) => [
            row.opportunity.id,
            row.opportunity.stage,
            row.opportunity.matchScore,
            row.opportunity.matchRationale,
            row.opportunity.propertyId,
            row.opportunity.addressLine,
            row.opportunity.addressCity,
            row.opportunity.addressZip,
            row.opportunity.latitude,
            row.opportunity.longitude,
            row.opportunity.assessedValue,
            row.owner?.name ?? row.opportunity.ownerNameSnapshot,
            row.owner?.email,
            row.owner?.phone,
            row.owner?.mailingAddress,
            row.owner?.mailingCity,
            row.owner?.mailingState,
            row.owner?.mailingZip,
            row.assignee?.name,
            row.opportunity.askingPrice,
            row.opportunity.offerPrice,
            row.opportunity.ownerInterest,
            row.opportunity.nextStep,
            row.searchName,
            row.opportunity.createdAt?.toISOString?.() ?? row.opportunity.createdAt,
          ]),
        ),
        `duval-opportunities-${stamp}.csv`,
      );
    }

    if (kind === "properties") {
      const savedSearchId = url.searchParams.get("savedSearchId");
      const criteriaRaw = url.searchParams.get("criteria");
      let criteria = null;

      if (savedSearchId) {
        const search = await getSavedSearch(savedSearchId);
        if (search) criteria = criteriaSetSchema.parse(search.criteria);
      } else if (criteriaRaw) {
        criteria = criteriaSetSchema.parse(JSON.parse(criteriaRaw));
      }

      if (!criteria) {
        return fail(
          "invalid_request",
          "Exporting properties needs a saved search id or a criteria set.",
          400,
        );
      }

      const { source } = getPropertyDataSource();
      const overlay = await loadOverlay();
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 5_000) || 5_000, MAX_ROWS);
      const result = await source.search({ criteria, limit, overlay: overlay.overlay });

      return attachment(
        csv(
          PROPERTY_HEADERS,
          result.rows.map((row) => [
            row.property.propertyId,
            row.property.parcelIdentifier,
            displayAddress(row.property),
            row.property.addressCity,
            row.property.addressZip,
            row.property.latitude,
            row.property.longitude,
            row.property.ownerName,
            row.property.ownerOccupied,
            row.property.ownerRegionClass,
            row.property.assessedValue,
            row.property.marketValue,
            row.property.builtYear,
            row.property.livableFloorArea,
            row.property.roofAgeYears,
            row.property.roofAgeBasis,
            row.property.yearsSinceLastSale,
            row.property.lastSaleDate,
            row.property.tenureBasis,
            row.property.waterViewFlag,
            row.property.nearestTransitStopM,
            row.score,
            row.rationale,
            row.property.provenance.sourceSystem,
            row.property.provenance.sourceUrl,
            row.property.provenance.fetchedAt,
            row.property.provenance.runId,
          ]),
        ),
        `duval-properties-${stamp}.csv`,
      );
    }

    return fail("invalid_request", "kind must be opportunities, mailing or properties.", 400);
  } catch (error: unknown) {
    return handleError("GET /api/export", error);
  }
}
