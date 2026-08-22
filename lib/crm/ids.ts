/**
 * What an id in this system actually looks like.
 *
 * This file exists because a schema once asserted `z.string().uuid()` on four
 * id fields and nothing in this application has ever minted a UUID. The effect
 * was not a cosmetic 400: converting an alert into an opportunity - the first
 * step of the demo script - failed on every alert, so `alert_id` was null on
 * every opportunity and the export's lineage columns were permanently empty.
 * A validator that describes a format the system does not use is worse than no
 * validator, because it reads as deliberate.
 *
 * There are exactly two id shapes here, and both are derived from the code that
 * mints them rather than from a convention someone remembers:
 *
 * 1. **A generated id**, from `newId()` in documents.ts: a base-36 timestamp
 *    padded to nine characters, followed by up to eight base-36 random ones.
 *    That is `[0-9a-z]`, nine to seventeen characters. The range below is a
 *    little wider than seventeen so a longer random suffix or a clock past the
 *    year 5138 does not become an outage. Saved searches, team members, owners,
 *    matcher runs, notes, tasks, stage events, outreach messages and campaigns
 *    all carry one.
 *
 * 2. **A document key**, from `documentId()` in store.ts, which sanitises every
 *    part to `[A-Za-z0-9._-]` and joins them with `__`. An alert id is one of
 *    these - `<pass>__<search>__<parcel>`, for example
 *    `run-2026-08-19T04-00-00Z__0mt3kjly274lvwt7f__1654190105R` - and so is a
 *    parcel id, which arrives from the county roll and is used verbatim as an
 *    opportunity's document id.
 *
 * The second one is not decoration. The git backend writes a document to
 * `<root>/<collection>/<id>.json`, and `propertyId` reaches that path straight
 * off the request body, so a key containing `/` or `..` would write outside its
 * collection. Constraining the charset is what makes that structurally
 * impossible rather than merely unlikely.
 */

import { z } from "zod";

/** `newId()`: base-36 time prefix plus base-36 randomness. */
export const GENERATED_ID_PATTERN = /^[0-9a-z]{9,32}$/;

/**
 * `documentId()`'s output charset, and therefore every store key.
 *
 * The lookahead requires at least one character that is not a dot, which is
 * what rejects `.` and `..`. No separator is in the charset at all, so a key
 * cannot escape its collection whatever else it contains.
 */
export const DOCUMENT_KEY_PATTERN = /^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$/;

/**
 * Long enough for `<pass>__<search>__<parcel>` with room to spare, short enough
 * that a key cannot be used to post a megabyte into a file name.
 */
export const DOCUMENT_KEY_MAX_LENGTH = 300;

export function isGeneratedId(value: string): boolean {
  return GENERATED_ID_PATTERN.test(value);
}

export function isDocumentKey(value: string): boolean {
  return value.length <= DOCUMENT_KEY_MAX_LENGTH && DOCUMENT_KEY_PATTERN.test(value);
}

const GENERATED_MESSAGE =
  "not an id this application mints: expected the base-36 form newId() produces, for example 0mt3kjly274lvwt7f";

const DOCUMENT_KEY_MESSAGE =
  "not a document key this application mints: expected letters, digits, dot, underscore or hyphen only, for example 1654190105R or run-1__0mt3kjly274lvwt7f__1654190105R";

/** A saved search, team member, owner, matcher run, note, task or message id. */
export const generatedIdSchema = z.string().regex(GENERATED_ID_PATTERN, GENERATED_MESSAGE);

/** Any id used directly as a document key. */
export const documentKeySchema = z
  .string()
  .min(1)
  .max(DOCUMENT_KEY_MAX_LENGTH)
  .regex(DOCUMENT_KEY_PATTERN, DOCUMENT_KEY_MESSAGE);

/**
 * A parcel id from the county roll, e.g. `1654190105R`.
 *
 * The same shape as a document key because that is literally what it becomes:
 * `opportunities/<propertyId>`.
 */
export const propertyIdSchema = documentKeySchema;

/** `<pass>__<search>__<parcel>`, as built by `alertId()`. */
export const alertIdSchema = documentKeySchema;

/**
 * A run id published by the pipeline, or a `sim-` one this app mints.
 *
 * Not a document key on its own - it is sanitised by `documentId()` before it
 * becomes part of one - so this only bounds the length and refuses control
 * characters and newlines, which have no business in an identifier that ends up
 * in a commit message.
 */
export const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s\p{C}]+$/u, "a run id cannot contain whitespace or control characters");

/**
 * Read an id out of a route's dynamic segment.
 *
 * Next hands `[id]` over as an arbitrary string, so this is the one place a
 * path parameter is checked before it is used to address a document. Returns
 * null when the caller sent something that cannot be an id at all, which the
 * routes turn into a 400 rather than a confusing 404.
 */
export function parseDocumentKey(raw: string): string | null {
  const value = raw.trim();
  return isDocumentKey(value) ? value : null;
}
