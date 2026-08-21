/**
 * The filter panel.
 *
 * Every control writes into the same `CriteriaSet` the API validates, the
 * matcher replays and the agent produces. There is no second, UI-only filter
 * shape, so what you see here is exactly what gets saved and exactly what runs
 * against the next pipeline refresh.
 *
 * Court-derived filters are disabled with a reason when no court source is
 * attached, rather than being offered and then quietly matching nothing.
 */

"use client";

import { useState } from "react";

import {
  CRITERIA_PRESETS,
  type CriteriaSet,
  type Filters,
  type Weights,
} from "@/lib/criteria/types";
import { Badge, Button, Field, Panel, Select, TextInput, Toggle, cx } from "./ui";

const DUVAL_CITIES = [
  "JACKSONVILLE",
  "JACKSONVILLE BEACH",
  "ATLANTIC BEACH",
  "NEPTUNE BEACH",
  "BALDWIN",
];

/**
 * Named areas people actually say out loud. The assignment's own demo script
 * asks for "the Arlington area", and a ZIP list is how that becomes a query
 * against published data without inventing a neighbourhood boundary the county
 * does not publish.
 */
export const NEIGHBOURHOODS: { id: string; label: string; zips: string[] }[] = [
  { id: "arlington", label: "Arlington", zips: ["32211", "32277", "32225"] },
  { id: "southside", label: "Southside", zips: ["32216", "32246", "32256"] },
  { id: "riverside", label: "Riverside and Avondale", zips: ["32204", "32205"] },
  { id: "northside", label: "Northside", zips: ["32208", "32209", "32218", "32219"] },
  { id: "westside", label: "Westside", zips: ["32210", "32221", "32244"] },
  { id: "beaches", label: "The Beaches", zips: ["32250", "32233", "32266"] },
  { id: "mandarin", label: "Mandarin and San Jose", zips: ["32217", "32223", "32257", "32258"] },
];

const PROPERTY_TYPES = [
  "RESIDENTIAL",
  "COMMERCIAL",
  "INDUSTRIAL",
  "AGRICULTURAL",
  "INSTITUTIONAL",
  "GOVERNMENTAL",
  "MISCELLANEOUS",
];

const OWNER_REGIONS = ["LOCAL", "REGIONAL", "NATIONAL", "FOREIGN"];

export interface CriteriaPanelProps {
  criteria: CriteriaSet;
  onChange: (criteria: CriteriaSet) => void;
  courtDataAvailable: boolean;
  onSave?: () => void;
  saving?: boolean;
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="border-t border-[var(--line)] px-4 py-3 first:border-t-0">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
      {hint && <p className="mt-1 text-[11px] text-ink-500">{hint}</p>}
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-accent-500 bg-accent-500/15 text-accent-400"
          : "border-[var(--line)] bg-[var(--panel-raised)] text-ink-400 hover:text-ink-100",
      )}
    >
      {children}
    </button>
  );
}

