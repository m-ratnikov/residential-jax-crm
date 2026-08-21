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

import { api, post, type ApiError } from "@/lib/client";
import { Badge, Button, Empty, Panel, ScoreBadge, Spinner, cx, money, when } from "./ui";

interface PropertyDetail {
  property: {
    propertyId: string;
    address: string;
    ownerName: string | null;
    provenance: {
      sourceSystem: string | null;
      sourceUrl: string | null;
      fetchedAt: string | null;
      runId: string | null;
      sourceArtifact: string | null;
      sourceSha256: string | null;
    };
    raw: Record<string, unknown>;
  };
  groups: { title: string; description: string; columns: string[] }[];
  otherColumns: string[];
  court: {
    id: string;
    caseNumber: string;
    caseType: string;
    filedDate: string | null;
    partyName: string | null;
    amount: number | null;
    status: string | null;
    sourceSystem: string;
    sourceUrl: string | null;
  }[];
  opportunity: { id: string; stage: string } | null;
  simulated: boolean;
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

function renderValue(column: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "not published";
  if (typeof value === "boolean") return value ? "yes" : "no";
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
  criteria?: unknown;
  onTracked?: (opportunityId: string) => void;
}

export function PropertyDrawer({
  propertyId,
  onClose,
  score,
  rationale,
  savedSearchId,
  criteria,
  onTracked,
}: PropertyDrawerProps) {
  const [detail, setDetail] = useState<PropertyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!propertyId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowAll(false);
    api<PropertyDetail>(`/api/property/${encodeURIComponent(propertyId)}`)
      .then((body) => {
        if (!cancelled) setDetail(body);
      })
      .catch((cause: ApiError) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (!propertyId) return null;

  const track = async () => {
    setTracking(true);
    setError(null);
    try {
      const result = await post<{ opportunity: { id: string }; created: boolean }>(
        "/api/opportunities",
        { propertyId, savedSearchId: savedSearchId ?? null, criteria: criteria ?? undefined },
      );
      onTracked?.(result.opportunity.id);
      setDetail((current) =>
        current
          ? { ...current, opportunity: { id: result.opportunity.id, stage: "identified" } }
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
          <h2 className="truncate text-sm font-semibold">
            {detail?.property.address ?? "Loading parcel"}
          </h2>
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
                <Badge tone="accent">In pipeline - {detail.opportunity.stage.replace("_", " ")}</Badge>
              ) : (
                <Button size="sm" variant="primary" onClick={track} disabled={tracking}>
                  {tracking ? "Adding" : "Track as opportunity"}
                </Button>
              )}
              {detail.simulated && (
                <Badge tone="warn" title="One or more values below came from a simulated pipeline update.">
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
              <Panel title="Court records" subtitle="Distress signals from the attached court source.">
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
                        {record.filedDate ? `filed ${record.filedDate.slice(0, 10)}` : "no filing date"}
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
                    <Row label="Artifact sha256" value={provenance.sourceSha256.slice(0, 24)} mono />
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

            {detail.groups.map((group) => (
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
              </Panel>
            ))}

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
