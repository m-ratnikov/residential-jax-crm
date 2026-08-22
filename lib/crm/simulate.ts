/**
 * Applying a simulated incremental pipeline update.
 *
 * The assignment asks to "simulate (or show a real) incremental pipeline update
 * that brings in a new or changed property matching the criteria". The honest
 * way to do that is to make a real change to the data the matcher reads, not to
 * inject a notification. So this writes rows the query overlay picks up, stamps
 * them with a synthetic run id, and lets the ordinary matcher pass find them by
 * diffing - the same path a genuine county refresh takes.
 *
 * Choosing WHICH parcels to affect needs parcel data, so that half happens in
 * the browser where the query engine lives. This module only applies a change to
 * targets it is handed, which is why it needs no engine at all.
 *
 * Two kinds, because the two halves of the story need different things:
 *
 * - A **court filing** brings parcels INTO a distress-based saved search that
 *   did not match before, which is the "new match" case.
 * - A **roll movement** moves a parcel that already matched, which is the
 *   "updated match" case.
 *
 * Everything written here is labelled and reversible: `sim-` run ids, a label
 * per row saying what it represents, and one call to clear it all out.
 */

import { randomUUID } from "node:crypto";

import { OVERRIDABLE_COLUMNS, type OverridableColumn } from "@/lib/data/overlay";
import { logEvent } from "@/lib/notify/log";
import { crmStore } from "./db";
import { nowIso, type CourtDoc, type CourtRecordDoc, type SimulatedDoc } from "./documents";

const OVERRIDABLE = new Set<string>(OVERRIDABLE_COLUMNS);

/** Marks a filing as simulated so clearing can strip exactly those. */
export const SIMULATED_COURT_SOURCE = "simulated_court_feed";

export type SimulationKind = "court_filing" | "roll_movement";

/** A parcel the client picked, with the few values the change needs. */
export interface SimulationTarget {
  propertyId: string;
  parcelIdentifier?: string | null;
  addressLine: string;
  ownerName?: string | null;
  assessedValue?: number | null;
  roofPermitCount?: number | null;
}

export interface SimulationChange {
  propertyId: string;
  addressLine: string;
  label: string;
  detail: string;
}

export interface SimulationResult {
  runId: string;
  kind: SimulationKind;
  changes: SimulationChange[];
}

const COURT_CASE_TYPES = [
  { type: "foreclosure", label: "foreclosure filing", amount: 148_500 },
  { type: "lien", label: "recorded lien", amount: 12_400 },
  { type: "code_enforcement", label: "code enforcement case", amount: 2_750 },
] as const;

