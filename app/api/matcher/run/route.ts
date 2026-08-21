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
import { listMatcherRuns } from "@/lib/crm/repo";
import { evaluateAndAlert } from "@/lib/notify/evaluate";
import { advanceOutreach } from "@/lib/notify/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const matchSchema = z.object({
  propertyId: z.string().min(1),
  matchHash: z.string().min(1).max(128),
  snapshot: z.record(z.string(), z.unknown()),
  score: z.number(),
  rationale: z.string().max(4000),
  propertySnapshot: z.record(z.string(), z.unknown()),
});

const bodySchema = z.object({
  trigger: z.enum(["cron", "manual", "simulation", "browser"]).default("browser"),
  pipelineRunId: z.string().max(200).nullish(),
  pipelineRunStartedAt: z.string().nullish(),
  dataSource: z.object({
    kind: z.string().max(80),
    location: z.string().max(2000),
    rowCount: z.number().int().min(0),
    isSample: z.boolean(),
  }),
  evaluations: z
    .array(
      z.object({
        savedSearchId: z.string().min(1),
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

    const input = bodySchema.parse(await readJson(request));

    const result = await evaluateAndAlert({
      trigger: input.trigger,
      pipelineRunId: input.pipelineRunId ?? null,
      pipelineRunStartedAt: input.pipelineRunStartedAt ?? null,
      dataSource: input.dataSource,
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
