/**
 * Court distress must not read as broken on arrival.
 *
 * A fresh visitor pressing **Court distress** saw `0 matches`. The enrichment
 * works - filings arrive through `applySimulation("court_filing", ...)` - but a
 * seeded store had none, so an advertised acceptance criterion looked like dead
 * code to anyone who did not already know to go and simulate one first.
 *
 * Two things have to be true of the fix, and the second is the one that could
 * quietly go wrong: the filings have to exist, and they must not land on a
 * parcel that is on the board. The board is a nine-deal fixture whose scores and
 * snapshots were written before any filing existed; a filing against one of
 * those parcels would make a row say two different things about itself.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { memoryStore } from "@/lib/crm/store-memory";
import type { CourtDoc } from "@/lib/crm/documents";
import { applySimulation, SIMULATED_COURT_SOURCE } from "@/lib/crm/simulate";
import { MATERIAL_FIELDS } from "@/lib/criteria/score";
import type { ScoredProperty } from "@/lib/data/types";
import { chooseCourtTargets } from "@/scripts/seed";

const ROOT = resolve(__dirname, "..");

/** Only the fields the chooser reads; the rest of a scored row is irrelevant. */
const parcel = (propertyId: string): ScoredProperty =>
  ({ property: { propertyId } }) as unknown as ScoredProperty;

const pool = (...ids: string[]) => ({ rows: ids.map(parcel) });

const idsOf = (rows: readonly ScoredProperty[]) => rows.map((row) => row.property.propertyId);

afterEach(() => {
  setCrmStore(null);
});

describe("chooseCourtTargets", () => {
  it("never records a filing against a parcel that is on the board", () => {
    const pools = [pool("a", "b", "c"), pool("d", "e", "f")];
    const board = new Set(["a", "d", "e"]);

    const chosen = idsOf(chooseCourtTargets(pools, board, 3));

    expect(chosen).toHaveLength(3);
    for (const id of chosen) expect(board.has(id)).toBe(false);
  });

  it("spreads across the theses rather than draining one", () => {
    const pools = [pool("a1", "a2", "a3", "a4"), pool("b1", "b2", "b3", "b4")];

    expect(idsOf(chooseCourtTargets(pools, new Set(), 4))).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("takes each parcel once, even when two theses both rank it", () => {
    const pools = [pool("shared", "a2"), pool("shared", "b2")];

    const chosen = idsOf(chooseCourtTargets(pools, new Set(), 4));
    expect(new Set(chosen).size).toBe(chosen.length);
    expect(chosen).toContain("shared");
  });

  it("returns what it can rather than looping when the pools run dry", () => {
    expect(chooseCourtTargets([pool("a", "b")], new Set(["a"]), 6)).toHaveLength(1);
    expect(chooseCourtTargets([], new Set(), 6)).toEqual([]);
    expect(chooseCourtTargets([pool("a")], new Set(["a"]), 6)).toEqual([]);
  });
});

describe("the seeded filings themselves", () => {
  it("are written through the simulation path, labelled and reversible", async () => {
    setCrmStore(memoryStore());

    const applied = await applySimulation("court_filing", [
      { propertyId: "1234567890", addressLine: "1 EXAMPLE ST", ownerName: "SMITH JOHN" },
      { propertyId: "0987654321", addressLine: "2 EXAMPLE ST", ownerName: "DOE JANE" },
    ]);

    expect(applied.runId).toMatch(/^sim-/);
    expect(applied.changes).toHaveLength(2);

    const filings = await crmStore().list<CourtDoc>("court");
    expect(filings).toHaveLength(2);
    for (const document of filings) {
      for (const record of document.records) {
        // Provenance, exactly like the rest of the mocked data: a reader can see
        // at a glance that no real court feed is being claimed.
        expect(record.sourceSystem).toBe(SIMULATED_COURT_SOURCE);
        expect(record.caseNumber).toContain("-SIM-");
      }
    }
  });

  it("cannot turn into a tenth deal, because the matcher does not fingerprint distress", () => {
    // This is the structural reason the seeded filings are safe to add after the
    // board exists: change detection diffs MATERIAL_FIELDS, and court distress
    // is not one of them, so no filing raises an alert or moves a stored score.
    expect(MATERIAL_FIELDS).not.toContain("courtDistressScore");
    expect(MATERIAL_FIELDS.some((field) => /court|lien|foreclos/i.test(field))).toBe(false);
  });
});

describe("the seed wires it in", () => {
  const source = readFileSync(resolve(ROOT, "scripts/seed.ts"), "utf8");

  it("records court filings as part of an ordinary seed", () => {
    expect(source).toMatch(/applySimulation\(\s*"court_filing"/);
    expect(source).toMatch(/await seedCourtFilings\(/);
  });

  it("hands the chooser the parcels the board already took", () => {
    expect(source).toMatch(
      /new Set\(\s*deals\.map\(\(deal\) => deal\.scored\.property\.propertyId\)/,
    );
  });

  it("proves the preset is no longer empty rather than asserting it", () => {
    expect(source).toMatch(/CRITERIA_PRESETS\.find\([\s\S]{0,80}?"distressed-court"/);
    expect(source).toMatch(/now returns \$\{found\.total/);
  });
});
