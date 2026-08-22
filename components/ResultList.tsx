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

import { useState } from "react";

import type { SearchRow } from "@/lib/client";
import { tenureCaveat, UNRANKED_EXPLANATION } from "@/lib/criteria/score";
import { rankedTenureYears, tenureConfidenceOf } from "@/lib/criteria/sql";
import { WEIGHT_LABELS, type CriteriaSet, type Weights } from "@/lib/criteria/types";
import type { ScoreComponent } from "@/lib/data/types";
import { downloadPropertyCsv } from "@/lib/data/export-csv";
import { MATCH_ID_CAP, TRACKED_MATCH_CAP } from "@/lib/notify/limits";
import { Badge, Button, OwnerKindBadge, ScoreBadge, cx, count, money } from "./ui";

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
  /** Passed so the export can re-run the same query for the full match set. */
  criteria: CriteriaSet;
  /**
   * True when results are restricted to the map's current view. Worth saying:
   * otherwise a count that dropped from 337,853 to 4,100 because somebody
   * zoomed in reads as criteria that stopped working.
   */
  limitedToView?: boolean;
}

const ORDER_OPTIONS = [
  { value: "score", label: "Match score" },
  { value: "assessed_value", label: "Cheapest" },
  { value: "roof_age", label: "Oldest roof" },
  { value: "tenure", label: "Longest held" },
] as const;

/**
 * The line under the heading, and the one rule it has to obey.
 *
 * A search that is still running has no result to describe, so it must not
 * describe one. The heading already switches to "Searching" while `loading` is
 * true and the empty state below the list is already gated on `!loading`; this
 * line was not, so every ordinary re-query - tightening a filter, drawing a
 * radius, pressing "Search this view" - flashed "No parcels match these
 * criteria" until the rows came back. Read quickly, that is a broken search.
 *
 * The three cases are mutually exclusive by construction: searching, results,
 * or nothing matched. `tookMs` is the previous query's timing while a new one
 * is in flight, so it is only quoted once the query it belongs to has finished.
 */
export function resultSummary({
  loading,
  rowCount,
  tookMs,
}: {
  loading: boolean;
  rowCount: number;
  tookMs: number;
}): string {
  if (loading) return "Querying the published parcels";
  if (rowCount === 0) return "No parcels match these criteria";
  return `Showing ${count(rowCount)}${tookMs ? ` - ${tookMs} ms` : ""}`;
}

/**
 * Whether this result set was ranked at all.
 *
 * Read off the rows rather than recomputed from the criteria, because the rows
 * are what the server actually scored: `buildScore` emits no components when
 * nothing in the criteria set can rank, and a flat 100 for every row. Asking
 * the answer of the data avoids a second copy of that decision on the client
 * that could disagree with the first.
 */
export function isUnrankedResult(rows: readonly { components: readonly unknown[] }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.components.length === 0);
}

/**
 * What the row is allowed to claim about ownership tenure.
 *
 * `held 127y` beside `built 1986` was the single most visible data-quality
 * defect in this list: 1,453 parcels on the published artifact carry the
 * county's placeholder sale date and the ramp read them as the longest holds in
 * Duval. The row now says what the roll actually supports.
 */
function TenureCell({ row }: { row: SearchRow }) {
  if (row.yearsSinceLastSale === null) return null;
  const facts = { yearsSinceLastSale: row.yearsSinceLastSale, builtYear: row.builtYear };
  const confidence = tenureConfidenceOf(facts);
  const caveat = tenureCaveat(facts);

  if (confidence === "RECORDED" || caveat === null) {
    return <span>held {row.yearsSinceLastSale}y</span>;
  }
  if (confidence === "PREDATES_STRUCTURE") {
    return (
      <span title={caveat} className="text-warn-500">
        held &le;{rankedTenureYears(facts) ?? 0}y*
      </span>
    );
  }
  return (
    <span title={caveat} className="text-warn-500">
      tenure unknown*
    </span>
  );
}

/**
 * What each criterion contributed, beside the total it adds up to.
 *
 * A single number cannot be argued with, and two parcels a point apart look
 * identical until you can see that one of them earned it on tenure and the
 * other on the roof. The bar is how much of that criterion the parcel earned,
 * the number is what it put into the score - both of them, because a bar alone
 * conveys meaning by length only, and the rest of this app says everything it
 * colours or sizes in words as well.
 */
