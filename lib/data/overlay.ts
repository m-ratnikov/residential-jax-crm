/**
 * The overlay: everything true about a parcel that is not in the published
 * parquet.
 *
 * Two things need to sit on top of the county roll and neither belongs in it:
 *
 * 1. **Court records.** Foreclosure filings, liens, probate and code
 *    enforcement arrive continuously and are small. Holding them in Postgres
 *    and joining at query time means a filing recorded a minute ago changes who
 *    matches a saved search immediately, without waiting for the six-hourly
 *    county export.
 *
 * 2. **Simulated pipeline updates.** The assignment asks for a demonstration of
 *    "a new or changed property matching the criteria". Rather than fake the
 *    notification, the demo writes a real row here - a value reassessed, a roof
 *    permit pulled, an owner changed - stamped with a synthetic run id. The
 *    matcher then detects it through exactly the same code path a real county
 *    refresh goes through. Nothing about the alert is special-cased.
 *
 * Both are expressed as one relation joined onto the parquet, so a query either
 * sees the overlay or it does not, and the criteria builder never has to know
 * which of the two put a row there.
 */

import { num, str, VIEW } from "@/lib/criteria/sql";

/** Roll columns the overlay may override. These are the fields the matcher fingerprints. */
export const OVERRIDABLE_COLUMNS = [
  "assessed_value",
  "market_value",
  "owner_name",
  "owner_occupied",
  "owner_mailing_address",
  "homestead_flag",
  "last_sale_date",
  "last_sale_price",
  "years_since_last_sale",
  "roof_year_est",
  "roof_age_years",
  "roof_age_basis",
  "permit_count",
  "roof_permit_count",
  "last_permit_date",
] as const;

export type OverridableColumn = (typeof OVERRIDABLE_COLUMNS)[number];

/** DuckDB types for the overlay relation, so an all-NULL column still binds. */
const OVERRIDE_TYPES: Record<OverridableColumn, string> = {
  assessed_value: "DOUBLE",
  market_value: "DOUBLE",
  owner_name: "VARCHAR",
  owner_occupied: "BOOLEAN",
  owner_mailing_address: "VARCHAR",
  homestead_flag: "BOOLEAN",
  last_sale_date: "VARCHAR",
  last_sale_price: "DOUBLE",
  years_since_last_sale: "INTEGER",
  roof_year_est: "INTEGER",
  roof_age_years: "INTEGER",
  roof_age_basis: "VARCHAR",
  permit_count: "BIGINT",
  roof_permit_count: "BIGINT",
  last_permit_date: "VARCHAR",
};

export const COURT_AGGREGATE_COLUMNS = [
  "court_lien_count",
  "court_foreclosure_count",
  "court_code_enforcement_count",
  "court_probate_count",
  "court_distress_score",
] as const;

export interface CourtAggregate {
  propertyId: string;
  lienCount: number;
  foreclosureCount: number;
  codeEnforcementCount: number;
  probateCount: number;
  /** 0..100, derived from the counts and recency. */
  distressScore: number;
  latestFilingDate: string | null;
}

export interface PropertyOverride {
  propertyId: string;
  /** Column values that replace the published ones. */
  values: Partial<Record<OverridableColumn, string | number | boolean | null>>;
  /** The synthetic or real run that introduced this change. */
  runId: string;
}

export interface Overlay {
  court: readonly CourtAggregate[];
  overrides: readonly PropertyOverride[];
}

export const EMPTY_OVERLAY: Overlay = { court: [], overrides: [] };

export function isEmptyOverlay(overlay: Overlay): boolean {
  return overlay.court.length === 0 && overlay.overrides.length === 0;
}

function literal(value: string | number | boolean | null, type: string): string {
  if (value === null || value === undefined) return `CAST(NULL AS ${type})`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return `CAST(${num(value)} AS ${type})`;
  return `CAST(${str(String(value))} AS ${type})`;
}

export interface BuiltOverlay {
  /** A `WITH ... ` prefix, or "" when there is no overlay. */
  prefix: string;
  /** The relation the criteria SQL selects FROM. */
  from: string;
  /** True when court columns exist on the relation. */
  courtAvailable: boolean;
}

