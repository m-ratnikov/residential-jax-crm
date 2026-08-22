/**
 * Query table row to `PropertyRecord`.
 *
 * The published table has 103 columns and will grow. This maps the ones the CRM
 * reads by name and keeps everything else on `raw`, so a column the pipeline
 * adds tomorrow shows up on the detail view without a change here.
 */

import type { PropertyRecord, Provenance } from "./types";

type Row = Readonly<Record<string, unknown>>;

function s(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function n(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function b(row: Row, key: string): boolean | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(text)) return true;
  if (["false", "f", "0", "no", "n"].includes(text)) return false;
  return null;
}

export function provenanceOf(row: Row): Provenance {
  return {
    sourceSystem: s(row, "source_system"),
    sourceUrl: s(row, "source_url"),
    fetchedAt: s(row, "fetched_at"),
    runId: s(row, "run_id"),
    sourceArtifact: s(row, "source_artifact"),
    sourceSha256: s(row, "source_sha256"),
  };
}

export function toRecord(row: Row): PropertyRecord {
  return {
    propertyId: s(row, "property_id") ?? "",
    parcelIdentifier: s(row, "parcel_identifier"),
    propertyCid: s(row, "property_cid"),

    addressStreet: s(row, "address_street"),
    addressCity: s(row, "address_city"),
    addressZip: s(row, "address_zip"),
    latitude: n(row, "latitude"),
    longitude: n(row, "longitude"),
    subdivision: s(row, "subdivision"),
    neighborhoodCode: s(row, "neighborhood_code"),

    propertyType: s(row, "property_type"),
    propertyUsageType: s(row, "property_usage_type"),
    builtYear: n(row, "built_year"),
    livableFloorArea: n(row, "livable_floor_area"),
    totalArea: n(row, "total_area"),
    residentialUnits: n(row, "residential_units"),

    roofYearEst: n(row, "roof_year_est"),
    roofAgeYears: n(row, "roof_age_years"),
    roofAgeBasis: s(row, "roof_age_basis"),
    roofCoveringMaterial: s(row, "roof_covering_material"),

    assessedValue: n(row, "assessed_value"),
    marketValue: n(row, "market_value"),
    landValue: n(row, "land_value"),
    taxableValue: n(row, "taxable_value"),

    ownerName: s(row, "owner_name"),
    ownerCount: n(row, "owner_count"),
    ownerOccupied: b(row, "owner_occupied"),
    ownerRegionClass: s(row, "owner_region_class"),
    ownerMailingAddress: s(row, "owner_mailing_address"),
    ownerMailingCity: s(row, "owner_mailing_city"),
    ownerMailingState: s(row, "owner_mailing_state"),
    ownerMailingZip: s(row, "owner_mailing_zip"),
    homesteadFlag: b(row, "homestead_flag"),

    lastSaleDate: s(row, "last_sale_date") ?? s(row, "last_sale_date_any"),
    lastSalePrice: n(row, "last_sale_price"),
    yearsSinceLastSale: n(row, "years_since_last_sale"),
    tenureBasis: s(row, "tenure_basis"),

    waterViewFlag: b(row, "water_view_flag"),
    waterDistM: n(row, "water_dist_m"),
    waterBodyName: s(row, "water_body_name"),
    nearestTransitStopM: n(row, "nearest_transit_stop_m"),
    nearestTransitStopName: s(row, "nearest_transit_stop_name"),

    hasPermits: b(row, "has_permits"),
    permitCount: n(row, "permit_count"),
    roofPermitCount: n(row, "roof_permit_count"),
    lastPermitDate: s(row, "last_permit_date"),

    provenance: provenanceOf(row),
    raw: row,
  };
}

/** A one line label for lists, alerts and outreach templates. */
export function displayAddress(property: {
  addressStreet: string | null;
  addressCity: string | null;
  addressZip: string | null;
  propertyId: string;
}): string {
  const parts = [property.addressStreet, property.addressCity, property.addressZip].filter(Boolean);
  return parts.length ? parts.join(", ") : `Parcel ${property.propertyId}`;
}

/* ------------------------------------------------------------------ */
/* Owner character                                                      */
/* ------------------------------------------------------------------ */

/**
 * Legal-form tokens. A name carrying one of these is a registered entity, not
 * a person, and on the Duval roll that is close to a certainty rather than a
 * guess: of the 3,799 distinct owner names in the bundled extract that match on
 * one, the only twelve that even end like a personal name are truncated company
 * names ("PALMS OF JACKSONVILLE INC ET A", "NERD HOMES LIMITED LIABILITY C").
 *
 * They are only counted away from the first position. The roll writes people
 * surname first, so "CO ERWIN V" is a man called Erwin Co, and a token that
 * opens the name is part of somebody's surname far more often than it is a
 * suffix.
 */
const ORGANISATION_LEGAL_FORMS = new Set([
  "LLC",
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "LTD",
  "LIMITED",
  "LP",
  "LLP",
  "LLLP",
  "LC",
  "PLLC",
  "PA",
  "PC",
  "NA",
]);

