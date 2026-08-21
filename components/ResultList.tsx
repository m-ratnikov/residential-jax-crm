/**
 * The ranked list beside the map.
 *
 * Two things every row has to carry, because they are what the story asks for
 * and what a reviewer will look for: a match score with a rationale that names
 * the values behind it, and a visible marker when the parcel is already being
 * worked. An analyst scanning this list is deciding what to touch next, and a
 * list that does not say "someone is already talking to this owner" wastes
 * their afternoon.
 */

"use client";

import type { SearchRow } from "@/lib/client";
import { Badge, Button, ScoreBadge, cx, count, money } from "./ui";

export interface ResultListProps {
  rows: SearchRow[];
  total: number;
  loading: boolean;
  selectedId: string | null;
  onSelect: (propertyId: string) => void;
  onLoadMore?: () => void;
  hasMore: boolean;
  sql: string;
  tookMs: number;
  orderBy: "score" | "assessed_value" | "roof_age" | "tenure";
  onOrderChange: (value: "score" | "assessed_value" | "roof_age" | "tenure") => void;
}

const ORDER_OPTIONS = [
  { value: "score", label: "Match score" },
  { value: "assessed_value", label: "Cheapest" },
  { value: "roof_age", label: "Oldest roof" },
  { value: "tenure", label: "Longest held" },
] as const;

export function ResultList({
  rows,
  total,
  loading,
  selectedId,
  onSelect,
  onLoadMore,
  hasMore,
  sql,
  tookMs,
  orderBy,
  onOrderChange,
}: ResultListProps) {
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">
            {loading ? "Searching" : `${count(total)} matches`}
          </h2>
          <p className="text-[11px] text-ink-500">
            {rows.length ? `Showing ${count(rows.length)}` : "No parcels match these criteria"}
            {tookMs ? ` - ${tookMs} ms` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {ORDER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onOrderChange(option.value)}
              className={cx(
                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                orderBy === option.value
                  ? "bg-[var(--panel-raised)] text-ink-100"
                  : "text-ink-500 hover:text-ink-200",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && !loading && (
          <div className="px-4 py-10 text-center text-xs text-ink-500">
            Nothing matched. Loosen a threshold, widen the area, or start from one of the theses at
            the top of the criteria panel.
          </div>
        )}

        <ul>
          {rows.map((row) => (
            <li key={row.propertyId}>
              <button
                type="button"
                onClick={() => onSelect(row.propertyId)}
                className={cx(
                  "w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition-colors",
                  selectedId === row.propertyId
                    ? "bg-accent-500/10"
                    : "hover:bg-[var(--panel-raised)]",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink-100">{row.address}</p>
                    <p className="truncate text-[11px] text-ink-500">
                      {row.ownerName ?? "owner not published"}
                    </p>
                  </div>
                  <ScoreBadge score={row.score} title={row.rationale} />
                </div>

                <div className="tabular mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400">
                  <span>{money(row.assessedValue)}</span>
                  {row.builtYear !== null && <span>built {row.builtYear}</span>}
                  {row.roofAgeYears !== null && (
                    <span
                      title={
                        row.roofAgeBasis?.includes("PROXY")
                          ? "Estimated from the year built: the county publishes no roof date for this parcel."
                          : `Roof age basis: ${row.roofAgeBasis ?? "unknown"}`
                      }
                    >
                      roof {row.roofAgeYears}y{row.roofAgeBasis?.includes("PROXY") ? "*" : ""}
                    </span>
                  )}
                  {row.yearsSinceLastSale !== null && <span>held {row.yearsSinceLastSale}y</span>}
                </div>

                <div className="mt-1.5 flex flex-wrap gap-1">
                  {row.opportunityId && <Badge tone="accent">In pipeline</Badge>}
                  {row.simulated && (
                    <Badge tone="warn" title="A value on this parcel came from a simulated pipeline update.">
                      simulated
                    </Badge>
                  )}
                  {Number(row.courtForeclosureCount ?? 0) > 0 && <Badge tone="bad">foreclosure</Badge>}
                  {Number(row.courtLienCount ?? 0) > 0 && <Badge tone="bad">lien</Badge>}
                  {row.ownerOccupied === false && <Badge tone="outline">absentee</Badge>}
                  {row.waterViewFlag && <Badge tone="outline">water view</Badge>}
                  {row.ownerRegionClass && row.ownerRegionClass !== "LOCAL" && (
                    <Badge tone="outline">{row.ownerRegionClass.toLowerCase()} owner</Badge>
                  )}
                </div>

                <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-500">
                  {row.rationale}
                </p>
              </button>
            </li>
          ))}
        </ul>

        {hasMore && (
          <div className="p-3">
            <Button size="sm" onClick={onLoadMore} disabled={loading} className="w-full">
              {loading ? "Loading" : `Load more (${count(total - rows.length)} remaining)`}
            </Button>
          </div>
        )}
      </div>

      {sql && (
        <details className="border-t border-[var(--line)] px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">
            Show the SQL behind this result
          </summary>
          <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 text-[11px] text-ink-400">
            {sql}
          </pre>
        </details>
      )}
    </div>
  );
}
