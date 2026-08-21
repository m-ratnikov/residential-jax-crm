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

import { eq } from "drizzle-orm";

import { OVERRIDABLE_COLUMNS, type OverridableColumn } from "@/lib/data/overlay";
import { logEvent } from "@/lib/notify/log";
import { db } from "./db";
import { courtRecords, simulatedChanges } from "./schema";

const OVERRIDABLE = new Set<string>(OVERRIDABLE_COLUMNS);

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
  const database = db();
  const changes: SimulationChange[] = [];
  const filedDate = new Date();

  for (const [index, target] of targets.entries()) {
    const caseType = COURT_CASE_TYPES[index % COURT_CASE_TYPES.length];
    if (!caseType) continue;
    const caseNumber = `${filedDate.getFullYear()}-SIM-${target.propertyId.slice(-6)}-${index}`;

    await database
      .insert(courtRecords)
      .values({
        propertyId: target.propertyId,
        parcelIdentifier: target.parcelIdentifier ?? null,
        caseNumber,
        caseType: caseType.type,
        filedDate,
        partyName: target.ownerName ?? null,
        amount: caseType.amount,
        status: "open",
        sourceSystem: "simulated_court_feed",
        sourceUrl: null,
      })
      .onConflictDoNothing();

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
  const database = db();
  const changes: SimulationChange[] = [];
  const thisYear = new Date().getFullYear();

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

    for (const write of writes) {
      if (!OVERRIDABLE.has(write.column)) continue;
      await database
        .insert(simulatedChanges)
        .values({
          propertyId: target.propertyId,
          runId,
          column: write.column,
          value: write.value,
          label: write.label,
        })
        .onConflictDoUpdate({
          target: [simulatedChanges.propertyId, simulatedChanges.column],
          set: { value: write.value, runId, label: write.label },
        });
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
  const database = db();
  const removedChanges = await database
    .delete(simulatedChanges)
    .returning({ id: simulatedChanges.id });
  const removedCourt = await database
    .delete(courtRecords)
    .where(eq(courtRecords.sourceSystem, "simulated_court_feed"))
    .returning({ id: courtRecords.id });

  logEvent("simulate.cleared", {
    changes: removedChanges.length,
    courtRecords: removedCourt.length,
  });

  return { changes: removedChanges.length, courtRecords: removedCourt.length };
}