/**
 * Words that name what an organisation is, for the entities whose registered
 * suffix the roll's 30 character field has cut off ("CHINESE CHRISTIAN CHURCH
 * OF JA") or that never carried one ("EBENEZER BAPTIST CHURCH", "JACKSONVILLE
 * PORT AUTHORITY", "CITY OF JACKSONVILLE").
 *
 * This is the half that can be wrong, so it is the half that is measured: 398
 * distinct names in the bundled extract match on a word here and on no legal
 * form, and reading all 398 turns up exactly one person - BRIAN AND MEGAN
 * CHURCH FAMILY, who are called Church. Church, Temple, Parish and Chapel are
 * all real surnames, which is why the leading-token and personal-tail guards
 * below exist and why this list is deliberately short of the words that are
 * mostly surnames (Bishop, Abbey, Mason, Priest are not here at all).
 *
 * Trusts and estates are deliberately absent. "SAPP ILENE M ESTATE" and
 * "KNIGHT ANN H LIFE ESTATE" are people, and heirs on a probate parcel are the
 * acquisition target rather than the thing to filter out.
 */
const ORGANISATION_WORDS = new Set([
  // Commercial
  "PROPERTIES",
  "PROPERTY",
  "HOLDINGS",
  "HOLDING",
  "INVESTMENTS",
  "INVESTMENT",
  "DEVELOPMENT",
  "DEVELOPERS",
  "HOMES",
  "GROUP",
  "REALTY",
  "VENTURES",
  "MANAGEMENT",
  "ENTERPRISES",
  "CAPITAL",
  "EQUITY",
  "PARTNERS",
  "PARTNERSHIP",
  "ACQUISITIONS",
  "SERVICES",
  "FUND",
  "REIT",
  "BANK",
  "MORTGAGE",
  "BUILDERS",
  "CONSTRUCTION",
  "RENTALS",
  "LEASING",
  "ASSOCIATES",
  "ASSOCIATION",
  "ASSN",
  "CONDOMINIUM",
  "CONDO",
  "APARTMENTS",
  // Religious
  "CHURCH",
  "CHAPEL",
  "SYNAGOGUE",
  "MOSQUE",
  "MINISTRIES",
  "MINISTRY",
  "DIOCESE",
  "CATHEDRAL",
  "CONGREGATION",
  "TABERNACLE",
  "BAPTIST",
  "LUTHERAN",
  "METHODIST",
  "CATHOLIC",
  "PRESBYTERIAN",
  "EPISCOPAL",
  "PENTECOSTAL",
  // Civic, medical and educational
  "HOSPITAL",
  "CLINIC",
  "HEALTHCARE",
  "UNIVERSITY",
  "COLLEGE",
  "SCHOOL",
  "ACADEMY",
  "FOUNDATION",
  "AUTHORITY",
  "SOCIETY",
  "INSTITUTE",
  "MUNICIPAL",
  "COMMISSION",
  "YMCA",
  "SALVATION",
  "COUNCIL",
  "FEDERATION",
]);

/**
 * Tokens that end a person's name. A trailing single letter is a middle
 * initial; the rest are generational and professional suffixes. "SMAW CHURCH E
 * III" is a man whose surname is Church, and this is what keeps him out.
 */
const PERSONAL_NAME_TAILS = new Set(["JR", "SR", "II", "III", "IV", "V", "VI", "MD", "DDS", "ESQ"]);

export interface OwnerNameCharacter {
  /** What the name looks like. Never a claim about the registry. */
  kind: "person" | "organisation";
  /** The token the rule fired on, so the label can show its own reasoning. */
  token: string | null;
}

/**
 * Does this owner name look like an organisation rather than a person?
 *
 * A heuristic on the published name string, and nothing more. The roll does not
 * publish an owner-type column, so there is no authoritative answer to read;
 * what there is, is a name written by a clerk. So this reads the name, says
 * which token made it decide, and is wired into surfaces that LABEL rather than
 * surfaces that filter. No row is dropped on the strength of it, which is the
 * lesson `dwellingsOnly` records in lib/criteria/types.ts.
 *
 * Measured on the bundled Duval extract (75,988 parcels, 64,520 distinct owner
 * names): 4,197 names classify as organisations, covering 9,670 parcels, 12.73
 * per cent. Reading every keyword-only match and every legal-form match with a
 * person-shaped tail found one false positive, BRIAN AND MEGAN CHURCH FAMILY,
 * which is one name in 4,197 (0.02 per cent). It under-labels on purpose: an
 * entity whose name carries no vocabulary word at all, such as "TKJ" or a
 * truncated "MILE HIGH TL BORROWER 1 CORE L", stays a person here.
 */
export function ownerNameCharacter(name: string | null | undefined): OwnerNameCharacter {
  if (!name) return { kind: "person", token: null };

  const tokens = name.toUpperCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: "person", token: null };

  // Skipped at index 0 throughout: see ORGANISATION_LEGAL_FORMS.
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (ORGANISATION_LEGAL_FORMS.has(token)) return { kind: "organisation", token };
  }

  const tail = tokens[tokens.length - 1] as string;
  const endsLikeAPerson = tail.length === 1 || PERSONAL_NAME_TAILS.has(tail);
  if (!endsLikeAPerson) {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] as string;
      if (ORGANISATION_WORDS.has(token)) return { kind: "organisation", token };
    }
  }

  // Government, which the roll writes with the qualifier in front.
  if (
    (tokens[0] === "CITY" || tokens[0] === "STATE" || tokens[0] === "TOWN") &&
    tokens[1] === "OF"
  ) {
    return { kind: "organisation", token: `${tokens[0]} OF` };
  }

  return { kind: "person", token: null };
}

/** True when the published owner name looks like an organisation. */
export function isOrganisationOwner(name: string | null | undefined): boolean {
  return ownerNameCharacter(name).kind === "organisation";
}
