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

export const SCORE_ALIAS = "match_score";
export const TOTAL_ALIAS = "match_total";

/**
 * How far past a threshold counts as "as good as it gets". A parcel that clears
 * the roof-age threshold by this many years scores the full component.
 */
const RAMP_YEARS = 15;

/** Meeting a threshold at all is worth this much of a component before the ramp. */
const BASE_CREDIT = 0.6;

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
export function needsCourtData(filters: Filters): boolean {
  const d = filters.distress;
  if (!d) return false;
  return Boolean(d.hasLien || d.hasForeclosure || d.hasCodeEnforcement || d.hasProbate || d.minCourtScore);
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
  if (filters.propertyTypes?.length) clauses.push(inList("property_type", filters.propertyTypes));

  if (filters.minYearsSinceSale !== undefined)
    clauses.push(`years_since_last_sale >= ${num(filters.minYearsSinceSale)}`);
  if (filters.maxYearsSinceSale !== undefined)
    clauses.push(`years_since_last_sale <= ${num(filters.maxYearsSinceSale)}`);

  if (filters.minRoofAge !== undefined) clauses.push(`roof_age_years >= ${num(filters.minRoofAge)}`);
  if (filters.maxRoofAge !== undefined) clauses.push(`roof_age_years <= ${num(filters.maxRoofAge)}`);
  if (filters.requireRoofEvidence)
    clauses.push(`roof_age_basis IS NOT NULL AND roof_age_basis NOT ILIKE '%PROXY%'`);

  if (filters.minBuiltYear !== undefined) clauses.push(`built_year >= ${num(filters.minBuiltYear)}`);
  if (filters.maxBuiltYear !== undefined) clauses.push(`built_year <= ${num(filters.maxBuiltYear)}`);
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

/** A ramp from `BASE_CREDIT` at the threshold to 1.0 `RAMP_YEARS` beyond it. */
function rampSql(column: string, threshold: number): string {
  return (
    `CASE WHEN ${column} IS NULL THEN 0 ` +
    `WHEN ${column} < ${num(threshold)} THEN 0 ` +
    `ELSE least(1.0, ${BASE_CREDIT} + ${1 - BASE_CREDIT} * ` +
    `least(1.0, (${column} - ${num(threshold)}) / ${num(RAMP_YEARS)}.0)) END`
  );
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
    components.push({
      key: "tenure",
      alias: "comp_tenure",
      expression: rampSql("years_since_last_sale", filters.minYearsSinceSale),
      weight: weights.tenure,
      rule: `held at least ${filters.minYearsSinceSale} years, longer scores higher`,
    });
  }

  if (filters.minRoofAge !== undefined && weights.roofAge > 0) {
    components.push({
      key: "roofAge",
      alias: "comp_roof",
      expression: rampSql("roof_age_years", filters.minRoofAge),
      weight: weights.roofAge,
      rule: `roof at least ${filters.minRoofAge} years old, older scores higher`,
    });
  }

  const d = filters.distress;
  if (d && weights.distress > 0) {
    const signals: string[] = [];
    if (d.absenteeOwner)
      signals.push(
        `CASE WHEN NOT coalesce(owner_occupied, false) AND owner_mailing_address IS NOT NULL THEN 1 ELSE 0 END`,
      );
    if (d.noHomestead) signals.push(`CASE WHEN NOT coalesce(homestead_flag, false) THEN 1 ELSE 0 END`);
    if (courtJoinAvailable) {
      if (d.hasLien) signals.push(`CASE WHEN coalesce(court_lien_count, 0) > 0 THEN 1 ELSE 0 END`);
      if (d.hasForeclosure)
        signals.push(`CASE WHEN coalesce(court_foreclosure_count, 0) > 0 THEN 1 ELSE 0 END`);
      if (d.hasCodeEnforcement)
        signals.push(`CASE WHEN coalesce(court_code_enforcement_count, 0) > 0 THEN 1 ELSE 0 END`);
      if (d.hasProbate)
        signals.push(`CASE WHEN coalesce(court_probate_count, 0) > 0 THEN 1 ELSE 0 END`);
    }
    if (signals.length) {
      components.push({
        key: "distress",
        alias: "comp_distress",
        expression: `((${signals.join(" + ")}) / ${num(signals.length)}.0)`,
        weight: weights.distress,
        rule: `share of the ${signals.length} requested distress signals present`,
      });
    }
  }

  // Cheaper is better inside a requested band: an acquisition budget is a
  // ceiling, so a parcel at the bottom of the band scores highest.
  const lo = filters.minAssessedValue;
  const hi = filters.maxAssessedValue;
  if (hi !== undefined && weights.value > 0) {
    const floor = lo ?? 0;
    const span = Math.max(hi - floor, 1);
    components.push({
      key: "value",
      alias: "comp_value",
      expression:
        `CASE WHEN assessed_value IS NULL THEN 0 ELSE ` +
        `greatest(0.0, least(1.0, 1.0 - (assessed_value - ${num(floor)}) / ${num(span)}.0)) END`,
      weight: weights.value,
      rule: `lower assessed value inside the ${floor} to ${hi} band scores higher`,
    });
  }

  // Closer to the centre of a drawn circle is a better fit for a farming area.
  if (filters.geometry?.type === "circle" && weights.geography > 0) {
    const g = filters.geometry;
    components.push({
      key: "geography",
      alias: "comp_geo",
      expression:
        `CASE WHEN latitude IS NULL THEN 0 ELSE ` +
        `greatest(0.0, least(1.0, 1.0 - ${haversineSql(g.lat, g.lng)} / ${num(g.radiusM)}.0)) END`,
      weight: weights.geography,
      rule: `nearer the centre of the drawn radius scores higher`,
    });
  }

  if (weights.amenity > 0) {
    const amenity: string[] = [];
    if (filters.waterView) amenity.push(`CASE WHEN water_view_flag THEN 1 ELSE 0 END`);
    if (filters.maxTransitDistanceM !== undefined) {
      const limit = num(filters.maxTransitDistanceM);
      amenity.push(
        `CASE WHEN nearest_transit_stop_m IS NULL THEN 0 ELSE ` +
          `greatest(0.0, least(1.0, 1.0 - nearest_transit_stop_m / ${limit}.0)) END`,
      );
    }
    if (amenity.length) {
      components.push({
        key: "amenity",
        alias: "comp_amenity",
        expression: `((${amenity.join(" + ")}) / ${num(amenity.length)}.0)`,
        weight: weights.amenity,
        rule: `water view and transit proximity signals published by the pipeline`,
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

export function buildScore(criteria: CriteriaSet, courtJoinAvailable: boolean): ScoreSql {
  const components = buildScoreComponents(criteria, courtJoinAvailable);

  if (!components.length) {
    // Nothing to rank on. Saying so with a flat 100 is honest; inventing an
    // order from columns the user never mentioned is not.
    return {
      components,
      selectFragment: `100.0 AS ${SCORE_ALIAS}`,
      unranked: true,
    };
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weighted = components
    .map((c) => `${num(c.weight)} * ${c.alias}`)
    .join(" + ");

  const aliases = components.map((c) => `${c.expression} AS ${c.alias}`).join(",\n    ");

  return {
    components,
    selectFragment: `${aliases},\n    round(100.0 * (${weighted}) / ${num(totalWeight)}, 1) AS ${SCORE_ALIAS}`,
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
}

const ORDER_SQL: Record<BuildSearchOptions["orderBy"], string> = {
  score: `${SCORE_ALIAS} DESC, assessed_value ASC NULLS LAST`,
  assessed_value: `assessed_value ASC NULLS LAST`,
  roof_age: `roof_age_years DESC NULLS LAST`,
  tenure: `years_since_last_sale DESC NULLS LAST`,
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
  if (options.propertyIds?.length) {
    clauses.push(`property_id IN (${options.propertyIds.map(str).join(", ")})`);
  }
  const whereSql = clauses.join("\n  AND ");

  const columns = LIST_COLUMNS.join(",\n    ");

  const sql = `SELECT
    ${columns},
    ${score.selectFragment}
  FROM ${VIEW}
  WHERE ${whereSql}
  ORDER BY ${ORDER_SQL[options.orderBy]}
  LIMIT ${num(options.limit)} OFFSET ${num(options.offset)}`;

  const countSql = `SELECT count(*) AS ${TOTAL_ALIAS} FROM ${VIEW} WHERE ${whereSql}`;

  return { sql, countSql, score, where };
}
