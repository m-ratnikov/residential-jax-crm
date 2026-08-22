/**
 * One collection time, two routes into the app, seven hours apart.
 *
 * `fetched_at` is a parquet TIMESTAMP published in UTC, and it reaches the two
 * surfaces that render it by different roads:
 *
 *   - the parcel drawer reads the column out of the row the tab queried, where
 *     Arrow has already turned it into epoch milliseconds, 1787320736294;
 *   - the deal page reads `propertySnapshot.provenance.fetchedAt`, written by
 *     the native driver as "2026-08-21 13:58:56.294" and stored in the
 *     opportunity document. That is what GET /api/opportunities on the deployed
 *     runtime actually returns.
 *
 * A space-separated datetime is not an ISO form, so `new Date` falls back to
 * the legacy rules and reads it as LOCAL. The drawer said 08:58 PM, the deal
 * page said 01:58 PM, and both were describing the same instant.
 *
 * The zone is pinned here rather than inherited from the runner, so the test
 * fails on a UTC CI box for the same reason it fails on a developer's laptop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provenanceInstant } from "@/lib/data/export-csv";
import { toDate, when } from "@/components/ui";
import { TIMESTAMP_COLUMNS, renderValue } from "@/components/PropertyDrawer";

/** The two shapes of the one instant, as the deployed runtime serves them. */
const EPOCH_FROM_ARROW = 1787320736294;
const NAIVE_FROM_THE_DRIVER = "2026-08-21 13:58:56.294";
const THE_INSTANT = "2026-08-21T13:58:56.294Z";

const originalTz = process.env.TZ;
beforeAll(() => {
  // Any zone that is not UTC would do. New York is four hours off in August,
  // which is enough for a wrong parse to be a different clock reading.
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("a datetime the publisher wrote without a zone", () => {
  it("is read as UTC, which is what the pipeline publishes", () => {
    expect(toDate(NAIVE_FROM_THE_DRIVER)?.toISOString()).toBe(THE_INSTANT);
  });

  it("lands on the same instant as the epoch the browser gets", () => {
    expect(toDate(NAIVE_FROM_THE_DRIVER)?.getTime()).toBe(toDate(EPOCH_FROM_ARROW)?.getTime());
    expect(toDate(String(EPOCH_FROM_ARROW))?.toISOString()).toBe(THE_INSTANT);
  });

  it("accepts the T separator and a seconds-only form as the same rule", () => {
    expect(toDate("2026-08-21T13:58:56")?.toISOString()).toBe("2026-08-21T13:58:56.000Z");
    expect(toDate("2026-08-21 13:58")?.toISOString()).toBe("2026-08-21T13:58:00.000Z");
  });

  it("leaves a value that already carries a zone exactly where it was", () => {
    expect(toDate("2026-08-21T13:58:56.294Z")?.toISOString()).toBe(THE_INSTANT);
    expect(toDate("2026-08-21T13:58:56.294+07:00")?.toISOString()).toBe("2026-08-21T06:58:56.294Z");
  });

  it("does not touch a bare date", () => {
    // The drawer's TIMESTAMP_COLUMNS note is the standing decision here:
    // features_as_of and source_fetched_at are date-only and are left as
    // published, because turning a bare date into a local timestamp moves it a
    // day in every negative UTC offset. This rule needs a time part to fire, so
    // a bare date keeps the UTC midnight the spec already gives it.
    expect(toDate("2026-08-21")?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
    expect(TIMESTAMP_COLUMNS.has("features_as_of")).toBe(false);
    expect(TIMESTAMP_COLUMNS.has("source_fetched_at")).toBe(false);
  });

  it("still shows an unparseable value rather than 'Invalid Date'", () => {
    expect(toDate("not published")).toBeNull();
    expect(when("not a date")).toBe("not a date");
  });
});

describe("the drawer and the deal page agree on the clock", () => {
  it("renders both shapes as the same reading", () => {
    const drawer = renderValue("fetched_at", EPOCH_FROM_ARROW);
    const dealPage = when(NAIVE_FROM_THE_DRIVER);
    expect(drawer).toBe(dealPage);
    // And not by both being wrong: 13:58 UTC is 09:58 in New York in August.
    expect(drawer).toContain("09:58 AM");
  });

  it("names the zone it is showing rather than leaving it to be inferred", () => {
    // The choice made explicit. Provenance is read as evidence, and a bare
    // "09:58 AM" is a number two readers in two places will disagree about.
    expect(when(EPOCH_FROM_ARROW)).toMatch(/\bEDT\b|GMT-4/);
  });
});

describe("the exported provenance column", () => {
  it("ships a timestamp, not the epoch integer", () => {
    // "1787320736294" in the provenance column of a file sold for downstream
    // analysis is the defect. ISO 8601 in UTC because a dataframe reads this
    // column, not a person.
    expect(provenanceInstant(EPOCH_FROM_ARROW)).toBe(THE_INSTANT);
    expect(provenanceInstant(String(EPOCH_FROM_ARROW))).toBe(THE_INSTANT);
  });

  it("normalises the naive form to the same instant", () => {
    expect(provenanceInstant(NAIVE_FROM_THE_DRIVER)).toBe(THE_INSTANT);
  });

  it("leaves an empty provenance cell empty rather than inventing one", () => {
    expect(provenanceInstant(null)).toBeNull();
    expect(provenanceInstant(undefined)).toBeNull();
  });

  it("passes through a value it cannot read, so nothing is silently dropped", () => {
    expect(provenanceInstant("not published")).toBe("not published");
  });
});
