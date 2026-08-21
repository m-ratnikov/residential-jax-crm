/**
 * What an acquisitions team means by "a property I want".
 *
 * A criteria set is data, not code: it is validated by zod, stored as jsonb on
 * a saved search, posted from the filter panel, produced by the agent from a
 * sentence, and replayed by the scheduled matcher hours later. The same object
 * has to survive all four, so it is a plain serialisable shape with no
 * functions, no dates and no undefined-versus-null ambiguity.
 */

import { z } from "zod";

/** A circle drawn on the map. Radius in metres. */
export const circleSchema = z.object({
  type: z.literal("circle"),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().positive().max(80_000),
});

/** A polygon drawn on the map. Ring is [lng, lat] pairs, unclosed. */
export const polygonSchema = z.object({
  type: z.literal("polygon"),
  ring: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3)
    .max(200),
});

/** The current map viewport. */
export const bboxSchema = z.object({
  type: z.literal("bbox"),
  west: z.number(),
  south: z.number(),
  east: z.number(),
  north: z.number(),
});

export const geometrySchema = z.discriminatedUnion("type", [
  circleSchema,
  polygonSchema,
  bboxSchema,
]);

export type Geometry = z.infer<typeof geometrySchema>;

/**
 * Distress signals. `court` entries are only meaningful when a court data
 * source has been loaded; the filter panel disables them and says why when it
 * has not, rather than silently returning nothing.
 */
export const distressSchema = z.object({
  /** At least one open lien recorded against the parcel. */
  hasLien: z.boolean().optional(),
  /** A foreclosure case filed against the parcel or its owner. */
  hasForeclosure: z.boolean().optional(),
  /** An open code enforcement case. */
  hasCodeEnforcement: z.boolean().optional(),
  /** A probate case naming the owner of record. */
  hasProbate: z.boolean().optional(),
  /** Owner mails somewhere other than the property. A classic absentee signal. */
  absenteeOwner: z.boolean().optional(),
  /** No homestead exemption on a residential parcel. */
  noHomestead: z.boolean().optional(),
  /** Minimum court-derived distress score, 0..100. */
  minCourtScore: z.number().min(0).max(100).optional(),
});

export const filtersSchema = z.object({
  // Ownership tenure
  minYearsSinceSale: z.number().min(0).max(120).optional(),
  maxYearsSinceSale: z.number().min(0).max(120).optional(),

  // Roof
  minRoofAge: z.number().min(0).max(150).optional(),
  maxRoofAge: z.number().min(0).max(150).optional(),
  /**
   * When true, only accept a roof age with real evidence behind it (a re-roof
   * permit or an appraiser roof field), never the year-built proxy. The roof
   * question is the one most likely to be wrong, so the option to demand
   * evidence is a first class filter rather than a footnote.
   */
  requireRoofEvidence: z.boolean().optional(),

  // Structure
  minBuiltYear: z.number().min(1700).max(2100).optional(),
  maxBuiltYear: z.number().min(1700).max(2100).optional(),
  minLivableArea: z.number().min(0).optional(),
  maxLivableArea: z.number().min(0).optional(),

  // Value
  minAssessedValue: z.number().min(0).optional(),
  maxAssessedValue: z.number().min(0).optional(),
  minMarketValue: z.number().min(0).optional(),
  maxMarketValue: z.number().min(0).optional(),

  // Classification
  propertyTypes: z.array(z.string()).max(40).optional(),
  /** Residential only. On by default for an acquisitions CRM. */
  residentialOnly: z.boolean().optional(),

  // Geography
  cities: z.array(z.string()).max(60).optional(),
  zips: z.array(z.string()).max(120).optional(),
  subdivisions: z.array(z.string()).max(60).optional(),
  geometry: geometrySchema.optional(),

  // Ownership character
  ownerRegionClasses: z.array(z.string()).max(10).optional(),
  ownerOccupied: z.boolean().optional(),

  // Amenity signals published by the pipeline
  waterView: z.boolean().optional(),
  maxWaterDistanceM: z.number().min(0).optional(),
  maxTransitDistanceM: z.number().min(0).optional(),

  // Permits
  hasPermits: z.boolean().optional(),
  minPermitCount: z.number().min(0).optional(),

  distress: distressSchema.optional(),
});

