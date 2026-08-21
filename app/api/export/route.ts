/**
 * CSV export.
 *
 * The opportunity and mailing exports live here because they are CRM records.
 * The property export is built in the browser, where the parcel data is: asking
 * a server function to re-read the artifact to produce a CSV the tab already
 * has the rows for would put a query engine back on the critical path.
 *
 * The mailing export is the one an operator hands to a print house, so it
 * carries the mailing address rather than the situs address, says which of the
 * two each column is, and drops rows that could not actually be posted.
 *
 * Provenance travels with the data: every row carries the source system and the
 * pipeline run it came from, so an exported file cannot lose the audit trail
 * the moment it leaves the app.
 */

import { fail, handleError } from "@/lib/api";
import { listOpportunities } from "@/lib/crm/repo";

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
            row.opportunity.createdAt,
          ]),
        ),
        `duval-opportunities-${stamp}.csv`,
      );
    }

    return fail("invalid_request", "kind must be opportunities or mailing.", 400);
  } catch (error: unknown) {
    return handleError("GET /api/export", error);
  }
}
