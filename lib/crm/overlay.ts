/**
 * Assembling the query overlay from the CRM store.
 *
 * Two sources feed it: court filings, which are real records ingested
 * continuously, and simulated pipeline changes, which are the demo's way of
 * producing a genuine data movement rather than a staged notification. Both end
 * up in the same relation, so the criteria builder cannot tell them apart and
 * nothing about the alert path is special-cased for the demo.
 *
 * Without a CRM store there is no overlay, and court-derived criteria are
 * disabled in the filter panel rather than quietly matching nothing.
 */

import { sql } from "drizzle-orm";

import {
  courtDistressScore,
  EMPTY_OVERLAY,
  OVERRIDABLE_COLUMNS,
  type CourtAggregate,
  type OverridableColumn,
  type Overlay,
  type PropertyOverride,
} from "@/lib/data/overlay";
import { tryDb } from "./db";

const OVERRIDABLE = new Set<string>(OVERRIDABLE_COLUMNS);

/** Columns whose overlay values are numbers, so a stored string is cast back. */
const NUMERIC_COLUMNS = new Set<OverridableColumn>([
  "assessed_value",
  "market_value",
  "last_sale_price",
  "years_since_last_sale",
  "roof_year_est",
  "roof_age_years",
  "permit_count",
  "roof_permit_count",
]);

const BOOLEAN_COLUMNS = new Set<OverridableColumn>(["owner_occupied", "homestead_flag"]);

function parseValue(
  column: OverridableColumn,
  raw: string | null,
): string | number | boolean | null {
  if (raw === null) return null;
  if (NUMERIC_COLUMNS.has(column)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (BOOLEAN_COLUMNS.has(column)) return raw === "true" || raw === "t" || raw === "1";
  return raw;
}

export interface OverlaySummary {
  overlay: Overlay;
  /** True when court predicates can be evaluated at all. */
  courtDataAvailable: boolean;
  courtPropertyCount: number;
  simulatedPropertyCount: number;
  /** Distinct synthetic run ids currently applied. */
  simulatedRunIds: string[];
}

export const EMPTY_OVERLAY_SUMMARY: OverlaySummary = {
  overlay: EMPTY_OVERLAY,
  courtDataAvailable: false,
  courtPropertyCount: 0,
  simulatedPropertyCount: 0,
  simulatedRunIds: [],
};

/**
 * Read both overlay sources in one round trip each.
 *
 * The aggregation is done in Postgres rather than in TypeScript because the
 * court table grows with filings while the aggregate stays one row per parcel,
 * and it is the aggregate the query needs.
 */
export async function loadOverlay(): Promise<OverlaySummary> {
  const database = tryDb();
  if (!database) return EMPTY_OVERLAY_SUMMARY;

  const [courtRows, simulatedRows] = await Promise.all([
    database.execute(sql`
      SELECT
        property_id,
        count(*) FILTER (WHERE case_type = 'lien')             AS lien_count,
        count(*) FILTER (WHERE case_type = 'foreclosure')      AS foreclosure_count,
        count(*) FILTER (WHERE case_type = 'code_enforcement') AS code_enforcement_count,
        count(*) FILTER (WHERE case_type = 'probate')          AS probate_count,
        max(filed_date)                                        AS latest_filed
      FROM court_records
      WHERE property_id IS NOT NULL
        AND coalesce(status, '') NOT IN ('dismissed', 'satisfied', 'closed')
      GROUP BY property_id
    `),
    database.execute(sql`
      SELECT property_id, run_id, "column", value
      FROM simulated_changes
      ORDER BY created_at
    `),
  ]);

  const court: CourtAggregate[] = [];
  for (const row of asRows(courtRows)) {
    const propertyId = String(row["property_id"] ?? "");
    if (!propertyId) continue;
    const latest = row["latest_filed"];
    const latestFilingDate =
      latest instanceof Date
        ? latest.toISOString().slice(0, 10)
        : latest
          ? String(latest).slice(0, 10)
          : null;
    const counts = {
      lienCount: Number(row["lien_count"] ?? 0),
      foreclosureCount: Number(row["foreclosure_count"] ?? 0),
      codeEnforcementCount: Number(row["code_enforcement_count"] ?? 0),
      probateCount: Number(row["probate_count"] ?? 0),
      latestFilingDate,
    };
    court.push({
      propertyId,
      ...counts,
      distressScore: courtDistressScore(counts),
    });
  }

  const byProperty = new Map<string, PropertyOverride>();
  for (const row of asRows(simulatedRows)) {
    const propertyId = String(row["property_id"] ?? "");
    const column = String(row["column"] ?? "");
    if (!propertyId || !OVERRIDABLE.has(column)) continue;
    const typed = column as OverridableColumn;
    const existing = byProperty.get(propertyId) ?? {
      propertyId,
      values: {},
      runId: String(row["run_id"] ?? ""),
    };
    existing.values[typed] = parseValue(typed, row["value"] === null ? null : String(row["value"]));
    existing.runId = String(row["run_id"] ?? existing.runId);
    byProperty.set(propertyId, existing);
  }

  const overrides = [...byProperty.values()];

  return {
    overlay: { court, overrides },
    // Court predicates are available whenever a store is attached, even with no
    // filings yet: "no liens recorded" is a real answer, and the alternative is
    // a filter that appears and disappears as data arrives.
    courtDataAvailable: true,
    courtPropertyCount: court.length,
    simulatedPropertyCount: overrides.length,
    simulatedRunIds: [...new Set(overrides.map((entry) => entry.runId).filter(Boolean))],
  };
}

/** Drizzle's execute() returns different shapes per driver; normalise to rows. */
function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}
