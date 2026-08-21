/**
 * Evaluate one saved search now.
 *
 * The same matcher pass the scheduler runs, scoped to a single search. This is
 * what the "check for matches" button calls, and what the demo uses right after
 * simulating a pipeline update so the alert appears while the reviewer is still
 * looking at the page.
 */

import { handleError, ok } from "@/lib/api";
import { getPropertyDataSource } from "@/lib/data/source";
import { runMatcher } from "@/lib/notify/matcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const { source } = getPropertyDataSource();
    const result = await runMatcher(source, { trigger: "manual", savedSearchIds: [id] });
    return ok(result);
  } catch (error: unknown) {
    return handleError("POST /api/searches/[id]/run", error);
  }
}
