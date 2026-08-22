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
 *
 * The mailing columns are real, from the county roll. The two contact columns
 * that end in `_simulated` are not: they hold the mocked skip trace, and they
 * are named that way because a CSV on somebody's desktop has no tooltip to
 * explain itself. `owner_email` and `owner_phone` stay reserved for details a
 * team entered by hand.
 */

import { fail, handleError, noStoreHeaders } from "@/lib/api";
import { crmStore } from "@/lib/crm/db";
import type { AlertDoc } from "@/lib/crm/documents";
import { listOpportunities, type OpportunityView } from "@/lib/crm/repo";

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
  // Built by hand rather than through `ok`, so the directive is applied here
  // explicitly. A cached export is a file that quietly stops matching the board
  // it was taken from.
  return new Response(body, {
    headers: noStoreHeaders({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    }),
  });
}

/**
 * Where an exported row came from.
 *
 * The parcel snapshot the browser wrote when the opportunity was created is the
 * authoritative record, so the source system and the pipeline run come from
 * there. The alert the opportunity was converted from carries the matcher run
 * that produced it, which is the other half of the lineage: which pipeline load
 * the parcel came from, and which matcher pass decided it was worth tracking.
 *
 * Nothing here is invented. A field the row genuinely does not carry is emitted
 * as an empty cell, because a placeholder in a provenance column is worse than
 * a blank one: it reads as an answer.
 */
interface RowProvenance {
  sourceSystem: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
  pipelineRunId: string | null;
  alertId: string | null;
  matcherRunId: string | null;
}

interface SnapshotProvenance {
  sourceSystem?: string | null;
  sourceUrl?: string | null;
  fetchedAt?: string | null;
  runId?: string | null;
}

function provenanceOf(row: OpportunityView, alert: AlertDoc | null): RowProvenance {
  const snapshot = (row.opportunity.propertySnapshot ?? {}) as {
    provenance?: SnapshotProvenance | null;
  };
  const carried = snapshot.provenance ?? {};
  return {
    // The owner document keeps the same source the parcel was read from, so it
    // answers for rows written before the snapshot carried provenance.
    sourceSystem: carried.sourceSystem ?? row.owner?.sourceSystem ?? null,
    sourceUrl: carried.sourceUrl ?? row.owner?.sourceUrl ?? null,
    fetchedAt: carried.fetchedAt ?? null,
    pipelineRunId: carried.runId ?? alert?.pipelineRunId ?? null,
    alertId: row.opportunity.alertId ?? null,
    matcherRunId: alert?.matcherRunId ?? null,
  };
}

/**
 * The alerts an export needs, keyed by id.
 *
 * Read straight from the store rather than through `listAlerts`, which hides
 * dismissed alerts and caps at 500: an opportunity converted from an alert that
 * was later dismissed still came from that matcher run, and the export is about
 * where the row came from, not what is still in the feed.
 */
async function alertsById(rows: readonly OpportunityView[]): Promise<Map<string, AlertDoc>> {
  const wanted = new Set(
    rows.map((row) => row.opportunity.alertId).filter((id): id is string => Boolean(id)),
  );
  if (wanted.size === 0) return new Map();
  const alerts = await crmStore().list<AlertDoc>("alerts");
  return new Map(alerts.filter((alert) => wanted.has(alert.id)).map((alert) => [alert.id, alert]));
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
  // Suffixed rather than folded into the two columns above, so a spreadsheet
  // three desks away still says what these are. They come from the mocked skip
  // trace in lib/crm/skip-trace.ts: a reserved `.invalid` domain and a reserved
  // 555-01xx number, neither of which can be delivered to or dialled.
  "owner_email_simulated",
  "owner_phone_simulated",
  "owner_contact_note",
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
  "source_system",
  "source_url",
  "fetched_at",
  "pipeline_run_id",
  "alert_id",
  "matcher_run_id",
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
  "source_system",
  "pipeline_run_id",
] as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "opportunities";
    const stamp = new Date().toISOString().slice(0, 10);

    if (kind === "opportunities" || kind === "mailing") {
      const rows = await listOpportunities({ limit: MAX_ROWS });
      const alerts = await alertsById(rows);

      if (kind === "mailing") {
        // Only rows that could actually be mailed. Exporting a row with no
        // address into a print run wastes a piece of mail.
        const mailable = rows.filter((row) => row.owner?.mailingAddress);
        return attachment(
          csv(
            MAILING_HEADERS,
            mailable.map((row) => {
              const from = provenanceOf(row, alerts.get(row.opportunity.alertId ?? "") ?? null);
              return [
                row.owner?.name,
                row.owner?.mailingAddress,
                row.owner?.mailingCity,
                row.owner?.mailingState,
                row.owner?.mailingZip,
                row.opportunity.propertyId,
                row.opportunity.addressLine,
                row.opportunity.stage,
                row.opportunity.matchScore,
                from.sourceSystem,
                from.pipelineRunId,
              ];
            }),
          ),
          `duval-mailing-list-${stamp}.csv`,
        );
      }

      return attachment(
        csv(
          OPPORTUNITY_HEADERS,
          rows.map((row) => {
            const from = provenanceOf(row, alerts.get(row.opportunity.alertId ?? "") ?? null);
            return [
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
              row.owner?.skipTrace?.email,
              row.owner?.skipTrace?.phone,
              row.owner?.skipTrace?.label,
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
              from.sourceSystem,
              from.sourceUrl,
              from.fetchedAt,
              from.pipelineRunId,
              from.alertId,
              from.matcherRunId,
            ];
          }),
        ),
        `duval-opportunities-${stamp}.csv`,
      );
    }

    return fail("invalid_request", "kind must be opportunities or mailing.", 400);
  } catch (error: unknown) {
    return handleError("GET /api/export", error);
  }
}
