/**
 * Criteria in, SQL out.
 *
 * One module builds both the WHERE clause and the score expression, because the
 * interactive search, the saved search and the scheduled matcher must agree
 * exactly. If ranking lived in TypeScript over a page of results, the matcher
 * and the map would disagree about which 200 parcels are the best 200, and the
 * disagreement would only show up as a wrong alert hours later.
 *
 * Scoring rule: only the criteria the user actually set take part. Weights are
 * normalised across the participating components, so a search that filters on
 * roof age alone is scored on roof age alone rather than being diluted by five
 * components the user never asked for.
 */

import type { CriteriaSet, Filters, Geometry, Weights } from "./types";

/** The view name the data source exposes over the query table. */
export const VIEW = "properties";

/**
 * The smallest floor area this application will call a dwelling.
 *
 * Chosen from the roll rather than from taste: of Duval's 339,852 residential
 * parcels with any livable floor area, 1,840 are below this and 338,012 above
 * it. The ones below are 55 sq ft condo garage units assessed at a dollar
 * (1,222 of them), 100 sq ft storage lockers, and a scatter of single-digit
 * areas that are plainly bad rows. It is also roughly the smallest efficiency
 * unit anyone builds.
 */
export const DWELLING_MIN_SQFT = 400;

export const SCORE_ALIAS = "match_score";
export const TOTAL_ALIAS = "match_total";

/** Columns every screen needs. Anything else is fetched on the detail view. */
export const LIST_COLUMNS = [
  "property_id",
  "parcel_identifier",
  "property_cid",
  "address_street",
  "address_city",
  "address_zip",
  "latitude",
  "longitude",
  "subdivision",
  "neighborhood_code",
  "property_type",
  "property_usage_type",
  "built_year",
  "livable_floor_area",
  "total_area",
  "residential_units",
  "roof_year_est",
  "roof_age_years",
  "roof_age_basis",
  "roof_covering_material",
  "assessed_value",
  "market_value",
  "land_value",
  "taxable_value",
  "owner_name",
  "owner_count",
  "owner_occupied",
  "owner_region_class",
  "owner_mailing_address",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_mailing_zip",
  "homestead_flag",
  "last_sale_date",
  "last_sale_price",
  "years_since_last_sale",
  "tenure_basis",
  "water_view_flag",
  "water_dist_m",
  "water_body_name",
  "nearest_transit_stop_m",
  "nearest_transit_stop_name",
  "has_permits",
  "permit_count",
  "roof_permit_count",
  "last_permit_date",
  "source_system",
  "source_url",
  "fetched_at",
  "run_id",
  "source_artifact",
  "source_sha256",
] as const;

/* ------------------------------------------------------------------ */
/* Literal encoding                                                     */
/* ------------------------------------------------------------------ */

