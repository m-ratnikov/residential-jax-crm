/**
 * The scheduled matcher endpoint.
 *
 * Called by GitHub Actions on a cron, and by the "run now" button. Guarded by a
 * shared secret rather than a session, because the caller is a scheduler. With
 * MATCHER_TOKEN unset the endpoint is open, which is the right default for a
 * public demo and is stated in the README rather than left as a surprise.
 *
 * GET reports the last few passes without running anything, so a scheduler can
 * be checked without triggering work.
 */

import { desc } from "drizzle-orm";

import { fail, handleError, matcherTokenValid, ok, readJson } from "@/lib/api";
import { getPropertyDataSource } from "@/lib/data/source";
import { runMatcher } from "@/lib/notify/matcher";
import { advanceOutreach } from "@/lib/notify/outreach";
import { db } from "@/lib/crm/db";
import { matcherRuns } from "@/lib/crm/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  try {
    const rows = await db()
      .select()
      .from(matcherRuns)
      .orderBy(desc(matcherRuns.startedAt))
      .limit(10);
    return ok({ runs: rows, tokenRequired: Boolean(process.env.MATCHER_TOKEN?.trim()) });
  } catch (error: unknown) {
    return handleError("GET /api/matcher/run", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!matcherTokenValid(request)) {
      return fail("unauthorised", "A valid matcher token is required.", 401);
    }

    const body = (await readJson(request)) as { savedSearchIds?: unknown };
    const savedSearchIds = Array.isArray(body.savedSearchIds)
      ? body.savedSearchIds.map((value) => String(value))
      : undefined;

    const { source } = getPropertyDataSource();
    const result = await runMatcher(source, { trigger: "cron", savedSearchIds });

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
