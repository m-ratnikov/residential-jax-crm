/**
 * The matcher endpoint: diff supplied matches, raise alerts, record the pass.
 *
 * It does not read parcel data. Whichever engine evaluated the criteria posts
 * what it found - the browser with DuckDB-WASM, or the scheduled runner in
 * GitHub Actions with native DuckDB - and this route applies the shared
 * decision logic in `evaluateAndAlert`. That is why an alert raised by the cron
 * and an alert raised by pressing a button are the same code path.
 *
 * Guarded by a shared secret rather than a session, because the scheduled
 * caller is not a browser. With MATCHER_TOKEN unset the endpoint is open, which
 * is the right default for a public demo and is stated in the README rather
 * than left as a surprise.
 *
 * GET reports the last few passes without running anything, so a scheduler can
 * be checked without triggering work, and with `?knownFor=` it reports the
 * parcel ids each named search is already known to match, so a caller about to
 * sweep can carry alert detail for the difference.
 */

import { z } from "zod";

import { fail, handleError, matcherTokenValid, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { generatedIdSchema, propertyIdSchema, runIdSchema } from "@/lib/crm/ids";
import { knownMatchIds, listMatcherRuns } from "@/lib/crm/repo";
import { evaluateAndAlert, MATCH_ID_CAP } from "@/lib/notify/evaluate";
import { advanceOutreach } from "@/lib/notify/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const matchSchema = z.object({
  // Reaches `alertId()` and becomes part of a document key.
  propertyId: propertyIdSchema,
  matchHash: z.string().min(1).max(128),
  snapshot: z.record(z.string(), z.unknown()),
  score: z.number(),
  rationale: z.string().max(4000),
  propertySnapshot: z.record(z.string(), z.unknown()),
});

/**
 * The whole match set as ids, grouped by id prefix.
 *
 * Bounded twice on purpose. `count` is what the caller claims, and the byte
 * budget below is what it actually sent: an id set is written straight onto a
 * saved search document, so an unbounded one is an unbounded document in a git
 * repository. Sixteen bytes an id is generous for an eleven character parcel id
 * and still refuses a body that is mostly padding.
 */
const MATCH_ID_BYTE_BUDGET = MATCH_ID_CAP * 16;

const matchIdSetSchema = z
  .object({
    count: z.number().int().min(0).max(MATCH_ID_CAP),
    truncated: z.boolean(),
    buckets: z.record(z.string().min(1).max(64), z.string().max(MATCH_ID_BYTE_BUDGET)),
  })
  .refine(
    (set) =>
      Object.entries(set.buckets).reduce(
        (bytes, [prefix, joined]) => bytes + prefix.length + joined.length,
        0,
      ) <= MATCH_ID_BYTE_BUDGET,
    { message: "the match id set is larger than one pass is allowed to store" },
  );

const bodySchema = z.object({
  trigger: z.enum(["cron", "manual", "simulation", "browser"]).default("browser"),
  pipelineRunId: runIdSchema.nullish(),
  pipelineRunStartedAt: z.string().nullish(),
  dataSource: z.object({
    kind: z.string().max(80),
    location: z.string().max(2000),
    rowCount: z.number().int().min(0),
    isSample: z.boolean(),
    /**
     * The generation of the data this pass read.
     *
     * `lib/notify/client-matcher.ts` has always posted this, and
     * `evaluateAndAlert` uses it for two things: keying the alert id on the
     * logical pass so a retry is a no-op, and suppressing a "changed" alert
     * when the fingerprint moved but the artifact did not. Zod strips unknown
     * keys, so leaving it out of this schema did not fail - it silently turned
     * both guarantees off on the browser path, which is the path a live demo
     * drives. The cron path calls `evaluateAndAlert` directly and never lost
     * it, so the two matchers disagreed and nothing said so.
     */
    artifactRunId: runIdSchema.nullish(),
  }),
  evaluations: z
    .array(
      z.object({
        savedSearchId: generatedIdSchema,
        matched: z.number().int().min(0),
        rows: z.array(matchSchema).max(5_000),
        truncated: z.boolean().default(false),
        /**
         * Optional so an older client, and every test that posts rows alone,
         * still validates. Absent means "membership is only what is in `rows`",
         * which the evaluator records as partial rather than treating as whole.
         */
        matchIds: matchIdSetSchema.nullish(),
        error: z.string().max(2000).optional(),
      }),
    )
    .max(100),
});

