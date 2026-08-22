/**
 * The parcel detail drawer.
 *
 * Columns are grouped exactly as the pipeline's own column contract groups them,
 * so the CRM and the dataset describe the same record the same way, and any
 * column the pipeline adds later appears under "other published columns"
 * without a change here.
 *
 * Provenance is given its own block rather than being tucked into a footnote:
 * "preserve source provenance for all displayed records" is an acceptance
 * criterion, and a source url a reviewer can click is the proof.
 */

"use client";

import { useEffect, useState } from "react";

import { post } from "@/lib/client";
import { COLUMN_GROUPS, ungroupedColumns } from "@/lib/oracle/columns";
import { tenureCaveat } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import { fetchOverlay, propertySource } from "@/lib/data/client-source";
import type { OwnerDoc } from "@/lib/crm/documents";
import type { PropertyRecord } from "@/lib/data/types";
import {
  Badge,
  Button,
  Empty,
  Panel,
  ScoreBadge,
  SimulatedContact,
  Spinner,
  cx,
  money,
  toDate,
  when,
  year,
} from "./ui";

interface CourtRecordRow {
  id: string;
  caseNumber: string;
  caseType: string;
  filedDate: string | null;
  partyName: string | null;
  amount: number | null;
  status: string | null;
  sourceSystem: string;
  sourceUrl: string | null;
}

interface PropertyDetail {
  property: PropertyRecord;
  address: string;
  groups: { title: string; description: string; columns: string[] }[];
  otherColumns: string[];
  court: CourtRecordRow[];
  opportunity: { id: string; stage: string } | null;
  /**
   * The owner document, once the parcel is tracked. Its mailing address is real
   * and comes from the roll; its `skipTrace` block is a simulation and is
   * rendered as one. See lib/crm/skip-trace.ts.
   */
  owner: OwnerDoc | null;
  simulated: boolean;
}

/** What GET /api/property/[id] answers with. */
interface PropertyCrmResponse {
  opportunity?: { id: string; stage: string } | null;
  owner?: OwnerDoc | null;
  court?: CourtRecordRow[];
}

const CURRENCY = new Set([
  "assessed_value",
  "market_value",
  "land_value",
  "avm_value",
  "taxable_value",
  "assessed_value_school",
  "last_sale_price",
]);

const METRES = new Set(["water_dist_m", "nearest_transit_stop_m", "nearest_starbucks_m"]);

/**
 * Columns whose number is a year rather than a quantity. Thousands separators
 * belong on assessed_value and livable_floor_area; on a year they turn 1916
 * into "1,916", which reads as a typo in a record a reviewer is checking.
 *
 * Note this is the calendar-year columns only. years_since_last_sale and
 * roof_age_years are durations, and stay in the ordinary number branch.
 */
export const YEAR_COLUMNS = new Set([
  "built_year",
  "eff_year_built",
  "pa_actual_year_built",
  "roof_year_est",
  "last_roof_permit_year",
]);

/**
 * Columns published as a parquet TIMESTAMP. Those cross Arrow into the browser
 * as epoch milliseconds, so without this they render as "1,787,320,736,294".
 * source_fetched_at and features_as_of are published as text and are left as
 * published: features_as_of is a bare date, and turning it into a local
 * timestamp would move it a day in every negative UTC offset.
 */
export const TIMESTAMP_COLUMNS = new Set(["fetched_at"]);

export function renderValue(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "not published";
  if (typeof value === "boolean") return value ? "yes" : "no";
  // Both of these are checked before the number branch, because the value
  // arrives as a number and would otherwise be formatted as a quantity.
  if (YEAR_COLUMNS.has(column)) return year(value);
  if (TIMESTAMP_COLUMNS.has(column)) {
    const at = toDate(value);
    return at ? when(at) : String(value);
  }
  if (typeof value === "number") {
    if (CURRENCY.has(column)) return money(value);
    if (METRES.has(column)) return `${Math.round(value).toLocaleString("en-US")} m`;
    return value.toLocaleString("en-US");
  }
  return String(value);
}

export interface PropertyDrawerProps {
  propertyId: string | null;
  onClose: () => void;
  /** Score and rationale from the current search, when the parcel came from one. */
  score?: number | null;
  rationale?: string | null;
  savedSearchId?: string | null;
  onTracked?: (opportunityId: string) => void;
}