function ScoreBreakdown({ components }: { components: readonly ScoreComponent[] }) {
  if (!components.length) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
      {components.map((component) => {
        const earned = Math.max(0, Math.min(1, component.value));
        const label = WEIGHT_LABELS[component.key as keyof Weights] ?? component.key;
        const contribution = Math.round(component.points * 10) / 10;
        return (
          <span
            key={component.key}
            className="flex items-center gap-1 text-ink-500"
            title={`${label}: ${component.label}. Earned ${Math.round(earned * 100)}% of this criterion, worth ${contribution} points of the score.`}
          >
            <span>{label}</span>
            <span
              aria-hidden
              className="block h-1 w-8 overflow-hidden rounded-full bg-[var(--panel-raised)]"
            >
              <span
                className="block h-full rounded-full bg-accent-500"
                style={{ width: `${earned * 100}%` }}
              />
            </span>
            <span className="tabular text-ink-400">+{contribution}</span>
          </span>
        );
      })}
    </div>
  );
}

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
  criteria,
  limitedToView = false,
}: ResultListProps) {
  const [exporting, setExporting] = useState(false);
  /*
    Asked of the rows on screen, and of nothing else.

    This used to be `!loading && isUnrankedResult(rows)`, borrowed from the rule
    `resultSummary` obeys: do not describe a result while one is being fetched.
    That rule is right about the summary line and exactly backwards here. Rows
    stay on screen for the whole of a query - `run()` clears `loading` only
    after the second search that fills the map, four thousand rows on a set of
    337,853 - and during that window every row fell back to the ranked branch:
    a green 100 badge on all one hundred of them, the same explanation repeated
    under each, and the note above the list gone. That is the wall of hundreds
    the note exists to prevent, shown at precisely the moment it is most
    misleading, and it is what a reviewer on the deployed runtime saw.

    The rows carry their own components, so they already answer this for
    themselves whether or not a newer query is in flight; while one is, they
    keep the ranking status they were actually scored with, exactly as they keep
    their scores and addresses. An empty list is still not an unranked one.
  */
  const unranked = isUnrankedResult(rows);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">
            {loading ? "Searching" : `${count(total)} matches`}
            {limitedToView && !loading && (
              <span className="ml-1.5 text-[11px] font-normal text-ink-500">in this view</span>
            )}
          </h2>
          <p className="text-[11px] text-ink-500">
            {resultSummary({ loading, rowCount: rows.length, tookMs })}
          </p>
          {/*
            The count above is what the criteria select. What saving them would
            WATCH is two different things, and saying only the smaller one
            understated the watch by two orders of magnitude:

            - membership, up to MATCH_ID_CAP - whether a parcel is in the set at
              all, which is what "newly matches" means and is the story's own
              promise;
            - field level history, the best TRACKED_MATCH_CAP by score, which is
              what lets an alert name which fields moved.

            Both are said here because this is the number somebody reads
            immediately before pressing "Save and watch".
          */}
          {!loading && total > TRACKED_MATCH_CAP && (
            <p
              className="text-[11px] text-ink-500"
              title={`A saved search records which parcels match, up to ${count(MATCH_ID_CAP)}, so a parcel that newly enters the set raises an alert wherever it ranks. It additionally fingerprints the top ${count(TRACKED_MATCH_CAP)} by score, which is what lets an alert name the fields that changed; a change to a lower ranked parcel that was already matching raises nothing.`}
            >
              {total > MATCH_ID_CAP ? (
                <>
                  Saving these criteria watches {count(MATCH_ID_CAP)} of {count(total)} for new
                  matches, and the top {count(TRACKED_MATCH_CAP)} by score for changes.
                </>
              ) : (
                <>
                  Saving these criteria watches all {count(total)} for new matches, and the top{" "}
                  {count(TRACKED_MATCH_CAP)} by score for changes to a parcel already matching.
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={exporting || !rows.length}
            title="Export every matching parcel, not just the page on screen."
            onClick={async () => {
              setExporting(true);
              try {
                await downloadPropertyCsv(criteria);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? "Exporting" : "Export"}
          </Button>
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

      {/*
        Said once, above the list, instead of on every row.

        It used to be the per-row rationale, line-clamped to two lines and
        repeated identically down the whole page, so the default search read as
        a wall of green 100 badges with an explanation nobody could finish. It
        is one fact about the criteria set, not a fact about a parcel, so it
        belongs where the criteria set is described.
      */}
      {unranked && (
        <p
          className="border-b border-[var(--line)] bg-warn-500/10 px-3 py-2 text-[11px] leading-snug text-ink-300"
          data-testid="unranked-notice"
        >
          <span className="font-medium text-warn-500">Not ranked.</span> {UNRANKED_EXPLANATION}
        </p>
      )}

      <div className="panel-scroll min-h-0 flex-1">
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
                  {unranked ? (
                    // A flat 100 painted good-green on every row reads as
                    // "every one of these is a perfect match". It means the
                    // opposite: nothing here could tell them apart.
                    <Badge
                      tone="outline"
                      title="Nothing in this criteria set can rank these matches. The note above the list says why."
                    >
                      unranked
                    </Badge>
                  ) : (
                    <ScoreBadge score={row.score} title={row.rationale} />
                  )}
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
                  <TenureCell row={row} />
                </div>

                <div className="mt-1.5 flex flex-wrap gap-1">
                  <OwnerKindBadge name={row.ownerName} />
                  {row.opportunityId && <Badge tone="accent">In pipeline</Badge>}
                  {row.simulated && (
                    <Badge
                      tone="warn"
                      title="A value on this parcel came from a simulated pipeline update."
                    >
                      simulated
                    </Badge>
                  )}
                  {Number(row.courtForeclosureCount ?? 0) > 0 && (
                    <Badge tone="bad">foreclosure</Badge>
                  )}
                  {Number(row.courtLienCount ?? 0) > 0 && <Badge tone="bad">lien</Badge>}
                  {row.ownerOccupied === false && <Badge tone="outline">absentee</Badge>}
                  {row.waterViewFlag && <Badge tone="outline">water view</Badge>}
                  {row.ownerRegionClass && row.ownerRegionClass !== "LOCAL" && (
                    <Badge tone="outline">{row.ownerRegionClass.toLowerCase()} owner</Badge>
                  )}
                </div>

                <ScoreBreakdown components={row.components} />

                {/*
                  Only when there is something parcel-specific to say. In an
                  unranked set every row carries the same sentence, and it is
                  already stated once above the list.
                */}
                {!unranked && (
                  <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-500">
                    {row.rationale}
                  </p>
                )}
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