/** As many searches as one pass will evaluate, so the two bounds agree. */
const KNOWN_FOR_MAX = 100;

// Optional because the run-history answer needs nothing from the request, and
// callers that only want that - the scheduler health check, and the cache
// header suite - invoke the handler directly with no argument.
export async function GET(request?: Request): Promise<Response> {
  try {
    const knownFor = request
      ? new URL(request.url).searchParams.get("knownFor")?.trim()
      : undefined;

    // What the store already believes these searches match, ids only.
    //
    // The browser holds the query engine, so it discovers what matches now;
    // only the store knows what matched before. Handing over the previous id
    // set is what lets one sweep carry alert detail - address, owner, score,
    // rationale - for a parcel that newly matches at rank 5,000, instead of
    // detecting it and having nothing to say about it.
    //
    // A read, not a decision: `evaluateAndAlert` re-derives what is new from
    // the stored set when the pass is posted, so a stale or skipped answer here
    // changes what detail travels and never what is alerted on.
    if (knownFor !== undefined && knownFor !== "") {
      const ids = knownFor
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length > KNOWN_FOR_MAX) {
        return fail("bad_request", `At most ${KNOWN_FOR_MAX} saved searches at a time.`, 400);
      }
      const parsed = z.array(generatedIdSchema).safeParse(ids);
      if (!parsed.success) {
        return fail("bad_request", "One of the saved search ids is not a saved search id.", 400);
      }
      return ok({ known: await knownMatchIds(parsed.data) });
    }

    return ok({
      runs: await listMatcherRuns(10),
      tokenRequired: Boolean(process.env.MATCHER_TOKEN?.trim()),
    });
  } catch (error: unknown) {
    return handleError("GET /api/matcher/run", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!matcherTokenValid(request)) {
      return fail("unauthorised", "A valid matcher token is required.", 401);
    }

    // A caller holding the configured MATCHER_TOKEN is trusted and skips the
    // browser shaped checks; with no token configured this is an anonymous
    // public write like any other, so it is bounded like one.
    const denied = guardMutation(request, {
      cost: "heavy",
      secrets: [process.env.MATCHER_TOKEN],
    });
    if (denied) return denied;

    const input = bodySchema.parse(await readJson(request));

    const result = await evaluateAndAlert({
      trigger: input.trigger,
      pipelineRunId: input.pipelineRunId ?? null,
      pipelineRunStartedAt: input.pipelineRunStartedAt ?? null,
      dataSource: {
        kind: input.dataSource.kind,
        location: input.dataSource.location,
        rowCount: input.dataSource.rowCount,
        isSample: input.dataSource.isSample,
        artifactRunId: input.dataSource.artifactRunId ?? null,
      },
      evaluations: input.evaluations.map((evaluation) => ({
        savedSearchId: evaluation.savedSearchId,
        matched: evaluation.matched,
        truncated: evaluation.truncated,
        matchIds: evaluation.matchIds ?? null,
        error: evaluation.error,
        rows: evaluation.rows.map((row) => ({
          propertyId: row.propertyId,
          matchHash: row.matchHash,
          snapshot: row.snapshot,
          score: row.score,
          rationale: row.rationale,
          propertySnapshot: row.propertySnapshot,
        })),
      })),
    });

    // The same pass is a good moment to move any outreach whose simulated
    // provider events have come due.
    const advanced = await advanceOutreach().catch(() => ({
      messagesAdvanced: 0,
      eventsApplied: 0,
    }));

    return ok({ ...result, outreachAdvanced: advanced.messagesAdvanced });
  } catch (error: unknown) {
    return handleError("POST /api/matcher/run", error);
  }
}
