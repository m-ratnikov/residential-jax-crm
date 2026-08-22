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
 * be checked without triggering work.
 */

import { z } from "zod";

import { fail, handleError, matcherTokenValid, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { generatedIdSchema, propertyIdSchema, runIdSchema } from "@/lib/crm/ids";
import { listMatcherRuns } from "@/lib/crm/repo";
import { evaluateAndAlert } from "@/lib/notify/evaluate";
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
        error: z.string().max(2000).optional(),
      }),
    )
    .max(100),
});

export async function GET(): Promise<Response> {
  try {
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