export function PropertyDrawer({
  propertyId,
  onClose,
  score,
  rationale,
  savedSearchId,
  onTracked,
}: PropertyDrawerProps) {
  // The parent mounts this with `key={propertyId}`, so a different parcel is a
  // different component instance. That is what makes these initialisers the
  // whole reset: without the key, opening a second parcel would show the first
  // one's values until the fetch came back, and clearing the four of them at
  // the top of the effect would render the stale parcel once first anyway.
  const [detail, setDetail] = useState<PropertyDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(propertyId));
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;

    // The parcel comes from the engine in this tab; the CRM's view of it - court
    // filings, and whether it is already being worked - comes from the server.
    void (async () => {
      try {
        const overlay = await fetchOverlay();
        const [property, crm] = await Promise.all([
          propertySource().getProperty(propertyId, overlay.overlay),
          fetch(`/api/property/${encodeURIComponent(propertyId)}`)
            .then((response) =>
              response.ok
                ? (response.json() as Promise<PropertyCrmResponse>)
                : ({ opportunity: null, owner: null, court: [] } satisfies PropertyCrmResponse),
            )
            .catch(
              () => ({ opportunity: null, owner: null, court: [] }) satisfies PropertyCrmResponse,
            ),
        ]);

        if (cancelled) return;
        if (!property) {
          setError(`No parcel ${propertyId} in the loaded dataset.`);
          setDetail(null);
          return;
        }

        const available = Object.keys(property.raw);
        setDetail({
          property,
          address: displayAddress(property),
          groups: COLUMN_GROUPS.map((group) => ({
            title: group.title,
            description: group.description,
            columns: group.columns.filter((column) => available.includes(column)),
          })).filter((group) => group.columns.length),
          otherColumns: ungroupedColumns(available),
          court: crm.court ?? [],
          opportunity: crm.opportunity ?? null,
          owner: crm.owner ?? null,
          simulated: Boolean(property.raw["overlay_run_id"]),
        });
      } catch (cause: unknown) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not read the parcel.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (!propertyId) return null;

  const track = async () => {
    setTracking(true);
    setError(null);
    try {
      if (!detail) throw new Error("The parcel is still loading.");
      const property = detail.property;

      // The parcel as this tab read it, which is the authoritative record: the
      // query engine lives here, so re-reading it on the server would need a
      // second engine to arrive at the same answer.
      const result = await post<{ opportunity: { id: string }; created: boolean }>(
        "/api/opportunities",
        {
          propertyId,
          parcelIdentifier: property.parcelIdentifier,
          addressLine: detail.address,
          addressCity: property.addressCity,
          addressZip: property.addressZip,
          latitude: property.latitude,
          longitude: property.longitude,
          assessedValue: property.assessedValue,
          ownerName: property.ownerName,
          ownerMailingAddress: property.ownerMailingAddress,
          ownerMailingCity: property.ownerMailingCity,
          ownerMailingState: property.ownerMailingState,
          ownerMailingZip: property.ownerMailingZip,
          sourceSystem: property.provenance.sourceSystem,
          sourceUrl: property.provenance.sourceUrl,
          propertySnapshot: {
            builtYear: property.builtYear,
            livableFloorArea: property.livableFloorArea,
            roofAgeYears: property.roofAgeYears,
            roofAgeBasis: property.roofAgeBasis,
            yearsSinceLastSale: property.yearsSinceLastSale,
            lastSaleDate: property.lastSaleDate,
            lastSalePrice: property.lastSalePrice,
            ownerOccupied: property.ownerOccupied,
            homesteadFlag: property.homesteadFlag,
            waterViewFlag: property.waterViewFlag,
            nearestTransitStopM: property.nearestTransitStopM,
            courtDistressScore: property.raw["court_distress_score"] ?? null,
            provenance: property.provenance,
          },
          matchScore: score ?? null,
          matchRationale: rationale ?? null,
          savedSearchId: savedSearchId ?? null,
        },
      );
      onTracked?.(result.opportunity.id);

      // Re-read the CRM's half of the record rather than guessing at it: the
      // owner document, and with it the simulated contact, is created by the
      // POST above and is what the contact panel below renders.
      const crm = await fetch(`/api/property/${encodeURIComponent(propertyId)}`)
        .then((response) =>
          response.ok ? (response.json() as Promise<PropertyCrmResponse>) : null,
        )
        .catch(() => null);

      setDetail((current) =>
        current
          ? {
              ...current,
              opportunity: crm?.opportunity ?? { id: result.opportunity.id, stage: "identified" },
              owner: crm?.owner ?? current.owner,
            }
          : current,
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not create the opportunity.");
    } finally {
      setTracking(false);
    }
  };

  const raw = detail?.property.raw ?? {};
  const provenance = detail?.property.provenance;

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[520px] flex-col border-l border-[var(--line)] bg-[var(--panel)] shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{detail?.address ?? "Loading parcel"}</h2>
          <p className="mono truncate text-[11px] text-ink-500">{propertyId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {typeof score === "number" && <ScoreBadge score={score} title={rationale ?? undefined} />}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {loading && <Spinner label="Reading the published record" />}
        {error && (
          <p className="rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
            {error}
          </p>
        )}

        {detail && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {detail.opportunity ? (
                <Badge tone="accent">
                  In pipeline - {detail.opportunity.stage.replace("_", " ")}
                </Badge>
              ) : (
                <Button size="sm" variant="primary" onClick={track} disabled={tracking}>
                  {tracking ? "Adding" : "Track as opportunity"}
                </Button>
              )}
              {detail.simulated && (
                <Badge
                  tone="warn"
                  title="One or more values below came from a simulated pipeline update."
                >
                  simulated values
                </Badge>
              )}
            </div>

            {rationale && (
              <Panel title="Why this scored">
                <p className="text-xs leading-relaxed text-ink-300">{rationale}</p>
              </Panel>
            )}

            {detail.court.length > 0 && (
              <Panel
                title="Court records"
                subtitle="Distress signals from the attached court source."
              >
                <ul className="space-y-2">
                  {detail.court.map((record) => (
                    <li key={record.id} className="rounded border border-[var(--line)] px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-ink-200">
                          {record.caseType.replace("_", " ")}
                        </span>
                        <Badge tone={record.status === "open" ? "bad" : "neutral"}>
                          {record.status ?? "unknown"}
                        </Badge>
                      </div>
                      <p className="mono mt-1 text-[11px] text-ink-500">{record.caseNumber}</p>
                      <p className="tabular mt-0.5 text-[11px] text-ink-400">
                        {record.filedDate
                          ? `filed ${record.filedDate.slice(0, 10)}`
                          : "no filing date"}
                        {record.amount ? ` - ${money(record.amount)}` : ""}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-500">
                        Source: {record.sourceSystem}
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <OwnerContact detail={detail} />

            {provenance && (
              <Panel title="Provenance" subtitle="Where this record came from.">
                <dl className="space-y-1.5 text-[11px]">
                  <Row label="Source system" value={provenance.sourceSystem ?? "not published"} />
                  <Row label="Collected" value={when(provenance.fetchedAt)} />
                  <Row label="Pipeline run" value={provenance.runId ?? "not published"} mono />
                  {provenance.sourceArtifact && (
                    <Row label="Artifact" value={provenance.sourceArtifact} mono />
                  )}
                  {provenance.sourceSha256 && (
                    <Row
                      label="Artifact sha256"
                      value={provenance.sourceSha256.slice(0, 24)}
                      mono
                    />
                  )}
                  {provenance.sourceUrl && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-ink-500">Source</dt>
                      <dd className="min-w-0 flex-1">
                        <a
                          href={provenance.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-accent-400 hover:underline"
                        >
                          {provenance.sourceUrl}
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>
              </Panel>
            )}

            {detail.groups.map((group) => {
              // The roll's own placeholder dates - 1899-12-30 and 1899-01-01 are
              // the two most common non-null values in the sale column - produce
              // tenures like 127 years on a house built in 1986. The published
              // numbers are shown unaltered because that is what the artifact
              // says, but they are not left to speak for themselves.
              const caveat = group.columns.includes("years_since_last_sale")
                ? tenureCaveat(detail.property)
                : null;

              return (
                <Panel key={group.title} title={group.title} subtitle={group.description}>
                  <dl className="space-y-1.5 text-[11px]">
                    {group.columns.map((column) => (
                      <Row
                        key={column}
                        label={column.replaceAll("_", " ")}
                        value={renderValue(column, raw[column])}
                      />
                    ))}
                  </dl>
                  {caveat && (
                    <p
                      data-testid="tenure-caveat"
                      className="mt-2 border-t border-ink-100 pt-2 text-[10px] leading-snug text-ink-500"
                    >
                      {caveat.charAt(0).toUpperCase() + caveat.slice(1)}.
                    </p>
                  )}
                </Panel>
              );
            })}

            {detail.otherColumns.length > 0 && (
              <Panel
                title="Other published columns"
                subtitle={`${detail.otherColumns.length} columns the CRM does not read by name.`}
                actions={
                  <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "Hide" : "Show"}
                  </Button>
                }
              >
                {showAll ? (
                  <dl className="space-y-1.5 text-[11px]">
                    {detail.otherColumns.map((column) => (
                      <Row
                        key={column}
                        label={column.replaceAll("_", " ")}
                        value={renderValue(column, raw[column])}
                      />
                    ))}
                  </dl>
                ) : (
                  <p className="text-[11px] text-ink-500">
                    Anything the pipeline publishes appears here without a change to this app.
                  </p>
                )}
              </Panel>
            )}
          </>
        )}

        {!loading && !detail && !error && <Empty title="Nothing to show" />}
      </div>
    </aside>
  );
}

/**
 * Who owns this parcel, and how an acquisitions team would reach them.
 *
 * Two blocks, deliberately not one. The first is the county roll: the owner of
 * record and the mailing address, which are real, and which carry the source
 * system they were read from. The second is a MOCKED skip trace, because the
 * roll publishes no telephone and no email and the alternative was every record
 * reading "not on file" for the one detail this panel exists to show.
 *
 * The simulated block is fenced, tinted, badged, and repeats the provider name
 * and the reason underneath the values. That is more shouting than a design
 * would normally want, and it is the point: a phone number on a CRM screen is
 * something somebody dials, so the one thing that must never happen is a
 * reviewer taking this for a real number.
 */
function OwnerContact({ detail }: { detail: PropertyDetail }) {
  const property = detail.property;
  const owner = detail.owner;
  const skipTrace = owner?.skipTrace ?? null;

  const name = owner?.name ?? property.ownerName;
  const mailing = [
    owner?.mailingAddress ?? property.ownerMailingAddress,
    owner?.mailingCity ?? property.ownerMailingCity,
    [
      owner?.mailingState ?? property.ownerMailingState,
      owner?.mailingZip ?? property.ownerMailingZip,
    ]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Panel
      title="Owner contact"
      subtitle="The roll publishes an owner and a mailing address. It publishes no telephone and no email."
    >
      <dl className="space-y-1.5 text-[11px]">
        <Row label="Owner of record" value={name ?? "not published"} />
        <Row label="Mailing address" value={mailing || "not published"} />
        <Row
          label="Address source"
          value={owner?.sourceSystem ?? property.provenance.sourceSystem ?? "not published"}
        />
      </dl>

      {skipTrace ? (
        <SimulatedContact contact={skipTrace} className="mt-3" />
      ) : (
        <p className="mt-3 rounded-md border border-[var(--line)] px-2.5 py-2 text-[11px] leading-relaxed text-ink-400">
          Tracking this parcel attaches a clearly labelled simulated telephone and email, so the
          outreach thread has something to address. Nothing here calls a skip-trace vendor.
        </p>
      )}

      {(owner?.email || owner?.phone) && (
        <dl className="mt-3 space-y-1.5 border-t border-[var(--line)] pt-2.5 text-[11px]">
          {owner.phone && <Row label="Phone (entered)" value={owner.phone} mono />}
          {owner.email && <Row label="Email (entered)" value={owner.email} mono />}
        </dl>
      )}
    </Panel>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-ink-500">{label}</dt>
      <dd className={cx("min-w-0 flex-1 break-words text-ink-200", mono ? "mono" : "tabular")}>
        {value}
      </dd>
    </div>
  );
}
