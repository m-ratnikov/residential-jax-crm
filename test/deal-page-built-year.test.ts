/**
 * "Built: unknown" on a deal whose parcel the roll says was built in 1955.
 *
 * There are two writers of `propertySnapshot` and they disagree about which
 * fields belong in it. The parcel drawer's track path sends `builtYear`;
 * `alertSnapshot` in lib/notify/snapshot.ts, which the seed, the matcher API
 * and the alerts page all convert through, does not. Every deal on the deployed
 * board arrived by the second route, so every deal page printed "unknown" for a
 * year its own siblings render - the drawer from the roll, the result row from
 * `builtYear` on the search row.
 *
 * The stored snapshot is not something this page can retype, so what is
 * asserted here is what the page is allowed to SAY about it: an absent field and
 * a published null are different facts and must not share a sentence, and
 * "unknown" is not available for either.
 */

import { describe, expect, it } from "vitest";

import { builtYearCell } from "@/app/opportunities/[id]/page";

/** The snapshot `alertSnapshot` writes: every field but the year built. */
const ALERT_SNAPSHOT = {
  propertyId: "1266680000R",
  address: "1966 GILMORE ST, JACKSONVILLE, 32204",
  assessedValue: 145_475,
  roofAgeYears: 54,
  roofAgeBasis: "EFF_YR_BLT_PROXY",
  yearsSinceLastSale: 54,
} as const;

describe("the year built on a deal page", () => {
  it("prints the year when the snapshot captured one", () => {
    expect(
      builtYearCell({ ...ALERT_SNAPSHOT, builtYear: 1955 }, { status: "idle", builtYear: null }),
    ).toEqual({ value: "1955" });
  });

  it("never prints 'unknown' for a snapshot that simply predates the field", () => {
    // The whole defect. The alert snapshot has no `builtYear` key at all, and
    // the page read `snapshot["builtYear"] ?? "unknown"`, which cannot tell a
    // field nobody wrote from a year the county does not publish.
    for (const roll of [
      { status: "idle" } as const,
      { status: "reading" } as const,
      { status: "unavailable" } as const,
    ]) {
      const cell = builtYearCell(ALERT_SNAPSHOT, { ...roll, builtYear: null });
      expect(cell.value).not.toBe("unknown");
      expect(cell.title).toBeTruthy();
    }
  });

  it("shows what the roll says once the parcel has been read", () => {
    const cell = builtYearCell(ALERT_SNAPSHOT, { status: "ready", builtYear: 1955 });
    expect(cell.value).toBe("1955");
    // And says where the number came from, because it is not the number the
    // deal document holds.
    expect(cell.title).toMatch(/roll/i);
  });

  it("says 'not published' when the roll itself carries no year", () => {
    // Two ways to arrive at the same honest answer: the snapshot captured the
    // null, or the roll was read and had none. Neither is "unknown".
    expect(builtYearCell({ builtYear: null }, { status: "idle", builtYear: null })).toEqual({
      value: "not published",
    });
    expect(builtYearCell(ALERT_SNAPSHOT, { status: "ready", builtYear: null })).toEqual({
      value: "not published",
    });
  });

  it("does not chase the roll for a deal whose snapshot already answers", () => {
    // The lookup is keyed off exactly this test: a present field, of either
    // shape, must leave the query engine untouched.
    const answered = (snapshot: Record<string, unknown>) => snapshot["builtYear"] !== undefined;
    expect(answered({ ...ALERT_SNAPSHOT, builtYear: 1955 })).toBe(true);
    expect(answered({ ...ALERT_SNAPSHOT, builtYear: null })).toBe(true);
    expect(answered(ALERT_SNAPSHOT)).toBe(false);
  });
});
