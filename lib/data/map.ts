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
