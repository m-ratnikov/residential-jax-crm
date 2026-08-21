/**
 * The upstream pipeline's runs and this CRM's matcher passes, side by side.
 *
 * They are returned together because the question a reviewer actually asks is
 * not "when did the pipeline run" or "when did the matcher run" but "did the
 * matcher see the last pipeline run, and what did it do about it".
 *
 * The run history is a small JSON document fetched from the gateway, so this
 * route needs no query engine.
 */

import { desc } from "drizzle-orm";

import { handleError, ok } from "@/lib/api";
import { dataConfig } from "@/lib/data/config";
import { loadRunHistory, runDelta } from "@/lib/data/runs";
import { tryDb } from "@/lib/crm/db";
import { matcherRuns } from "@/lib/crm/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100);

    const runs = await loadRunHistory(dataConfig().runHistoryUrl, limit);

    const database = tryDb();
    let passes: unknown[] = [];
    if (database) {
      try {
        passes = await database
          .select()
          .from(matcherRuns)
          .orderBy(desc(matcherRuns.startedAt))
          .limit(limit);
      } catch {
        // Unmigrated store: the pipeline half of this page still renders.
      }
    }

    return ok({
      pipelineRuns: runs.map((run) => ({ ...run, delta: runDelta(run) })),
      matcherRuns: passes,
    });
  } catch (error: unknown) {
    return handleError("GET /api/runs", error);
  }
}