export function CriteriaPanel({
  criteria,
  onChange,
  courtDataAvailable,
  onSave,
  saving,
}: CriteriaPanelProps) {
  const [showWeights, setShowWeights] = useState(false);
  const filters = criteria.filters;

  const setFilters = (patch: Partial<Filters>) =>
    onChange({ ...criteria, filters: { ...filters, ...patch } });

  const setDistress = (patch: Partial<NonNullable<Filters["distress"]>>) =>
    setFilters({ distress: { ...(filters.distress ?? {}), ...patch } });

  const setWeights = (patch: Partial<Weights>) =>
    onChange({ ...criteria, weights: { ...criteria.weights, ...patch } });

  const toggleInList = (
    key: "cities" | "zips" | "propertyTypes" | "ownerRegionClasses",
    value: string,
  ) => {
    const current = filters[key] ?? [];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    setFilters({ [key]: next.length ? next : undefined } as Partial<Filters>);
  };

  const toggleNeighbourhood = (zips: string[]) => {
    const current = filters.zips ?? [];
    const allOn = zips.every((zip) => current.includes(zip));
    const next = allOn
      ? current.filter((zip) => !zips.includes(zip))
      : [...new Set([...current, ...zips])];
    setFilters({ zips: next.length ? next : undefined });
  };

  const activeCount = [
    filters.minYearsSinceSale,
    filters.minRoofAge,
    filters.maxRoofAge,
    filters.minAssessedValue,
    filters.maxAssessedValue,
    filters.minBuiltYear,
    filters.maxBuiltYear,
    filters.cities?.length,
    filters.zips?.length,
    filters.geometry,
    filters.waterView || undefined,
    filters.maxTransitDistanceM,
    filters.ownerRegionClasses?.length,
    filters.distress && Object.values(filters.distress).some(Boolean) ? 1 : undefined,
  ].filter((value) => value !== undefined && value !== null && value !== 0).length;

  return (
    <Panel
      title="Target criteria"
      subtitle={`${activeCount} active ${activeCount === 1 ? "filter" : "filters"}`}
      bodyClassName="panel-scroll p-0"
      actions={
        onSave && (
          <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>
            {saving ? "Saving" : "Save search"}
          </Button>
        )
      }
      className="flex h-full min-h-0 flex-col"
    >
      <>
        <Section title="Start from a thesis" hint="Each one states the rule it applies.">
          <div className="flex flex-wrap gap-1.5">
            {CRITERIA_PRESETS.map((preset) => (
              <Chip
                key={preset.id}
                active={criteria.name === preset.name}
                title={preset.description}
                onClick={() =>
                  onChange({
                    ...preset.criteria,
                    // Keep any area the user has already drawn.
                    filters: { ...preset.criteria.filters, geometry: filters.geometry },
                  })
                }
              >
                {preset.name}
              </Chip>
            ))}
            <Chip
              active={false}
              onClick={() =>
                onChange({
                  name: "Untitled search",
                  filters: {
                    residentialOnly: true,
                    dwellingsOnly: true,
                    geometry: filters.geometry,
                  },
                  weights: criteria.weights,
                })
              }
            >
              Clear all
            </Chip>
          </div>
        </Section>

        <Section title="Ownership tenure" hint="From years_since_last_sale on the published roll.">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Held at least (years)">
              <TextInput
                type="number"
                value={filters.minYearsSinceSale?.toString() ?? ""}
                onChange={(value) => setFilters({ minYearsSinceSale: numberOrUndefined(value) })}
                placeholder="10"
              />
            </Field>
            <Field label="At most (years)">
              <TextInput
                type="number"
                value={filters.maxYearsSinceSale?.toString() ?? ""}
                onChange={(value) => setFilters({ maxYearsSinceSale: numberOrUndefined(value) })}
                placeholder="any"
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Roof age"
          hint="A basis containing PROXY means the county publishes no roof date and the year built stands in."
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label="Older than (years)">
              <TextInput
                type="number"
                value={filters.minRoofAge?.toString() ?? ""}
                onChange={(value) => setFilters({ minRoofAge: numberOrUndefined(value) })}
                placeholder="15"
              />
            </Field>
            <Field label="Younger than (years)">
              <TextInput
                type="number"
                value={filters.maxRoofAge?.toString() ?? ""}
                onChange={(value) => setFilters({ maxRoofAge: numberOrUndefined(value) })}
                placeholder="any"
              />
            </Field>
          </div>
          <Toggle
            checked={Boolean(filters.requireRoofEvidence)}
            onChange={(checked) => setFilters({ requireRoofEvidence: checked || undefined })}
            label="Only roofs with real evidence"
            hint="Excludes parcels whose roof age is inferred from the year built."
          />
        </Section>

        <Section title="Value">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Assessed from">
              <TextInput
                type="number"
                value={filters.minAssessedValue?.toString() ?? ""}
                onChange={(value) => setFilters({ minAssessedValue: numberOrUndefined(value) })}
                placeholder="80000"
              />
            </Field>
            <Field label="Assessed to">
              <TextInput
                type="number"
                value={filters.maxAssessedValue?.toString() ?? ""}
                onChange={(value) => setFilters({ maxAssessedValue: numberOrUndefined(value) })}
                placeholder="250000"
              />
            </Field>
          </div>
        </Section>

        <Section title="Structure">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Built from">
              <TextInput
                type="number"
                value={filters.minBuiltYear?.toString() ?? ""}
                onChange={(value) => setFilters({ minBuiltYear: numberOrUndefined(value) })}
                placeholder="any"
              />
            </Field>
            <Field label="Built to">
              <TextInput
                type="number"
                value={filters.maxBuiltYear?.toString() ?? ""}
                onChange={(value) => setFilters({ maxBuiltYear: numberOrUndefined(value) })}
                placeholder="1990"
              />
            </Field>
          </div>
          <Toggle
            checked={filters.residentialOnly !== false}
            onChange={(checked) => setFilters({ residentialOnly: checked })}
            label="Residential only"
            hint="property_type = RESIDENTIAL"
          />
          <Toggle
            checked={filters.dwellingsOnly !== false}
            onChange={(checked) => setFilters({ dwellingsOnly: checked })}
            label="Has a dwelling"
            hint="At least 400 sq ft of livable floor area, and a value on the roll. Excludes HOA common areas, retention ponds and 55 sq ft condo garage units, which are absentee owned with no homestead and so score highly on a distress thesis that nobody lives in."
          />
          {filters.residentialOnly === false && (
            <div className="flex flex-wrap gap-1.5">
              {PROPERTY_TYPES.map((type) => (
                <Chip
                  key={type}
                  active={filters.propertyTypes?.includes(type) ?? false}
                  onClick={() => toggleInList("propertyTypes", type)}
                >
                  {type.toLowerCase()}
                </Chip>
              ))}
            </div>
          )}
        </Section>

        <Section title="Geography" hint="Draw an area on the map, or pick named areas by ZIP.">
          <div className="flex flex-wrap gap-1.5">
            {NEIGHBOURHOODS.map((area) => (
              <Chip
                key={area.id}
                active={area.zips.every((zip) => filters.zips?.includes(zip))}
                title={`ZIPs ${area.zips.join(", ")}`}
                onClick={() => toggleNeighbourhood(area.zips)}
              >
                {area.label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DUVAL_CITIES.map((city) => (
              <Chip
                key={city}
                active={filters.cities?.includes(city) ?? false}
                onClick={() => toggleInList("cities", city)}
              >
                {city.toLowerCase()}
              </Chip>
            ))}
          </div>
          {filters.geometry && (
            <div className="flex items-center gap-2">
              <Badge tone="accent">
                {filters.geometry.type === "circle"
                  ? "Radius drawn on the map"
                  : filters.geometry.type === "polygon"
                    ? "Polygon drawn on the map"
                    : "Map view area"}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => setFilters({ geometry: undefined })}>
                Remove
              </Button>
            </div>
          )}
        </Section>

        <Section title="Owner">
          <div className="flex flex-wrap gap-1.5">
            {OWNER_REGIONS.map((region) => (
              <Chip
                key={region}
                active={filters.ownerRegionClasses?.includes(region) ?? false}
                title="Derived from the tax mailing address, not proof of residence."
                onClick={() => toggleInList("ownerRegionClasses", region)}
              >
                {region.toLowerCase()}
              </Chip>
            ))}
          </div>
        </Section>

        <Section
          title="Distress signals"
          hint={
            courtDataAvailable
              ? "Roll signals are always available. Court signals come from the attached court source."
              : "Court signals need a CRM store with court records attached. Roll signals still work."
          }
        >
          <Toggle
            checked={Boolean(filters.distress?.absenteeOwner)}
            onChange={(checked) => setDistress({ absenteeOwner: checked || undefined })}
            label="Absentee owner"
            hint="Mails somewhere other than the property."
          />
          <Toggle
            checked={Boolean(filters.distress?.noHomestead)}
            onChange={(checked) => setDistress({ noHomestead: checked || undefined })}
            label="No homestead exemption"
          />
          <Toggle
            disabled={!courtDataAvailable}
            checked={Boolean(filters.distress?.hasForeclosure)}
            onChange={(checked) => setDistress({ hasForeclosure: checked || undefined })}
            label="Foreclosure filing"
          />
          <Toggle
            disabled={!courtDataAvailable}
            checked={Boolean(filters.distress?.hasLien)}
            onChange={(checked) => setDistress({ hasLien: checked || undefined })}
            label="Recorded lien"
          />
          <Toggle
            disabled={!courtDataAvailable}
            checked={Boolean(filters.distress?.hasCodeEnforcement)}
            onChange={(checked) => setDistress({ hasCodeEnforcement: checked || undefined })}
            label="Code enforcement case"
          />
          <Toggle
            disabled={!courtDataAvailable}
            checked={Boolean(filters.distress?.hasProbate)}
            onChange={(checked) => setDistress({ hasProbate: checked || undefined })}
            label="Probate case"
          />
        </Section>

        <Section title="Amenity signals" hint="Published by the pipeline as proximity proxies.">
          <Toggle
            checked={Boolean(filters.waterView)}
            onChange={(checked) => setFilters({ waterView: checked || undefined })}
            label="Water view"
            hint="A proximity proxy, not a confirmed view."
          />
          <Field label="Within metres of a transit stop">
            <TextInput
              type="number"
              value={filters.maxTransitDistanceM?.toString() ?? ""}
              onChange={(value) => setFilters({ maxTransitDistanceM: numberOrUndefined(value) })}
              placeholder="800"
            />
          </Field>
        </Section>

        <Section title="Ranking">
          <button
            type="button"
            onClick={() => setShowWeights((value) => !value)}
            className="text-[11px] text-accent-400 hover:underline"
          >
            {showWeights ? "Hide weights" : "Adjust how matches are ranked"}
          </button>
          {showWeights && (
            <div className="space-y-2">
              <p className="text-[11px] text-ink-500">
                Only criteria you have set take part in the score. Weights are relative and are
                normalised across the ones in play.
              </p>
              {(
                [
                  ["tenure", "Ownership tenure"],
                  ["roofAge", "Roof age"],
                  ["distress", "Distress signals"],
                  ["value", "Assessed value"],
                  ["geography", "Distance from centre"],
                  ["amenity", "Amenity signals"],
                ] as [keyof Weights, string][]
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-[12px]">
                  <span className="w-40 text-ink-400">{label}</span>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={1}
                    value={criteria.weights[key]}
                    onChange={(event) =>
                      setWeights({ [key]: Number(event.target.value) } as Partial<Weights>)
                    }
                    className="flex-1 accent-[var(--color-accent-500)]"
                  />
                  <span className="tabular w-4 text-right text-ink-300">
                    {criteria.weights[key]}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Section>
      </>
    </Panel>
  );
}

export { DUVAL_CITIES, PROPERTY_TYPES, OWNER_REGIONS };