/** A synthetic run id that can never be mistaken for a pipeline one. */
export function newSimulationRunId(): string {
  return `sim-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function applyCourtFilings(
  targets: readonly SimulationTarget[],
  runId: string,
): Promise<SimulationChange[]> {
  const store = crmStore();
  const changes: SimulationChange[] = [];
  const filedDate = nowIso().slice(0, 10);

  for (const [index, target] of targets.entries()) {
    const caseType = COURT_CASE_TYPES[index % COURT_CASE_TYPES.length];
    if (!caseType) continue;
    const caseNumber = `${filedDate.slice(0, 4)}-SIM-${target.propertyId.slice(-6)}-${index}`;

    const record: CourtRecordDoc = {
      caseNumber,
      caseType: caseType.type,
      filedDate,
      partyName: target.ownerName ?? null,
      amount: caseType.amount,
      status: "open",
      sourceSystem: SIMULATED_COURT_SOURCE,
      sourceUrl: null,
      // Stamped once, outside the mutation, so a re-run against a document
      // somebody else wrote first produces the identical record.
      fetchedAt: nowIso(),
    };

    // One court document per parcel, holding its filings. Appending rather than
    // replacing, so a simulation never erases a real filing that is already
    // recorded against the same parcel - and appending through `update` rather
    // than `get` then `put`, because a `put` built from a read taken a moment
    // earlier discards any filing another writer recorded in between. The
    // mutation derives everything from its argument and from `record`, so it is
    // safe for `update` to run it again on a write conflict.
    const written = await store.update<CourtDoc>("court", target.propertyId, (current) => {
      const records = current?.records ?? [];
      // Re-checked inside the mutation rather than trusted from a listing: the
      // same filing may have been recorded while this pass was running.
      if (records.some((existing) => existing.caseNumber === caseNumber)) return null;
      return {
        id: target.propertyId,
        propertyId: target.propertyId,
        parcelIdentifier: target.parcelIdentifier ?? current?.parcelIdentifier ?? null,
        records: [...records, record],
      };
    });
    if (!written) continue;

    changes.push({
      propertyId: target.propertyId,
      addressLine: target.addressLine,
      label: caseType.label,
      detail: `${caseType.label} ${caseNumber} recorded against ${target.ownerName ?? "the owner of record"}`,
    });
  }

  logEvent("simulate.court_filing", { runId, affected: changes.length });
  return changes;
}

async function applyRollMovements(
  targets: readonly SimulationTarget[],
  runId: string,
): Promise<SimulationChange[]> {
  const store = crmStore();
  const changes: SimulationChange[] = [];
  const thisYear = new Date().getFullYear();
  // Stamped once for the whole pass, so a mutation re-run after a write
  // conflict produces the identical document rather than a later timestamp.
  const at = nowIso();

  for (const [index, target] of targets.entries()) {
    const writes: {
      column: OverridableColumn;
      value: string | null;
      label: string;
      detail: string;
    }[] = [];

    switch (index % 3) {
      case 0: {
        // A reassessment. Upward, which is what actually happens in Duval.
        const base = target.assessedValue ?? 150_000;
        const next = Math.round(base * 1.14);
        writes.push({
          column: "assessed_value",
          value: String(next),
          label: "reassessed",
          detail: `assessed value moved from $${Math.round(base).toLocaleString("en-US")} to $${next.toLocaleString("en-US")}`,
        });
        break;
      }
      case 1: {
        // A roof permit pulled. This is the one that turns roof_age_basis from a
        // proxy into real evidence, which is a meaningful improvement rather
        // than a cosmetic change.
        writes.push({
          column: "roof_year_est",
          value: String(thisYear),
          label: "roof permit",
          detail: `a re-roof permit was pulled, so the roof year is now ${thisYear} on permit evidence rather than a year-built proxy`,
        });
        writes.push({ column: "roof_age_years", value: "0", label: "roof permit", detail: "" });
        writes.push({
          column: "roof_age_basis",
          value: "PERMIT",
          label: "roof permit",
          detail: "",
        });
        writes.push({
          column: "roof_permit_count",
          value: String((target.roofPermitCount ?? 0) + 1),
          label: "roof permit",
          detail: "",
        });
        break;
      }
      default: {
        // A transfer. Resets tenure, which is exactly what a long-hold search
        // cares about.
        writes.push({
          column: "owner_name",
          value: `${target.ownerName ?? "OWNER"} REVOCABLE TRUST`,
          label: "owner change",
          detail: "owner of record changed to a revocable trust",
        });
        writes.push({
          column: "last_sale_date",
          value: new Date().toISOString().slice(0, 10),
          label: "owner change",
          detail: "",
        });
        writes.push({
          column: "years_since_last_sale",
          value: "0",
          label: "owner change",
          detail: "",
        });
        break;
      }
    }

    // One simulated document per parcel, holding every column it overrides.
    const values: Record<string, string | null> = {};
    for (const write of writes) {
      if (!OVERRIDABLE.has(write.column)) continue;
      values[write.column] = write.value;
    }

    if (Object.keys(values).length) {
      const label = writes[0]?.label ?? null;
      // Merged through `update`. The document accumulates every column a
      // simulation overrides on this parcel, so reading it, merging, and
      // writing it back with `put` would drop an override written by a
      // simulation running at the same time. The mutation reads only its
      // argument, `values`, `label`, `runId` and `at`, so re-running it against
      // the winning document is safe.
      await store.update<SimulatedDoc>("simulated", target.propertyId, (current) => ({
        id: target.propertyId,
        propertyId: target.propertyId,
        runId,
        label,
        values: { ...(current?.values ?? {}), ...values },
        createdAt: current?.createdAt ?? at,
      }));
    }

    const headline = writes.find((write) => write.detail);
    changes.push({
      propertyId: target.propertyId,
      addressLine: target.addressLine,
      label: headline?.label ?? "changed",
      detail: headline?.detail ?? "material fields changed",
    });
  }

  logEvent("simulate.roll_movement", { runId, affected: changes.length });
  return changes;
}

export async function applySimulation(
  kind: SimulationKind,
  targets: readonly SimulationTarget[],
): Promise<SimulationResult> {
  const runId = newSimulationRunId();
  const changes =
    kind === "court_filing"
      ? await applyCourtFilings(targets, runId)
      : await applyRollMovements(targets, runId);
  return { runId, kind, changes };
}

/** Remove every simulated change and every simulated court filing. */
export async function clearSimulation(): Promise<{ changes: number; courtRecords: number }> {
  const store = crmStore();

  const simulated = await store.list<SimulatedDoc>("simulated");
  for (const doc of simulated) await store.remove("simulated", doc.id);

  // Court documents can hold real filings alongside simulated ones, so this
  // strips the simulated records rather than deleting the document.
  const court = await store.list<CourtDoc>("court");
  let removedRecords = 0;

  for (const doc of court) {
    if (!doc.records.some((record) => record.sourceSystem === SIMULATED_COURT_SOURCE)) continue;

    // Stripped through `update`, not `put`. The listing above can be a minute
    // old, and writing a filtered copy of it back would erase any real filing
    // recorded in between. The filter is re-applied inside the mutation, which
    // reads only its argument, so `update` can re-run it against whatever is
    // actually stored.
    const stripped = await store.update<CourtDoc>("court", doc.id, (current) => {
      if (!current) return null;
      const kept = current.records.filter(
        (record) => record.sourceSystem !== SIMULATED_COURT_SOURCE,
      );
      return kept.length === current.records.length ? null : { ...current, records: kept };
    });
    if (!stripped) continue;

    // Counted against this pass's own snapshot: a filing recorded after the
    // listing is still stripped, it is just not claimed in the total.
    removedRecords += Math.max(0, doc.records.length - stripped.records.length);
    if (!stripped.records.length) await store.remove("court", doc.id);
  }

  logEvent("simulate.cleared", { changes: simulated.length, courtRecords: removedRecords });
  return { changes: simulated.length, courtRecords: removedRecords };
}
