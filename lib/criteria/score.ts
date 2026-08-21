/**
 * Turning a score into a sentence, and a property into a fingerprint.
 *
 * The story asks for "clear ranking or match-score rationale", which means the
 * number has to be arguable. `rationaleFor` says which signals contributed and
 * how much, using the values actually on the row rather than restating the
 * filter.
 *
 * `matchHashOf` is the other half of the notification story. The scheduled
 * matcher cannot ask the parquet "what changed", because the published run id
 * is uniform across every row: it identifies the export, not the last touch on
 * a parcel. So the CRM keeps the fingerprint of every property it has already
 * alerted on, and a changed fingerprint is what "this parcel changed underneath
 * you" means here. Only fields an acquisitions team would act on take part; a
 * re-export that moves nothing material raises no alerts.
 */

import { createHash } from "node:crypto";

import type { PropertyRecord, ScoreComponent } from "@/lib/data/types";

/** The fields whose movement is worth waking someone up for. */
export const MATERIAL_FIELDS = [
  "ownerName",
  "ownerOccupied",
  "ownerMailingAddress",
  "assessedValue",
  "marketValue",
  "lastSaleDate",
  "lastSalePrice",
  "yearsSinceLastSale",
  "roofYearEst",
  "roofAgeYears",
  "roofAgeBasis",
  "permitCount",
  "roofPermitCount",
  "lastPermitDate",
  "homesteadFlag",
  "waterViewFlag",
] as const satisfies readonly (keyof PropertyRecord)[];

export function matchHashOf(property: PropertyRecord): string {
  const material = MATERIAL_FIELDS.map((field) => `${field}=${String(property[field] ?? "")}`).join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Which material fields differ between two snapshots. Used to tell the user
 * what moved, not just that something did.
 */
export function changedFields(
  before: Readonly<Record<string, unknown>>,
  after: PropertyRecord,
): string[] {
  const changed: string[] = [];
  for (const field of MATERIAL_FIELDS) {
    const wasValue = before[field];
    const nowValue = after[field];
    if (wasValue === undefined) continue;
    if (String(wasValue ?? "") !== String(nowValue ?? "")) changed.push(field);
  }
  return changed;
}

/** The subset of a record the matcher stores so it can diff next time. */
export function materialSnapshot(property: PropertyRecord): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of MATERIAL_FIELDS) snapshot[field] = property[field] ?? null;
  return snapshot;
}

const HUMAN_FIELD: Record<string, string> = {
  ownerName: "owner of record",
  ownerOccupied: "owner occupancy",
  ownerMailingAddress: "owner mailing address",
  assessedValue: "assessed value",
  marketValue: "market value",
  lastSaleDate: "last sale date",
  lastSalePrice: "last sale price",
  yearsSinceLastSale: "ownership tenure",
  roofYearEst: "estimated roof year",
  roofAgeYears: "roof age",
  roofAgeBasis: "roof age evidence",
  permitCount: "permit count",
  roofPermitCount: "roof permit count",
  lastPermitDate: "last permit date",
  homesteadFlag: "homestead exemption",
  waterViewFlag: "water view",
};

export function humanField(field: string): string {
  return HUMAN_FIELD[field] ?? field;
}

/**
 * The evidence behind a component, read off the row. This is what makes the
 * rationale worth reading: "roof 34 years old" rather than "roof criterion met".
 */
function evidenceFor(key: string, property: PropertyRecord): string | null {
  switch (key) {
    case "tenure": {
      if (property.yearsSinceLastSale === null) return null;
      const sold = property.lastSaleDate ? ` (last sale ${property.lastSaleDate})` : "";
      return `held ${property.yearsSinceLastSale} years${sold}`;
    }
    case "roofAge": {
      if (property.roofAgeYears === null) return null;
      const basis = property.roofAgeBasis?.includes("PROXY")
        ? ", estimated from year built"
        : property.roofAgeBasis
          ? `, from ${property.roofAgeBasis.toLowerCase()}`
          : "";
      return `roof about ${property.roofAgeYears} years old${basis}`;
    }
    case "distress": {
      const signals: string[] = [];
      if (property.ownerOccupied === false) signals.push("absentee owner");
      if (property.homesteadFlag === false) signals.push("no homestead exemption");
      const court = property.raw as Record<string, unknown>;
      const liens = Number(court["court_lien_count"] ?? 0);
      const foreclosures = Number(court["court_foreclosure_count"] ?? 0);
      const code = Number(court["court_code_enforcement_count"] ?? 0);
      if (liens > 0) signals.push(`${liens} recorded lien${liens === 1 ? "" : "s"}`);
      if (foreclosures > 0) signals.push(`${foreclosures} foreclosure filing${foreclosures === 1 ? "" : "s"}`);
      if (code > 0) signals.push(`${code} code enforcement case${code === 1 ? "" : "s"}`);
      return signals.length ? signals.join(", ") : null;
    }
    case "value":
      return property.assessedValue === null
        ? null
        : `assessed at $${Math.round(property.assessedValue).toLocaleString("en-US")}`;
    case "geography":
      return property.addressCity ? `in ${property.addressCity}` : null;
    case "amenity": {
      const signals: string[] = [];
      if (property.waterViewFlag && property.waterBodyName)
        signals.push(`water view of ${property.waterBodyName}`);
      else if (property.waterViewFlag) signals.push("water view");
      if (property.nearestTransitStopM !== null)
        signals.push(`${Math.round(property.nearestTransitStopM)} m to ${property.nearestTransitStopName ?? "a transit stop"}`);
      return signals.length ? signals.join(", ") : null;
    }
    default:
      return null;
  }
}

export function rationaleFor(
  property: PropertyRecord,
  components: readonly ScoreComponent[],
  unranked: boolean,
): string {
  if (unranked) {
    return "This criteria set has no ranking signals, so every match is scored equally. Add a tenure, roof age, distress or value criterion to rank them.";
  }

  const contributing = [...components]
    .filter((component) => component.points > 0)
    .sort((a, b) => b.points - a.points);

  if (!contributing.length) {
    return "Matches the filters, but none of the weighted signals contributed: the underlying values are missing on this parcel.";
  }

  const parts = contributing.map((component) => {
    const evidence = evidenceFor(component.key, property);
    return evidence
      ? `${evidence} (+${component.points.toFixed(0)})`
      : `${component.label} (+${component.points.toFixed(0)})`;
  });

  const missing = components.filter((component) => component.points === 0);
  const tail = missing.length
    ? ` No contribution from ${missing.map((component) => component.key).join(", ")}.`
    : "";

  return `${parts.join("; ")}.${tail}`;
}