/**
 * Build the relation the rest of the query reads.
 *
 * With no overlay the parquet view is used directly, so the common case costs
 * nothing. With one, the overlay is inlined as a VALUES list: the sets involved
 * are court-flagged parcels and hand-made simulations, which are hundreds to
 * low thousands of rows, not the whole county.
 */
export function buildOverlay(overlay: Overlay): BuiltOverlay {
  if (isEmptyOverlay(overlay)) {
    return { prefix: "", from: VIEW, courtAvailable: false };
  }

  const byProperty = new Map<
    string,
    { court: CourtAggregate | null; override: PropertyOverride | null }
  >();
  for (const court of overlay.court) {
    byProperty.set(court.propertyId, { court, override: null });
  }
  for (const override of overlay.overrides) {
    const existing = byProperty.get(override.propertyId);
    if (existing) existing.override = override;
    else byProperty.set(override.propertyId, { court: null, override });
  }

  const overrideColumns = OVERRIDABLE_COLUMNS;
  const rows: string[] = [];
  for (const [propertyId, entry] of byProperty) {
    const cells: string[] = [str(propertyId)];
    for (const column of overrideColumns) {
      const value = entry.override?.values[column];
      cells.push(literal(value === undefined ? null : value, OVERRIDE_TYPES[column]));
    }
    cells.push(literal(entry.court?.lienCount ?? 0, "BIGINT"));
    cells.push(literal(entry.court?.foreclosureCount ?? 0, "BIGINT"));
    cells.push(literal(entry.court?.codeEnforcementCount ?? 0, "BIGINT"));
    cells.push(literal(entry.court?.probateCount ?? 0, "BIGINT"));
    cells.push(literal(entry.court?.distressScore ?? 0, "DOUBLE"));
    cells.push(literal(entry.court?.latestFilingDate ?? null, "VARCHAR"));
    cells.push(literal(entry.override?.runId ?? null, "VARCHAR"));
    rows.push(`(${cells.join(", ")})`);
  }

  const overlayColumns = [
    "property_id",
    ...overrideColumns.map((column) => `ov_${column}`),
    ...COURT_AGGREGATE_COLUMNS,
    "court_latest_filing_date",
    "overlay_run_id",
  ];

  // Every published column survives; the overridable ones are replaced when the
  // overlay has a value, using EXCLUDE so a new pipeline column needs no change
  // here.
  const replacements = overrideColumns
    .map((column) => `coalesce(o.ov_${column}, b.${column}) AS ${column}`)
    .join(",\n      ");

  const courtSelect = [...COURT_AGGREGATE_COLUMNS, "court_latest_filing_date", "overlay_run_id"]
    .map((column) => `o.${column}`)
    .join(", ");

  const prefix = `WITH overlay(${overlayColumns.join(", ")}) AS (
    VALUES
      ${rows.join(",\n      ")}
  ),
  overlaid AS (
    SELECT
      b.* EXCLUDE (${overrideColumns.join(", ")}),
      ${replacements},
      ${courtSelect}
    FROM ${VIEW} b
    LEFT JOIN overlay o ON o.property_id = b.property_id
  )
  `;

  return { prefix, from: "overlaid", courtAvailable: true };
}

/**
 * Court distress score. Weighted by how serious a filing is and how recent it
 * is: a foreclosure filed last month says far more about a seller's motivation
 * than a code case from four years ago.
 */
export function courtDistressScore(
  input: {
    lienCount: number;
    foreclosureCount: number;
    codeEnforcementCount: number;
    probateCount: number;
    latestFilingDate: string | null;
  },
  now: Date = new Date(),
): number {
  const weighted =
    input.foreclosureCount * 40 +
    input.lienCount * 20 +
    input.probateCount * 20 +
    input.codeEnforcementCount * 10;
  if (weighted === 0) return 0;

  let recency = 0.5;
  if (input.latestFilingDate) {
    const filed = new Date(input.latestFilingDate);
    if (!Number.isNaN(filed.getTime())) {
      const months = (now.getTime() - filed.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      // Full weight inside a year, decaying to a floor of 0.3 by four years.
      recency = months <= 12 ? 1 : Math.max(0.3, 1 - (months - 12) / 36);
    }
  }

  return Math.round(Math.min(100, weighted * recency));
}
