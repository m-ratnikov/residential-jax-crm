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

import { materialSnapshot, tenureCaveat } from "@/lib/criteria/score";
import { tenureConfidenceOf } from "@/lib/criteria/sql";
import { displayAddress } from "@/lib/data/map";
import type { ScoredProperty } from "@/lib/data/types";

/**
 * A compact record of the parcel as it looked when the alert fired.
 *
 * This is NOT the change detection fingerprint. `matchHashOf` and
 * `changedFields` read `MATERIAL_FIELDS` off the `PropertyRecord`, and
 * `materialSnapshot` builds the record they diff; neither of them ever sees
 * this object. That separation is what makes it safe to add a field here: no
 * fingerprinted value moves, so no stored snapshot is invalidated and the next
 * pass does not alert on every watched parcel. test/change-detection.test.ts
 * pins that empirically rather than by assertion.
 */
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
    // The roll carries placeholder sale dates - 1899-12-30 on 842 parcels,
    // 1899-01-01 on 609 - which produce tenures like "held 127 years" on a
    // house built in 1986. The search list, the parcel drawer and the CSV all
    // carry the guard's verdict beside the number. The alert did not, so it
    // could print "Held: 127 years" in a structured field directly above a
    // rationale paragraph saying the tenure is unknown.
    //
    // Not re-derived here: `tenureConfidenceOf` and `tenureCaveat` are the same
    // functions every other surface calls, and the SQL twin of the first is
    // pinned to it row for row by test/criteria-sql.test.ts. A second copy of
    // the rule is a second answer to the same question.
    builtYear: property.builtYear,
    tenureConfidence: tenureConfidenceOf(property),
    tenureCaveat: tenureCaveat(property),
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
