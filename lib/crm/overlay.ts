/**
 * Assembling the query overlay from the CRM store.
 *
 * Two sources feed it: court filings, which are real records ingested
 * continuously, and simulated pipeline changes, which are the demo's way of
 * producing a genuine data movement rather than a staged notification. Both end
 * up in the same relation, so the criteria builder cannot tell them apart and
 * nothing about the alert path is special-cased for the demo.
 */

import {
  courtDistressScore,
  OVERRIDABLE_COLUMNS,
  type CourtAggregate,
  type OverridableColumn,
  type Overlay,
  type PropertyOverride,
} from "@/lib/data/overlay";
import { crmStore } from "./db";
import type { CourtDoc, SimulatedDoc } from "./documents";

const OVERRIDABLE = new Set<string>(OVERRIDABLE_COLUMNS);

/** Columns whose overlay values are numbers, so a stored string is cast back. */
const NUMERIC_COLUMNS = new Set<OverridableColumn>([
  "assessed_value",
  "market_value",
  "last_sale_price",
  "years_since_last_sale",
  "roof_year_est",
  "roof_age_years",
  "permit_count",
  "roof_permit_count",
]);

const BOOLEAN_COLUMNS = new Set<OverridableColumn>(["owner_occupied", "homestead_flag"]);

function parseValue(
  column: OverridableColumn,
  raw: string | null,
): string | number | boolean | null {
  if (raw === null) return null;
  if (NUMERIC_COLUMNS.has(column)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (BOOLEAN_COLUMNS.has(column)) return raw === "true" || raw === "t" || raw === "1";
  return raw;
}

/** A filing that is finished is not a distress signal any more. */
const CLOSED_STATUSES = new Set(["dismissed", "satisfied", "closed"]);

export interface OverlaySummary {
  overlay: Overlay;
  /** True when court predicates can be evaluated at all. */
  courtDataAvailable: boolean;
  courtPropertyCount: number;
  simulatedPropertyCount: number;
  /** Distinct synthetic run ids currently applied. */
  simulatedRunIds: string[];
}

export const EMPTY_OVERLAY_SUMMARY: OverlaySummary = {
  overlay: { court: [], overrides: [] },
  courtDataAvailable: false,
  courtPropertyCount: 0,
  simulatedPropertyCount: 0,
  simulatedRunIds: [],
};

export async function loadOverlay(): Promise<OverlaySummary> {
  const store = crmStore();

  let courtDocs: CourtDoc[] = [];
  let simulatedDocs: SimulatedDoc[] = [];

  try {
    [courtDocs, simulatedDocs] = await Promise.all([
      store.list<CourtDoc>("court"),
      store.list<SimulatedDoc>("simulated"),
    ]);
  } catch {
    // A store that cannot be read is a CRM without an overlay, not a broken
    // search: the parcels are read in the browser and need none of this.
    return EMPTY_OVERLAY_SUMMARY;
  }

  const court: CourtAggregate[] = [];
  for (const doc of courtDocs) {
    const open = doc.records.filter(
      (record) => !CLOSED_STATUSES.has((record.status ?? "").toLowerCase()),
    );
    if (!open.length) continue;

    const counts = {
      lienCount: open.filter((record) => record.caseType === "lien").length,
      foreclosureCount: open.filter((record) => record.caseType === "foreclosure").length,
      codeEnforcementCount: open.filter((record) => record.caseType === "code_enforcement").length,
      probateCount: open.filter((record) => record.caseType === "probate").length,
      latestFilingDate:
        open
          .map((record) => record.filedDate)
          .filter((date): date is string => Boolean(date))
          .sort()
          .at(-1) ?? null,
    };

    court.push({
      propertyId: doc.propertyId,
      ...counts,
      distressScore: courtDistressScore(counts),
    });
  }

  // Ordered oldest first, because `simulatedRunIds` below is read as "the
  // latest simulation" by taking its last element - `.at(-1)`, in
  // lib/notify/matcher.ts. `store.list()` returns documents in the store's own
  // listing order, which for the GitHub-documents backend is the git tree
  // order (alphabetical by property id), not creation order. Two consecutive
  // simulations were observed resolving to the SAME "latest" run id because
  // the alphabetically-last property id in the collection did not change
  // between them: the second, genuinely new simulation was then evaluated
  // against a stale run id that already had an alert on record for it, and the
  // retry-safety guard in evaluateAndAlert (correctly) treated it as a repeat
  // of a pass it had already delivered and raised nothing.
  const orderedDocs = [...simulatedDocs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const overrides: PropertyOverride[] = orderedDocs.map((doc) => {
    const values: PropertyOverride["values"] = {};
    for (const [column, raw] of Object.entries(doc.values)) {
      if (!OVERRIDABLE.has(column)) continue;
      const typed = column as OverridableColumn;
      values[typed] = parseValue(typed, raw);
    }
    return { propertyId: doc.propertyId, values, runId: doc.runId };
  });

  return {
    overlay: { court, overrides },
    // Court predicates are available whenever a store is attached, even with no
    // filings yet: "no liens recorded" is a real answer, and the alternative is
    // a filter that appears and disappears as data arrives.
    courtDataAvailable: true,
    courtPropertyCount: court.length,
    simulatedPropertyCount: overrides.length,
    // De-duplicated in createdAt order, so the last distinct id is whichever
    // simulation actually ran most recently, not whichever one happens to
    // touch the alphabetically-last parcel.
    simulatedRunIds: [...new Set(overrides.map((entry) => entry.runId).filter(Boolean))],
  };
}