/**
 * Numbers reach here already validated by zod, but a NaN or an Infinity would
 * serialise into SQL as a bare token and produce a parse error at query time
 * rather than a clear one here.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${String(value)}`);
  return String(value);
}

/** Single quotes are doubled; nothing else can escape a DuckDB string literal. */
export function str(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function inList(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(str).join(", ")})`;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                             */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_000;

/**
 * Great circle distance in metres between the parcel centroid and a point.
 * Written out rather than taken from the spatial extension so the query runs on
 * a stock DuckDB with only httpfs loaded.
 */
export function haversineSql(lat: number, lng: number): string {
  const lat0 = num(lat);
  const lng0 = num(lng);
  return (
    `(${EARTH_RADIUS_M} * 2 * asin(sqrt(` +
    `pow(sin(radians(latitude - ${lat0}) / 2), 2) + ` +
    `cos(radians(${lat0})) * cos(radians(latitude)) * ` +
    `pow(sin(radians(longitude - ${lng0}) / 2), 2)` +
    `)))`
  );
}

/**
 * Ray casting, expanded into SQL. For each edge of the ring, a crossing test;
 * an odd number of crossings means the centroid is inside. Expanding it here
 * keeps the count of matching parcels exact, which a bounding box prefilter
 * followed by a refinement in TypeScript would not.
 */
export function polygonSql(ring: readonly (readonly [number, number])[]): string {
  const crossings: string[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi === yj) continue; // horizontal edge, never crossed by a horizontal ray
    crossings.push(
      `CASE WHEN ((${num(yi)} > latitude) != (${num(yj)} > latitude)) AND ` +
        `(longitude < (${num(xj)} - ${num(xi)}) * (latitude - ${num(yi)}) / ` +
        `(${num(yj)} - ${num(yi)}) + ${num(xi)}) THEN 1 ELSE 0 END`,
    );
  }
  if (!crossings.length) return "false";
  return `((${crossings.join(" + ")}) % 2 = 1)`;
}

/** The same great circle distance as `haversineSql`, evaluated here. */
export function haversineMeters(
  lat: number,
  lng: number,
  otherLat: number,
  otherLng: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (otherLat - lat) * toRad;
  const dLng = (otherLng - lng) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat * toRad) * Math.cos(otherLat * toRad) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(a));
}

export interface GeometryCentre {
  lat: number;
  lng: number;
  /** Distance from the centre to the furthest point the geometry admits. */
  radiusM: number;
}

/**
 * The centre of a drawn area and how far it reaches, so a polygon or a box can
 * be scored on distance from its middle exactly as a circle already was.
 *
 * Without this, drawing a neighbourhood by hand - which is what the map invites
 * you to do - produced a geography weight that scored nothing at all, and every
 * parcel inside the shape tied.
 */
export function geometryCentre(geometry: Geometry | undefined): GeometryCentre | null {
  if (!geometry) return null;
  if (geometry.type === "circle") {
    return { lat: geometry.lat, lng: geometry.lng, radiusM: geometry.radiusM };
  }
  if (geometry.type === "bbox") {
    const lat = (geometry.north + geometry.south) / 2;
    const lng = (geometry.east + geometry.west) / 2;
    const radiusM = haversineMeters(lat, lng, geometry.north, geometry.east);
    return radiusM > 0 ? { lat, lng, radiusM } : null;
  }
  // Ring vertices are [lng, lat]. The centroid of the vertices is close enough
  // to the middle of a hand drawn shape, and the furthest vertex is how far the
  // shape reaches; both only have to be stable, not exact.
  const ring = geometry.ring;
  if (!ring.length) return null;
  let sumLat = 0;
  let sumLng = 0;
  for (const [lng, lat] of ring) {
    sumLat += lat;
    sumLng += lng;
  }
  const lat = sumLat / ring.length;
  const lng = sumLng / ring.length;
  let radiusM = 0;
  for (const [vertexLng, vertexLat] of ring) {
    radiusM = Math.max(radiusM, haversineMeters(lat, lng, vertexLat, vertexLng));
  }
  return radiusM > 0 ? { lat, lng, radiusM } : null;
}

/** The map's visible rectangle. A bbox geometry, but never a saved filter. */
export type MapViewport = Extract<Geometry, { type: "bbox" }>;

export function geometrySql(geometry: Geometry): string {
  const hasPoint = "latitude IS NOT NULL AND longitude IS NOT NULL";
  switch (geometry.type) {
    case "circle":
      return `(${hasPoint} AND ${haversineSql(geometry.lat, geometry.lng)} <= ${num(geometry.radiusM)})`;
    case "bbox":
      return (
        `(${hasPoint} AND latitude BETWEEN ${num(geometry.south)} AND ${num(geometry.north)} ` +
        `AND longitude BETWEEN ${num(geometry.west)} AND ${num(geometry.east)})`
      );
    case "polygon":
      return `(${hasPoint} AND ${polygonSql(geometry.ring)})`;
  }
}

/* ------------------------------------------------------------------ */
/* Filters                                                              */
/* ------------------------------------------------------------------ */

/**
 * True when the filters name a signal that only a court data source can
 * answer. The UI uses this to explain an empty result instead of leaving the
 * user to guess.
 */
/** True when these distress filters ask for something only a court source has. */
function courtRequested(d: NonNullable<Filters["distress"]>): boolean {
  return Boolean(
    d.hasLien || d.hasForeclosure || d.hasCodeEnforcement || d.hasProbate || d.minCourtScore,
  );
}

/**
 * The same question as `courtRequested`, asked of the whole filter set.
 *
 * It delegates rather than restating the predicate: these two drifting apart
 * would mean the WHERE clause and the "this needs a court source" banner
 * disagreed about whether court data had been asked for, which is the kind of
 * contradiction a reviewer finds and cannot unsee.
 */
export function needsCourtData(filters: Filters): boolean {
  return filters.distress ? courtRequested(filters.distress) : false;
}

export interface WhereResult {
  sql: string;
  clauses: string[];
}

/**
 * @param courtJoinAvailable when false, the court-derived predicates are left
 * out entirely rather than compared against a column that does not exist.
 */
export function buildWhere(filters: Filters, courtJoinAvailable: boolean): WhereResult {
  const clauses: string[] = [];

  if (filters.residentialOnly) clauses.push(`property_type = 'RESIDENTIAL'`);
  // See the note on `dwellingsOnly`. 400 sq ft is the floor area below which
  // the roll is describing a garage, a storage locker or a data error rather
  // than somewhere a person lives.
  if (filters.dwellingsOnly)
    clauses.push(`livable_floor_area >= ${DWELLING_MIN_SQFT} AND assessed_value > 0`);
  if (filters.propertyTypes?.length) clauses.push(inList("property_type", filters.propertyTypes));

  if (filters.minYearsSinceSale !== undefined)
    clauses.push(`years_since_last_sale >= ${num(filters.minYearsSinceSale)}`);
  if (filters.maxYearsSinceSale !== undefined)
    clauses.push(`years_since_last_sale <= ${num(filters.maxYearsSinceSale)}`);

  if (filters.minRoofAge !== undefined)
    clauses.push(`roof_age_years >= ${num(filters.minRoofAge)}`);
  if (filters.maxRoofAge !== undefined)
    clauses.push(`roof_age_years <= ${num(filters.maxRoofAge)}`);
  if (filters.requireRoofEvidence)
    clauses.push(`roof_age_basis IS NOT NULL AND roof_age_basis NOT ILIKE '%PROXY%'`);

  if (filters.minBuiltYear !== undefined)
    clauses.push(`built_year >= ${num(filters.minBuiltYear)}`);
  if (filters.maxBuiltYear !== undefined)
    clauses.push(`built_year <= ${num(filters.maxBuiltYear)}`);
  if (filters.minLivableArea !== undefined)
    clauses.push(`livable_floor_area >= ${num(filters.minLivableArea)}`);
  if (filters.maxLivableArea !== undefined)
    clauses.push(`livable_floor_area <= ${num(filters.maxLivableArea)}`);

  if (filters.minAssessedValue !== undefined)
    clauses.push(`assessed_value >= ${num(filters.minAssessedValue)}`);
  if (filters.maxAssessedValue !== undefined)
    clauses.push(`assessed_value <= ${num(filters.maxAssessedValue)}`);
  if (filters.minMarketValue !== undefined)
    clauses.push(`market_value >= ${num(filters.minMarketValue)}`);
  if (filters.maxMarketValue !== undefined)
    clauses.push(`market_value <= ${num(filters.maxMarketValue)}`);

  if (filters.cities?.length) clauses.push(inList("address_city", filters.cities));
  if (filters.zips?.length) clauses.push(inList("address_zip", filters.zips));
  if (filters.subdivisions?.length) clauses.push(inList("subdivision", filters.subdivisions));
  if (filters.geometry) clauses.push(geometrySql(filters.geometry));

  if (filters.ownerRegionClasses?.length)
    clauses.push(inList("owner_region_class", filters.ownerRegionClasses));
  if (filters.ownerOccupied !== undefined)
    clauses.push(filters.ownerOccupied ? `owner_occupied` : `NOT coalesce(owner_occupied, false)`);

  if (filters.waterView) clauses.push(`water_view_flag`);
  if (filters.maxWaterDistanceM !== undefined)
    clauses.push(`water_dist_m <= ${num(filters.maxWaterDistanceM)}`);
  if (filters.maxTransitDistanceM !== undefined)
    clauses.push(`nearest_transit_stop_m <= ${num(filters.maxTransitDistanceM)}`);

  if (filters.hasPermits !== undefined)
    clauses.push(filters.hasPermits ? `has_permits` : `NOT coalesce(has_permits, false)`);
  if (filters.minPermitCount !== undefined)
    clauses.push(`permit_count >= ${num(filters.minPermitCount)}`);

  const d = filters.distress;
  if (d) {
    // Answerable from the appraisal roll alone.
    if (d.absenteeOwner)
      clauses.push(
        `(NOT coalesce(owner_occupied, false) AND owner_mailing_address IS NOT NULL ` +
          `AND (owner_mailing_city IS DISTINCT FROM address_city OR owner_mailing_state IS DISTINCT FROM 'FL'))`,
      );
    if (d.noHomestead) clauses.push(`NOT coalesce(homestead_flag, false)`);

    // Answerable only when a court source has been loaded.
    if (courtJoinAvailable) {
      const any: string[] = [];
      if (d.hasLien) any.push(`coalesce(court_lien_count, 0) > 0`);
      if (d.hasForeclosure) any.push(`coalesce(court_foreclosure_count, 0) > 0`);
      if (d.hasCodeEnforcement) any.push(`coalesce(court_code_enforcement_count, 0) > 0`);
      if (d.hasProbate) any.push(`coalesce(court_probate_count, 0) > 0`);
      // Distress signals are alternatives, not a conjunction: a parcel in
      // foreclosure is a candidate whether or not it also carries a lien.
      if (any.length) clauses.push(`(${any.join(" OR ")})`);
      if (d.minCourtScore !== undefined)
        clauses.push(`coalesce(court_distress_score, 0) >= ${num(d.minCourtScore)}`);
    } else if (courtRequested(d)) {
      // A requested predicate that cannot be evaluated must narrow to nothing,
      // never be dropped. Dropping it turned "parcels with a recorded lien"
      // into "every residential dwelling in Duval" - 337,853 of them - under a
      // heading that said court distress. Zero is the truthful answer to a
      // question this dataset cannot answer, and the UI says why alongside it.
      clauses.push(`false /* court signals requested, no court source attached */`);
    }
  }

  return { sql: clauses.length ? clauses.join("\n  AND ") : "true", clauses };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */

export interface ScoreComponentSql {
  key: keyof Weights;
  /** Column alias holding the 0..1 value. */
  alias: string;
  expression: string;
  weight: number;
  /** Description of the rule, rendered in the rationale. */
  rule: string;
}

/* ------------------------------------------------------------------ */
/* Ramps: how a continuous signal becomes a 0..1 component              */
/* ------------------------------------------------------------------ */

/**
 * The scoring used to be a threshold with a small ramp on top: clearing the
 * threshold was worth 0.6 of the component outright, and the remaining 0.4 was
 * earned over the next fifteen years, after which the component was pinned at
 * 1.0. Both halves of that destroy the ranking.
 *
 * Measured on the published Duval roll, the "tired landlord" thesis (held 10+
 * years, roof 15+, absentee, no homestead) matches 10,209 dwellings. Under the
 * old model those 10,209 parcels carried 31 distinct scores, none below 73.3,
 * and 1,140 of them sat at exactly 100 - an eleven percent tie for first place,
 * in which "held 47 years with a 79 year old roof" and "held 25 years with a 30
 * year old roof" are the same parcel. The distress component made it worse: its
 * signals were the same predicates the WHERE clause had already applied, so it
 * was 1.0 for every row in the result by construction.
 *
 * What replaces it, for every signal that is genuinely continuous:
 *
 * - a small credit for clearing the threshold at all, so a parcel that only
 *   just qualifies still reads as a match rather than as a zero;
 * - a linear core across the criterion's real range, taken from the roll rather
 *   than from the threshold, so the spread of actual parcels is the spread of
 *   actual scores;
 * - a compressive tail past the top of that range, so the ninetieth percentile
 *   is not a ceiling: a 60 year hold still outranks a 45 year hold, by less
 *   than the first ten years were worth.
 *
 * Genuinely boolean signals - a homestead exemption, a recorded filing - stay
 * boolean. Grading them would be inventing precision the roll does not have.
 */

/** Clearing the threshold at all, before anything is earned on the ramp. */
const QUALIFY_CREDIT = 0.1;
/** The part of a component earned on the ramp. `QUALIFY_CREDIT` + this is 1. */
const EARNED_SHARE = 0.9;
/** How the earned part splits between the linear core and the tail. */
const CORE_SHARE = 0.85;
const TAIL_SHARE = 0.15;

/**
 * Where the linear core tops out, per criterion.
 *
 * Both are read off the population a thesis of this kind actually matches. In
 * the tired-landlord match set tenure runs p50 15, p90 28, p99 47 years, so the
 * core runs to 45: tenure has a long thin tail and the core should cover nearly
 * all of it. Roof age runs p50 36, p90 66, p99 79, so the core runs to 65 - past
 * about sixty years the number is the year-built proxy telling you the house is
 * old rather than a roof telling you it is worse, and paying linearly for that
 * would rank a 1900 cottage above a genuinely failing roof.
 *
 * Above the core the tail keeps the order strict without pretending the extra
 * years are worth as much as the first ones.
 */
const TENURE_FULL_YEARS = 45;
const TENURE_TAIL_YEARS = 20;
const ROOF_FULL_YEARS = 65;
const ROOF_TAIL_YEARS = 25;

/**
 * How close the water has to be for a water view to score full marks. Of the
 * 12,873 water-view parcels in the sample the median sits 80 m from the water
 * and the 99th percentile at 149 m, so 150 m is the far edge of the signal.
 */
const WATER_VIEW_FULL_M = 150;

/** Guards a degenerate band (min equal to max) from dividing by zero. */
const MIN_RAMP_SPAN = 1;

export interface RisingRamp {
  /** The column, or any SQL expression, being scored. */
  column: string;
  /** Below this, nothing. Normally the threshold the user filtered on. */
  from: number;
  /** Top of the linear core. */
  to: number;
  /**
   * Scale of the compressive tail past `to`, or null for a hard stop there.
   * A hard stop is right when the user set an upper bound: everything above it
   * was filtered out, so there is nothing left up there to order.
   */
  tail: number | null;
}

/** More is better: tenure, roof age. Returns a bounded 0..1 DOUBLE. */
export function risingRampSql({ column, from, to, tail }: RisingRamp): string {
  const span = Math.max(to - from, MIN_RAMP_SPAN);
  const top = from + span;
  const value = `CAST(${column} AS DOUBLE)`;
  const core = `least(1.0, (${value} - ${num(from)}) / ${num(span)})`;
  const earned =
    tail === null
      ? core
      : // greatest(...) is the overshoot past the core; over / (over + tail)
        // rises from 0 towards 1 and never reaches it, so no two parcels with
        // different values ever tie here.
        `${num(CORE_SHARE)} * ${core} + ${num(TAIL_SHARE)} * ` +
        `(greatest(${value} - ${num(top)}, 0.0) / (greatest(${value} - ${num(top)}, 0.0) + ${num(tail)}))`;

  return (
    `CASE WHEN ${column} IS NULL THEN 0.0 ` +
    `WHEN ${value} < ${num(from)} THEN 0.0 ` +
    `ELSE ${num(QUALIFY_CREDIT)} + ${num(EARNED_SHARE)} * (${earned}) END`
  );
}

/**
 * Less is better: distance from a point, distance above the floor of a value
 * band. 1.0 at `best`, 0.0 at `worst`, linear between, clamped outside.
 */
export function closenessSql(expression: string, best: number, worst: number): string {
  const span = Math.max(worst - best, MIN_RAMP_SPAN);
  return (
    `greatest(0.0, least(1.0, 1.0 - ` +
    `(CAST(${expression} AS DOUBLE) - ${num(best)}) / ${num(span)}))`
  );
}

/**
 * A signal inside a multi-signal component, and whether it can rank.
 *
 * A signal the WHERE clause has already guaranteed is a constant across the
 * whole result set. A constant cannot reorder anything - it only takes weight
 * away from the signals that can, compresses the score into the top of the
 * range and manufactures ties there once the number is rounded. So it is
 * measured where the data supports a finer reading, and otherwise left out.
 */
interface Signal {
  expression: string;
  /** True when every row that passes the filter scores 1 on this signal. */
  guaranteed: boolean;
}

function meanOf(signals: readonly Signal[]): string | null {
  const ranking = signals.filter((signal) => !signal.guaranteed);
  if (!ranking.length) return null;
  if (ranking.length === 1) return `(${ranking[0]?.expression})`;
  return `((${ranking.map((signal) => signal.expression).join(" + ")}) / CAST(${num(ranking.length)} AS DOUBLE))`;
}

/**
 * How far away the owner is, on the class the pipeline publishes.
 *
 * The absentee filter asks one question - does the owner mail somewhere else -
 * and every row in the result answers it the same way. The roll can answer a
 * sharper one: in the tired-landlord match set 1,021 owners mail from another
 * state, 1,005 from elsewhere in Florida and 189 from Jacksonville itself. An
 * out-of-state landlord is a materially better call than one who mails to the
 * next ZIP, so the score says so instead of scoring all three the same.
 */
const ABSENTEE_DISTANCE_SQL =
  `CASE WHEN coalesce(owner_occupied, false) OR owner_mailing_address IS NULL THEN 0.0 ` +
  `WHEN owner_region_class = 'FOREIGN' THEN 1.0 ` +
  `WHEN owner_region_class = 'NATIONAL' THEN 0.85 ` +
  `WHEN owner_region_class = 'REGIONAL' THEN 0.6 ` +
  `ELSE 0.35 END`;

function boolSignal(condition: string): string {
  return `CASE WHEN ${condition} THEN 1.0 ELSE 0.0 END`;
}

/**
 * Components are only built for criteria the user set. An unset criterion has
 * no weight and no column, so it cannot quietly move a ranking.
 */
export function buildScoreComponents(
  criteria: CriteriaSet,
  courtJoinAvailable: boolean,
): ScoreComponentSql[] {
  const { filters, weights } = criteria;
  const components: ScoreComponentSql[] = [];

  if (filters.minYearsSinceSale !== undefined && weights.tenure > 0) {
    const from = filters.minYearsSinceSale;
    const ceiling = filters.maxYearsSinceSale;
    components.push({
      key: "tenure",
      alias: "comp_tenure",
      expression: risingRampSql({
        column: "years_since_last_sale",
        from,
        to: ceiling ?? TENURE_FULL_YEARS,
        tail: ceiling === undefined ? TENURE_TAIL_YEARS : null,
      }),
      weight: weights.tenure,
      rule:
        ceiling === undefined
          ? `held at least ${from} years, and every further year scores higher`
          : `held between ${from} and ${ceiling} years, longer scores higher`,
    });
  }

  if (filters.minRoofAge !== undefined && weights.roofAge > 0) {
    const from = filters.minRoofAge;
    const ceiling = filters.maxRoofAge;
    components.push({
      key: "roofAge",
      alias: "comp_roof",
      expression: risingRampSql({
        column: "roof_age_years",
        from,
        to: ceiling ?? ROOF_FULL_YEARS,
        tail: ceiling === undefined ? ROOF_TAIL_YEARS : null,
      }),
      weight: weights.roofAge,
      rule:
        ceiling === undefined
          ? `roof at least ${from} years old, and every further year scores higher`
          : `roof between ${from} and ${ceiling} years old, older scores higher`,
    });
  }

  const d = filters.distress;
  if (d && weights.distress > 0) {
    const signals: Signal[] = [];
    // Graded, so it still ranks inside a result set the filter has already made
    // entirely absentee.
    if (d.absenteeOwner) signals.push({ expression: ABSENTEE_DISTANCE_SQL, guaranteed: false });
    // Genuinely boolean, and identical to the predicate that selected the row.
    if (d.noHomestead)
      signals.push({
        expression: boolSignal(`NOT coalesce(homestead_flag, false)`),
        guaranteed: true,
      });

    if (courtJoinAvailable) {
      const court: { requested: boolean; column: string }[] = [
        { requested: Boolean(d.hasLien), column: "court_lien_count" },
        { requested: Boolean(d.hasForeclosure), column: "court_foreclosure_count" },
        { requested: Boolean(d.hasCodeEnforcement), column: "court_code_enforcement_count" },
        { requested: Boolean(d.hasProbate), column: "court_probate_count" },
      ];
      const requested = court.filter((signal) => signal.requested);
      for (const signal of requested) {
        signals.push({
          // A filing either exists or it does not. `buildWhere` requires one of
          // the requested kinds, so a lone requested kind is guaranteed on every
          // row; two or more are alternatives and each still ranks.
          expression: boolSignal(`coalesce(${signal.column}, 0) > 0`),
          guaranteed: requested.length === 1,
        });
      }
      if (d.minCourtScore !== undefined) {
        // Published 0..100 and continuous, so it is scored as a ramp from the
        // floor the user asked for up to the top of the scale.
        signals.push({
          expression: risingRampSql({
            column: "coalesce(court_distress_score, 0)",
            from: d.minCourtScore,
            to: 100,
            tail: null,
          }),
          guaranteed: false,
        });
      }
    }

    const expression = meanOf(signals);
    if (expression) {
      components.push({
        key: "distress",
        alias: "comp_distress",
        weight: weights.distress,
        expression,
        rule: `how strongly the requested distress signals read on this parcel`,
      });
    }
  }

  // Cheaper is better inside a requested band: an acquisition budget is a
  // ceiling, so a parcel at the bottom of the band scores highest.
  const lo = filters.minAssessedValue;
  const hi = filters.maxAssessedValue;
  if (weights.value > 0 && (hi !== undefined || (lo !== undefined && lo > 0))) {
    const floor = lo ?? 0;
    const expression =
      hi === undefined
        ? // A floor with no ceiling. Halving credit for each multiple of the
          // floor keeps the ordering strict all the way up the distribution
          // rather than inventing a ceiling the user did not ask for.
          `CASE WHEN assessed_value IS NULL OR assessed_value <= 0 THEN 0.0 ` +
          `ELSE least(1.0, ${num(floor)} / CAST(assessed_value AS DOUBLE)) END`
        : `CASE WHEN assessed_value IS NULL THEN 0.0 ELSE ${closenessSql("assessed_value", floor, hi)} END`;
    components.push({
      key: "value",
      alias: "comp_value",
      expression,
      weight: weights.value,
      rule:
        hi === undefined
          ? `assessed value nearer the ${floor} floor scores higher`
          : `lower assessed value inside the ${floor} to ${hi} band scores higher`,
    });
  }

  // Closer to the centre of a drawn area is a better fit for a farming area.
  const centre = geometryCentre(filters.geometry);
  if (centre && weights.geography > 0) {
    components.push({
      key: "geography",
      alias: "comp_geo",
      expression:
        `CASE WHEN latitude IS NULL THEN 0.0 ELSE ` +
        `${closenessSql(haversineSql(centre.lat, centre.lng), 0, centre.radiusM)} END`,
      weight: weights.geography,
      rule: `nearer the centre of the drawn area scores higher`,
    });
  }

  if (weights.amenity > 0) {
    const amenity: Signal[] = [];
    if (filters.waterView) {
      // The flag itself is the filter, so it is 1 on every row. How close the
      // water is, which the pipeline also publishes, is not.
      amenity.push({
        expression:
          `CASE WHEN water_dist_m IS NULL THEN ${num(QUALIFY_CREDIT)} ELSE ` +
          `${closenessSql("water_dist_m", 0, WATER_VIEW_FULL_M)} END`,
        guaranteed: false,
      });
    }
    if (filters.maxWaterDistanceM !== undefined) {
      amenity.push({
        expression:
          `CASE WHEN water_dist_m IS NULL THEN 0.0 ELSE ` +
          `${closenessSql("water_dist_m", 0, filters.maxWaterDistanceM)} END`,
        guaranteed: false,
      });
    }
    if (filters.maxTransitDistanceM !== undefined) {
      amenity.push({
        expression:
          `CASE WHEN nearest_transit_stop_m IS NULL THEN 0.0 ELSE ` +
          `${closenessSql("nearest_transit_stop_m", 0, filters.maxTransitDistanceM)} END`,
        guaranteed: false,
      });
    }
    const expression = meanOf(amenity);
    if (expression) {
      components.push({
        key: "amenity",
        alias: "comp_amenity",
        expression,
        weight: weights.amenity,
        rule: `how close the water and transit signals published by the pipeline actually are`,
      });
    }
  }

  return components;
}

export interface ScoreSql {
  components: ScoreComponentSql[];
  /** `SELECT` fragment: the component aliases plus the 0..100 score. */
  selectFragment: string;
  /** True when nothing in the criteria set can rank. */
  unranked: boolean;
}

/**
 * Build the score expression.
 *
 * Everything numeric here is cast to DOUBLE on the way out, which looks
 * redundant and is not. A decimal literal makes DuckDB type the column
 * DECIMAL, Arrow carries a decimal as a four-element Uint32Array, and the
 * browser's row converter turns an unrecognised object into a JSON string.
 * `Number("{\"0\":1000,...}")` is NaN, so every score in the tab rendered as
 * NaN and the map's paint expression - which steps on that number - failed and
 * drew nothing. The native engine was unaffected, which is why the tests and
 * the seed never saw it.
 */
export function buildScore(criteria: CriteriaSet, courtJoinAvailable: boolean): ScoreSql {
  const components = buildScoreComponents(criteria, courtJoinAvailable);

  if (!components.length) {
    // Nothing to rank on. Saying so with a flat 100 is honest; inventing an
    // order from columns the user never mentioned is not.
    return {
      components,
      selectFragment: `CAST(100.0 AS DOUBLE) AS ${SCORE_ALIAS}`,
      unranked: true,
    };
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.map((c) => `${num(c.weight)} * ${c.alias}`).join(" + ");

  const aliases = components
    .map((c) => `CAST(${c.expression} AS DOUBLE) AS ${c.alias}`)
    .join(",\n    ");

  // Two decimals, not one. The score is displayed rounded to a whole number, so
  // the decimals exist only to order the list - and at one decimal the whole
  // county has 1,001 possible scores to sit on, which puts thousands of parcels
  // on each of them and hands the ordering back to the tiebreak.
  return {
    components,
    selectFragment:
      `${aliases},\n    ` +
      `CAST(round(100.0 * (${weighted}) / ${num(totalWeight)}, 2) AS DOUBLE) AS ${SCORE_ALIAS}`,
    unranked: false,
  };
}

/* ------------------------------------------------------------------ */
/* Full statement                                                       */
/* ------------------------------------------------------------------ */

export interface BuildSearchOptions {
  criteria: CriteriaSet;
  limit: number;
  offset: number;
  orderBy: "score" | "assessed_value" | "roof_age" | "tenure";
  courtJoinAvailable: boolean;
  /** Restrict to a known id set, used by the matcher when rechecking hits. */
  propertyIds?: readonly string[];
  /**
   * The map's current view, when the user has asked results to follow it.
   *
   * Deliberately NOT part of the criteria set. Where you happen to have scrolled
   * the map is not part of an acquisition thesis, and a saved search that had
   * quietly captured a bounding box would evaluate against it forever - the
   * scheduled matcher would keep alerting on whatever was on screen the moment
   * somebody pressed Save. This narrows what is displayed; it never travels.
   */
  viewport?: MapViewport | null;
  /**
   * A `WITH ...` prefix and the relation to read, supplied by the overlay when
   * court records or a simulated pipeline update sit on top of the parquet.
   * Defaults to the plain published view.
   */
  prefix?: string;
  from?: string;
}

/**
 * Whether the roll is describing a dwelling it has actually priced.
 *
 * Two separate ways the appraisal roll declines to price something that is
 * nonetheless a residential parcel: no livable floor area at all (HOA common
 * areas, retention ponds, garage and storage units), and a nominal entry that
 * holds a place rather than states a value. The second is the one that gets
 * through `dwellingsOnly`: a condominium unit with a real floor area and an
 * assessed value of one dollar clears `assessed_value > 0` and is still not a
 * price.
 *
 * The test is per square foot rather than an absolute floor, so it needs no
 * invented threshold: of the 68,403 sample dwellings that clear the guard, not
 * one is assessed below a dollar per livable square foot, and the cheapest real
 * house in the sample sits at $1.70 per foot. A dollar-assessed 500 sq ft unit
 * misses it by three orders of magnitude.
 *
 * This is used for ORDERING only. It is deliberately not a filter: `buildWhere`
 * decides what is in the result, and adding a second hidden guard there would be
 * the "raise the threshold until the bad rows disappear" move rather than a fix.
 */
const PRICED_DWELLING_SQL = `livable_floor_area >= ${DWELLING_MIN_SQFT} AND assessed_value >= livable_floor_area`;

/**
 * How an equal sort key is broken, appended to every ordering.
 *
 * A tie means the sort key did not distinguish these parcels, so whatever
 * decides between them is not a ranking anyone asked for. It was
 * `assessed_value ASC`, and that is the worst available choice: the bottom of
 * the value distribution is where the roll's placeholders live, so the hidden
 * "cheapest first" rule reliably promoted the least real rows in the county.
 *
 * It mattered far more than a tiebreak usually does. With no ranking criteria
 * set, `buildScore` honestly scores every row 100 - so every row is tied, and
 * the tiebreak became the entire ordering of the default search. The first
 * screen of the app was fifteen consecutive condominium units at 514 LOMAX ST
 * assessed at a dollar each. The same ordering picks which matches the
 * scheduled matcher tracks, so a saved search with no ranking criteria was
 * watching the two thousand cheapest rows in Duval rather than a sample of what
 * it matched.
 *
 * What replaces it:
 *
 * 1. Parcels the roll has priced as dwellings before the ones it has not. This
 *    is the same judgement `dwellingsOnly` makes, applied as an ordering rather
 *    than as a filter, so it still holds when a land buyer turns that guard off
 *    to look for infill lots: the lots are in the result, they are simply not
 *    the first thing on the screen.
 * 2. Nearer the middle of Jacksonville first.
 *
 *    `property_id` used to be the whole of this step, on the argument that it is
 *    stable and carries no opinion. It is stable. It is not without an opinion:
 *    an RE number is assigned by plat, in the order the county platted the land,
 *    so ascending order is west-to-east rural-first and marches through one
 *    subdivision at a time. On the published roll the first twenty rows of the
 *    default search are all on N US 301 HWY - the Baldwin corridor, 28 to 30 km
 *    from downtown, past the 95th percentile of the county's own distance
 *    distribution (p25 9 km, p50 14.5 km, p75 19 km). Baldwin is a town of
 *    1,400 people at the far western county edge, and it opened every list in a
 *    Jacksonville CRM. Sorting by plat number is not neutral, it is just an
 *    opinion nobody chose.
 *
 *    So the tiebreak states the opinion an acquisitions team would actually
 *    hold: when nothing else separates two parcels, the one in the market they
 *    work comes first. Distance from downtown (the same point the map opens on)
 *    is the plainest reading of that - it is where the comps, the crews and the
 *    buyers are, and half the county's housing stock sits within 14.5 km of it.
 *    With this in place the same default search opens on N Ocean St, E Ashley
 *    St, E Church St and Phelps St: downtown, LaVilla and Springfield.
 *
 *    It is a constant point, not the map viewport. Where you have scrolled must
 *    not change what a saved search watches.
 *
 * 3. `property_id` last, so an exact distance tie still resolves the same way on
 *    every pass. Pagination and the matcher's tracked set both need a total
 *    order; without one, LIMIT/OFFSET can repeat or skip a row.
 */
/**
 * Downtown Jacksonville. The same coordinate the map centres on by default
 * (NEXT_PUBLIC_MAP_LAT / _LNG), repeated rather than imported because this
 * module is bundled into the browser query path and must not reach into the
 * server-side data configuration to sort a list.
 */
export const CORE_LAT = 30.3322;
export const CORE_LNG = -81.6557;

export const TIEBREAK_SQL =
  `CASE WHEN ${PRICED_DWELLING_SQL} THEN 0 ELSE 1 END, ` +
  `${haversineSql(CORE_LAT, CORE_LNG)} ASC NULLS LAST, property_id`;

/**
 * `assessed_value` is the "Cheapest" button. That is a sort the user asked for
 * out loud, so it keeps putting the cheapest row first - including the dollar
 * units, which is the correct answer to the question "what is cheapest". The
 * bug was never that the ordering exists; it was that it ran when nobody chose
 * it.
 */
const ORDER_SQL: Record<BuildSearchOptions["orderBy"], string> = {
  score: `${SCORE_ALIAS} DESC, ${TIEBREAK_SQL}`,
  assessed_value: `assessed_value ASC NULLS LAST, ${TIEBREAK_SQL}`,
  roof_age: `roof_age_years DESC NULLS LAST, ${TIEBREAK_SQL}`,
  tenure: `years_since_last_sale DESC NULLS LAST, ${TIEBREAK_SQL}`,
};

export interface BuiltSearch {
  sql: string;
  countSql: string;
  score: ScoreSql;
  where: WhereResult;
}

export function buildSearch(options: BuildSearchOptions): BuiltSearch {
  const where = buildWhere(options.criteria.filters, options.courtJoinAvailable);
  const score = buildScore(options.criteria, options.courtJoinAvailable);

  const clauses = [where.sql];
  if (options.viewport) clauses.push(geometrySql(options.viewport));
  if (options.propertyIds?.length) {
    clauses.push(`property_id IN (${options.propertyIds.map(str).join(", ")})`);
  }
  const whereSql = clauses.join("\n  AND ");

  const prefix = options.prefix ?? "";
  const from = options.from ?? VIEW;

  // The court aggregates only exist on the relation when an overlay built it,
  // so they are selected only then. Selecting them unconditionally would fail
  // to bind against the plain parquet view.
  const courtColumns = options.courtJoinAvailable
    ? ",\n    court_lien_count,\n    court_foreclosure_count,\n    court_code_enforcement_count,\n    court_probate_count,\n    court_distress_score,\n    court_latest_filing_date"
    : "";

  const columns = LIST_COLUMNS.join(",\n    ");

  const sql = `${prefix}SELECT
    ${columns}${courtColumns},
    ${score.selectFragment}
  FROM ${from}
  WHERE ${whereSql}
  ORDER BY ${ORDER_SQL[options.orderBy]}
  LIMIT ${num(options.limit)} OFFSET ${num(options.offset)}`;

  const countSql = `${prefix}SELECT count(*) AS ${TOTAL_ALIAS} FROM ${from} WHERE ${whereSql}`;

  return { sql, countSql, score, where };
}
