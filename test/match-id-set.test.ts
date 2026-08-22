/**
 * The stored form of "which parcels does this saved search match".
 *
 * Two things have to hold, and neither is about correctness of the set:
 *
 * 1. It round trips. A membership test that loses a parcel turns into a false
 *    "now matches your saved search" on the next pass.
 * 2. It fits where it is kept. The set is a field on a JSON document committed
 *    to a git branch and rewritten whenever it changes, so the bytes and the
 *    diff both cost. The size claims in lib/notify/limits.ts are measured here,
 *    against the real parcel ids in the bundled sample, so they cannot quietly
 *    stop being true.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

import { DuckDbPropertyDataSource } from "@/lib/data/duckdb";
import { SAMPLE_QUERY_TABLE } from "@/lib/data/config";
import { DEFAULT_WEIGHTS } from "@/lib/criteria/types";
import { serialise } from "@/lib/crm/store";
import { collectMatches } from "@/lib/notify/collect";
import {
  decodeMatchIds,
  encodeMatchIds,
  goneFrom,
  hasMatchIdSet,
  newAgainst,
} from "@/lib/notify/match-ids";

describe("encoding a match id set", () => {
  it("round trips every id", () => {
    const ids = ["1089020000R", "1089030000R", "0007340010R", "9999999999R"];
    const decoded = decodeMatchIds(encodeMatchIds(ids));
    expect([...decoded].sort()).toEqual([...ids].sort());
  });

  it("round trips an id shorter than the grouping prefix", () => {
    // An empty group is one short id, not zero ids, and reading it as zero
    // would silently drop a parcel from the set.
    const decoded = decodeMatchIds(encodeMatchIds(["7R", "0007340010R"]));
    expect([...decoded].sort()).toEqual(["0007340010R", "7R"]);
  });

  it("serialises identically for the same set whatever order it arrives in", () => {
    // The store skips a write when the document is byte identical, and the
    // matcher runs every thirty minutes. An unstable ordering would commit an
    // unchanged set on every quiet pass.
    const forwards = encodeMatchIds(["1089030000R", "1089020000R", "0007340010R"]);
    const backwards = encodeMatchIds(["0007340010R", "1089020000R", "1089030000R"]);
    expect(serialise(forwards)).toBe(serialise(backwards));
  });

  it("carries its own count and truncation, so a reader of the JSON can see both", () => {
    const set = encodeMatchIds(["1089020000R", "1089030000R"], true);
    expect(set.count).toBe(2);
    expect(set.truncated).toBe(true);
  });

  it("tells an absent set apart from an empty one", () => {
    // The distinction is the migration: a search with no id set stored knows
    // nothing about membership, and a search with an empty one knows it matched
    // nothing. Reading the first as the second announces every parcel as new.
    expect(hasMatchIdSet(null)).toBe(false);
    expect(hasMatchIdSet(undefined)).toBe(false);
    expect(hasMatchIdSet(encodeMatchIds([]))).toBe(true);
    expect(decodeMatchIds(null).size).toBe(0);
  });
});

describe("set difference", () => {
  const previous = new Set(["a1", "a2", "a3"]);

  it("names what arrived, in the order given", () => {
    expect(newAgainst(previous, ["a2", "b9", "a1", "b1"])).toEqual(["b9", "b1"]);
  });

  it("names what left", () => {
    expect(goneFrom(previous, new Set(["a1", "a3"]))).toEqual(["a2"]);
  });
});

const samplePath = join(process.cwd(), SAMPLE_QUERY_TABLE);
const suite = existsSync(samplePath) ? describe : describe.skip;

suite("what it costs on real parcel ids", () => {
  let ids: string[] = [];

  beforeAll(async () => {
    const source = new DuckDbPropertyDataSource({
      source: samplePath,
      isSample: true,
      label: "test sample",
      countyName: "Duval",
      stateCode: "FL",
      runHistoryUrl: null,
    });
    // The whole sample, through the sweep the matchers use, so the numbers
    // below are measured on a real match set at a real size rather than on a
    // page of it.
    const swept = await collectMatches(source, {
      criteria: { name: "everything", filters: {}, weights: DEFAULT_WEIGHTS },
      snapshotLimit: 0,
    });
    ids = swept.ids;
    await source.close();
    expect(ids.length).toBeGreaterThan(50_000);
  });

  it("is far smaller than the same ids as an array", () => {
    // The claim in limits.ts is roughly 2.4x. Asserted loosely, because the
    // exact ratio depends on how prefix clustered the county's ids are; what
    // must not silently change is that grouping is a large win rather than a
    // rounding error.
    const grouped = serialise(encodeMatchIds(ids)).length;
    const listed = serialise({ ids: [...ids].sort() }).length;
    expect(grouped).toBeLessThan(listed / 2);
  });

  it("stays inside a megabyte per hundred thousand ids once compressed", () => {
    // The document travels over the GitHub contents API base64 encoded, and is
    // posted from the browser gzipped. Both budgets are set by this number.
    const bytes = gzipSync(serialise(encodeMatchIds(ids))).length;
    expect(bytes / ids.length).toBeLessThan(10);
  });

  it("rewrites a handful of lines when a handful of parcels move, not the file", () => {
    // This is the property a sorted array does not have: there, an id inserted
    // near the front shifts every element after it and the whole document is a
    // diff. Grouping by a function of the id alone keeps one parcel to one line.
    const before = serialise(encodeMatchIds(ids)).split("\n");
    const after = serialise(
      encodeMatchIds([
        ...ids.filter((_, index) => index % 5_000 !== 0),
        "9999999900R",
        "9999999901R",
        "9999999902R",
      ]),
    ).split("\n");

    const held = new Set(before);
    const changed = after.filter((line) => !held.has(line)).length;

    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(before.length / 10);
  });
});
