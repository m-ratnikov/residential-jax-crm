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

import type { PropertyRecord, ScoreComponent } from "@/lib/data/types";
import { fingerprint } from "./hash";

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
  const material = MATERIAL_FIELDS.map((field) => `${field}=${String(property[field] ?? "")}`).join(
    "|",
  );
  return fingerprint(material);
}

/**
 * Which material fields differ between two snapshots. Used to tell the user
 * what moved, not just that something did.
 */
export function changedFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const changed: string[] = [];
  for (const field of MATERIAL_FIELDS) {
    const wasValue = before[field];
    const nowValue = after[field];
    // A field absent from the stored snapshot predates it being tracked.
    // Reporting it as changed would make every pass alert forever after.
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
 * How absent the absentee owner is. The score grades this rather than treating
 * every non-occupant the same, so the sentence has to say which one it saw.
 */
function absenteePhrase(property: PropertyRecord): string {
  switch (property.ownerRegionClass) {
    case "FOREIGN":
      return "absentee owner mailing from abroad";
    case "NATIONAL":
      return "absentee owner mailing from out of state";
    case "REGIONAL":
      return "absentee owner mailing from elsewhere in Florida";
    default:
      return "absentee owner";
  }
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
      if (property.ownerOccupied === false) signals.push(absenteePhrase(property));
      if (property.homesteadFlag === false) signals.push("no homestead exemption");
      const court = property.raw as Record<string, unknown>;
      const liens = Number(court["court_lien_count"] ?? 0);
      const foreclosures = Number(court["court_foreclosure_count"] ?? 0);
      const code = Number(court["court_code_enforcement_count"] ?? 0);
      if (liens > 0) signals.push(`${liens} recorded lien${liens === 1 ? "" : "s"}`);
      if (foreclosures > 0)
        signals.push(`${foreclosures} foreclosure filing${foreclosures === 1 ? "" : "s"}`);
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
      // The distance is the part that ranks, so it is the part that is quoted.
      const water =
        property.waterDistM === null ? "" : ` ${Math.round(property.waterDistM)} m from the water`;
      if (property.waterViewFlag && property.waterBodyName)
        signals.push(`water view of ${property.waterBodyName}${water}`);
      else if (property.waterViewFlag) signals.push(`water view${water}`);
      else if (property.waterDistM !== null)
        signals.push(`${Math.round(property.waterDistM)} m from the water`);
      if (property.nearestTransitStopM !== null)
        signals.push(
          `${Math.round(property.nearestTransitStopM)} m to ${property.nearestTransitStopName ?? "a transit stop"}`,
        );
      return signals.length ? signals.join(", ") : null;
    }
    default:
      return null;
  }
}

/**
 * Points, at the precision they were actually computed to.
 *
 * The contributions are rounded to a tenth upstream, and a reader checking the
 * rationale against the badge should be able to add them up and land on the
 * number. Printing 4.7 as "+5" three times over is how a 14 point score comes
 * to read as 15.
 */
function points(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function rationaleFor(
  property: PropertyRecord,
  components: readonly ScoreComponent[],
  unranked: boolean,
): string {
  if (unranked) {
    return "This criteria set has no ranking signals, so every match is scored equally: every criterion here is either unset, or is a filter every match already satisfies. Add a tenure, roof age, value or distress criterion that can vary to rank them.";
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
      ? `${evidence} (+${points(component.points)})`
      : `${component.label} (+${points(component.points)})`;
  });

  const missing = components.filter((component) => component.points === 0);
  const tail = missing.length
    ? ` No contribution from ${missing.map((component) => component.key).join(", ")}.`
    : "";

  // Deliberately not restated as a total. The badge beside this sentence is the
  // score, computed in SQL; adding up ten separately rounded contributions here
  // would sometimes print a number a point away from it, and a rationale that
  // disagrees with the badge is worse than one that does not mention it.
  return `${parts.join("; ")}.${tail}`;
}
