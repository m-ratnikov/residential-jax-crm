/**
 * Simulating an incremental pipeline update.
 *
 * The assignment asks to "simulate (or show a real) incremental pipeline update
 * that brings in a new or changed property matching the criteria". The honest
 * way to do that is to make a real change to the data the matcher reads, not to
 * inject a notification. So this writes rows the query overlay picks up, stamps
 * them with a synthetic run id, and then lets the ordinary matcher pass find
 * them by diffing - the same path a genuine county refresh takes.
 *
 * Two kinds of change are produced, because the two halves of the story need
 * different things:
 *
 * - A **court filing**: a foreclosure, lien or code enforcement case recorded
 *   against a parcel. This brings parcels INTO a distress-based saved search
 *   that did not match before, which is the "new match" case.
 * - A **roll movement**: a reassessment, a roof permit, an owner change. This
 *   moves a parcel that already matched, which is the "updated match" case.
 *
 * Everything written here is labelled and reversible: `sim-` run ids, a label
 * per row saying what it represents, and one call to clear it all out.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { OVERRIDABLE_COLUMNS, type OverridableColumn } from "@/lib/data/overlay";
import type { PropertyDataSource, ScoredProperty } from "@/lib/data/types";
import type { CriteriaSet } from "@/lib/criteria/types";
import { logEvent } from "@/lib/notify/log";
import { db } from "./db";
import { courtRecords, simulatedChanges } from "./schema";
import { loadOverlay } from "./overlay";

const OVERRIDABLE = new Set<string>(OVERRIDABLE_COLUMNS);

export type SimulationKind = "court_filing" | "roll_movement";

export interface SimulationInput {
  /** Which saved search's criteria to aim the simulation at. */
  criteria: CriteriaSet;
  kind: SimulationKind;
  /** How many parcels to affect. Kept small: this is a demonstration. */
  count?: number;
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
  return `sim-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function addressOf(scored: ScoredProperty): string {
  const property = scored.property;
  const parts = [property.addressStreet, property.addressCity].filter(Boolean);
  return parts.length ? parts.join(", ") : `Parcel ${property.propertyId}`;
}

/**
 * A court filing lands on parcels that do NOT currently match a distress
 * criteria set, so the next matcher pass sees them arrive. Aiming at parcels
 * that already match would produce no alert and a confusing demo.
 */
async function simulateCourtFiling(
  source: PropertyDataSource,
  criteria: CriteriaSet,
  count: number,
  runId: string,
): Promise<SimulationChange[]> {
  const database = db();

  // Drop the court predicates: the point is to find parcels that fit
  // everything else and then give them the distress signal they lack.
  const withoutCourt: CriteriaSet = {
    ...criteria,
    filters: {
      ...criteria.filters,
      distress: criteria.filters.distress
        ? {
            absenteeOwner: criteria.filters.distress.absenteeOwner,
            noHomestead: criteria.filters.distress.noHomestead,
          }
        : undefined,
    },
  };

  const overlay = await loadOverlay();
  const alreadyFlagged = new Set(overlay.overlay.court.map((entry) => entry.propertyId));

  const result = await source.search({
    criteria: withoutCourt,
    limit: Math.max(count * 20, 100),
    orderBy: "score",
    overlay: overlay.overlay,
  });

  const candidates = result.rows
    .filter((row) => !alreadyFlagged.has(row.property.propertyId))
    .slice(0, count);

  const changes: SimulationChange[] = [];
  const filedDate = new Date();

  for (const [index, scored] of candidates.entries()) {
    const caseType = COURT_CASE_TYPES[index % COURT_CASE_TYPES.length];
    if (!caseType) continue;
    const caseNumber = `${filedDate.getFullYear()}-SIM-${scored.property.propertyId.slice(-6)}-${index}`;

    await database
      .insert(courtRecords)
      .values({
        propertyId: scored.property.propertyId,
        parcelIdentifier: scored.property.parcelIdentifier,
        caseNumber,
        caseType: caseType.type,
        filedDate,
        partyName: scored.property.ownerName,
        amount: caseType.amount,
        status: "open",
        sourceSystem: "simulated_court_feed",
        sourceUrl: null,
      })
      .onConflictDoNothing();

    changes.push({
      propertyId: scored.property.propertyId,
      addressLine: addressOf(scored),
      label: caseType.label,
      detail: `${caseType.label} ${caseNumber} recorded against ${scored.property.ownerName ?? "the owner of record"}`,
    });
  }

  logEvent("simulate.court_filing", { runId, affected: changes.length });
  return changes;
}

/** A roll movement lands on parcels that already match, producing an update. */
async function simulateRollMovement(
  source: PropertyDataSource,
  criteria: CriteriaSet,
  count: number,
  runId: string,
): Promise<SimulationChange[]> {
  const database = db();
  const overlay = await loadOverlay();

  const result = await source.search({
    criteria,
    limit: Math.max(count * 5, 50),
    orderBy: "score",
    overlay: overlay.overlay,
  });

  const candidates = result.rows.slice(0, count);
  const changes: SimulationChange[] = [];
  const thisYear = new Date().getFullYear();

  for (const [index, scored] of candidates.entries()) {
    const property = scored.property;
    const writes: { column: OverridableColumn; value: string | null; label: string; detail: string }[] = [];

    switch (index % 3) {
      case 0: {
        // A reassessment. Up, which is what actually happens in Duval.
        const base = property.assessedValue ?? 150_000;
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
        // A roof permit pulled. This is the one that changes roof_age_basis
        // from a proxy to real evidence, which is a meaningful improvement.
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
          value: String((property.roofPermitCount ?? 0) + 1),
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
          value: `${property.ownerName ?? "OWNER"} REVOCABLE TRUST`,
          label: "owner change",
          detail: `owner of record changed to a revocable trust`,
        });
        writes.push({
          column: "last_sale_date",
          value: new Date().toISOString().slice(0, 10),
          label: "owner change",
          detail: "",
        });
        writes.push({ column: "years_since_last_sale", value: "0", label: "owner change", detail: "" });
        break;
      }
    }

    for (const write of writes) {
      if (!OVERRIDABLE.has(write.column)) continue;
      await database
        .insert(simulatedChanges)
        .values({
          propertyId: property.propertyId,
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
      propertyId: property.propertyId,
      addressLine: addressOf(scored),
      label: headline?.label ?? "changed",
      detail: headline?.detail ?? "material fields changed",
    });
  }

  logEvent("simulate.roll_movement", { runId, affected: changes.length });
  return changes;
}

export async function simulatePipelineUpdate(
  source: PropertyDataSource,
  input: SimulationInput,
): Promise<SimulationResult> {
  const runId = newSimulationRunId();
  const count = Math.min(Math.max(input.count ?? 3, 1), 25);

  const changes =
    input.kind === "court_filing"
      ? await simulateCourtFiling(source, input.criteria, count, runId)
      : await simulateRollMovement(source, input.criteria, count, runId);

  return { runId, kind: input.kind, changes };
}

/** Remove every simulated change and every simulated court filing. */
export async function clearSimulation(): Promise<{ changes: number; courtRecords: number }> {
  const database = db();
  const removedChanges = await database.delete(simulatedChanges).returning({ id: simulatedChanges.id });
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
