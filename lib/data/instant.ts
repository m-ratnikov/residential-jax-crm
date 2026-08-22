/**
 * Reading a published timestamp, on either side of the client boundary.
 *
 * This module exists because of a defect, and the defect is worth recording.
 * `toDate` lived in components/ui.tsx and `provenanceInstant` in
 * lib/data/export-csv.ts, both of which are `"use client"` - correctly, since
 * one is a component vocabulary and the other holds a DOM download helper. When
 * `fetched_at` was normalised to ISO across the surfaces that show provenance,
 * the opportunities export route imported `provenanceInstant` from the client
 * module. Next compiled that to a client reference stub, and
 * GET /api/export?kind=opportunities answered:
 *
 *   Attempted to call provenanceInstant() from the server but
 *   provenanceInstant is on the client.
 *
 * Nothing caught it. test/export.test.ts drives the real route handler, but
 * under Vitest `"use client"` is an inert string, so the suite was green on the
 * exact path that failed in production - and the export is a plain
 * `<a download>`, so a reviewer would have silently downloaded a JSON error.
 * Only a request against the built app finds this class of bug, which is what
 * test/client-boundary.test.ts now checks structurally instead.
 *
 * So: no directive here, no DOM, no React. Both sides import from this file.
 */

/**
 * A datetime the publisher wrote without a zone, read as UTC.
 *
 * The same instant reached two screens by two routes and rendered seven hours
 * apart. `fetched_at` is a parquet TIMESTAMP, so the browser gets it as epoch
 * milliseconds and lands on the right instant; the native driver hands the
 * server "2026-08-21 13:58:56.294", that string is what a stored
 * `propertySnapshot.provenance.fetchedAt` holds, and `new Date` parses a
 * space-separated datetime with the LEGACY rules, which read it as local. In a
 * UTC+7 tab the drawer said 08:58 PM and the deal page said 01:58 PM for one
 * collection time.
 *
 * The pipeline publishes UTC, so a datetime with no zone on it is UTC and is
 * given the "Z" it was written without. Anchored on a required time part: a
 * bare date is NOT touched here. `new Date("2026-08-21")` is already UTC by
 * spec, and the drawer's TIMESTAMP_COLUMNS note records why a bare date is
 * never turned into a local timestamp in the first place - doing so moves it a
 * day in every negative UTC offset.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function withZone(text: string): string {
  return NAIVE_DATETIME.test(text) ? `${text.replace(" ", "T")}Z` : text;
}

function finite(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A timestamp in any of the shapes the pipeline hands one over in: a Date, an
 * ISO string, or epoch milliseconds arriving as a number, a bigint or a numeric
 * string - which is what a parquet TIMESTAMP column becomes once it has crossed
 * Arrow into the browser. Returns null when the value is not a timestamp at
 * all, so a caller can show what it actually got rather than "Invalid Date".
 *
 * Epoch detection is deliberately narrow (11 to 14 digits, so 1973 to 2972). A
 * four digit year is never mistaken for an epoch, and neither is a parcel
 * number.
 */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "bigint") return finite(new Date(Number(value)));
  if (typeof value === "number") return Number.isFinite(value) ? finite(new Date(value)) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{11,14}$/.test(text)) return finite(new Date(Number(text)));
  return finite(new Date(withZone(text)));
}

/**
 * A provenance timestamp as ISO 8601 UTC, for a file a machine will read.
 *
 * The drawer renders a readable local string because a person reads it; an
 * export gets ISO because a dataframe reads it, and `1787320736294` in a column
 * headed `fetched_at` is not provenance a reviewer can check. A value that is
 * not a timestamp at all is passed through unchanged rather than dropped, so a
 * surprise in the artifact stays visible in the export.
 */
export function provenanceInstant(value: unknown): string | null {
  const at = toDate(value);
  return at ? at.toISOString() : (value ?? null) === null ? null : String(value);
}