export type Filters = z.infer<typeof filtersSchema>;

/**
 * How much each signal is worth in the 0..100 match score. Weights are
 * relative: they are normalised before scoring, so a user can type 3 and 1
 * without having to make them sum to anything.
 */
export const weightsSchema = z.object({
  tenure: z.number().min(0).max(10).default(3),
  roofAge: z.number().min(0).max(10).default(3),
  distress: z.number().min(0).max(10).default(2),
  value: z.number().min(0).max(10).default(1),
  geography: z.number().min(0).max(10).default(1),
  amenity: z.number().min(0).max(10).default(1),
});

export type Weights = z.infer<typeof weightsSchema>;

export const DEFAULT_WEIGHTS: Weights = {
  tenure: 3,
  roofAge: 3,
  distress: 2,
  value: 1,
  geography: 1,
  amenity: 1,
};

export const criteriaSetSchema = z.object({
  /** Stable id when saved; absent for an ad hoc search. */
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  filters: filtersSchema,
  weights: weightsSchema.default(DEFAULT_WEIGHTS),
});

export type CriteriaSet = z.infer<typeof criteriaSetSchema>;

/** An empty criteria set, used as the starting point in the filter panel. */
export const EMPTY_CRITERIA: CriteriaSet = {
  name: "Untitled search",
  filters: { residentialOnly: true },
  weights: DEFAULT_WEIGHTS,
};

/**
 * The starting points offered in the UI. Each one is a real acquisition thesis,
 * not a demo fixture, and each states the threshold it uses so a reader can
 * argue with it.
 */
export interface CriteriaPreset {
  id: string;
  name: string;
  description: string;
  criteria: CriteriaSet;
}

export const CRITERIA_PRESETS: CriteriaPreset[] = [
  {
    id: "tired-landlord",
    name: "Tired landlord",
    description:
      "Absentee owner, held ten years or more, roof past fifteen years, no homestead exemption. The classic wholesale target.",
    criteria: {
      name: "Tired landlord",
      filters: {
        residentialOnly: true,
        minYearsSinceSale: 10,
        minRoofAge: 15,
        distress: { absenteeOwner: true, noHomestead: true },
      },
      weights: { tenure: 3, roofAge: 3, distress: 3, value: 1, geography: 0, amenity: 0 },
    },
  },
  {
    id: "aging-roof-value-band",
    name: "Aging roof, entry price band",
    description:
      "Roof older than twenty years with an assessed value between 80k and 250k. Rehab candidates that still pencil.",
    criteria: {
      name: "Aging roof, entry price band",
      filters: {
        residentialOnly: true,
        minRoofAge: 20,
        minAssessedValue: 80_000,
        maxAssessedValue: 250_000,
      },
      weights: { tenure: 1, roofAge: 3, distress: 1, value: 3, geography: 0, amenity: 0 },
    },
  },
  {
    id: "waterfront-hold",
    name: "Waterfront long hold",
    description:
      "Water view, held fifteen years or more. Owners with equity and a reason to consider an offer.",
    criteria: {
      name: "Waterfront long hold",
      filters: { residentialOnly: true, waterView: true, minYearsSinceSale: 15 },
      weights: { tenure: 3, roofAge: 1, distress: 1, value: 1, geography: 0, amenity: 3 },
    },
  },
  {
    id: "distressed-court",
    name: "Court distress",
    description:
      "Any recorded lien, foreclosure or code enforcement action. Requires a court data source; the panel says so when none is loaded.",
    criteria: {
      name: "Court distress",
      filters: {
        residentialOnly: true,
        distress: { hasLien: true, hasForeclosure: true, hasCodeEnforcement: true },
      },
      weights: { tenure: 1, roofAge: 1, distress: 5, value: 1, geography: 0, amenity: 0 },
    },
  },
  {
    id: "transit-infill",
    name: "Transit infill",
    description:
      "Within 800 m of a JTA stop, built before 1990, held ten years or more. Rental demand near transit.",
    criteria: {
      name: "Transit infill",
      filters: {
        residentialOnly: true,
        maxTransitDistanceM: 800,
        maxBuiltYear: 1990,
        minYearsSinceSale: 10,
      },
      weights: { tenure: 2, roofAge: 2, distress: 1, value: 1, geography: 1, amenity: 3 },
    },
  },
];
