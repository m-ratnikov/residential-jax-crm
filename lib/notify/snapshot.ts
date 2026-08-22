/**
 * The shape a matched parcel takes when it is handed to the evaluator, in a
 * module with no server imports.
 *
 * Same reason `limits.ts` exists: the natural home is `matcher.ts`, but that
 * module reaches `@/lib/crm/overlay` and `@/lib/crm/repo`, so the browser
 * matcher cannot import from it and kept a private copy of both functions
 * instead. Two copies of the field list is the failure that matters here - an
 * alert raised in the tab and an alert raised by the cron are supposed to be
 * the same record, and a field added to one copy and not the other makes them
 * quietly different. Defining them once, where both can reach them, is what
 * keeps that promise true.
 */

import { materialSnapshot } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import type { ScoredProperty } from "@/lib/data/types";

/** A compact record of the parcel as it looked when the alert fired. */
export function alertSnapshot(scored: ScoredProperty): Record<string, unknown> {
  const property = scored.property;
  return {
    propertyId: property.propertyId,
    address: displayAddress(property),
    addressCity: property.addressCity,
    addressZip: property.addressZip,
    latitude: property.latitude,
    longitude: property.longitude,
    ownerName: property.ownerName,
    assessedValue: property.assessedValue,
    roofAgeYears: property.roofAgeYears,
    roofAgeBasis: property.roofAgeBasis,
    yearsSinceLastSale: property.yearsSinceLastSale,
    lastSaleDate: property.lastSaleDate,
    ownerOccupied: property.ownerOccupied,
    homesteadFlag: property.homesteadFlag,
    waterViewFlag: property.waterViewFlag,
    courtDistressScore: property.raw["court_distress_score"] ?? null,
    provenance: property.provenance,
  };
}

/** Turn a scored row into the shape the shared evaluator consumes. */
export function toEvaluatedMatch(scored: ScoredProperty) {
  return {
    propertyId: scored.property.propertyId,
    matchHash: scored.matchHash,
    snapshot: materialSnapshot(scored.property),
    score: scored.score,
    rationale: scored.rationale,
    propertySnapshot: alertSnapshot(scored),
  };
}
