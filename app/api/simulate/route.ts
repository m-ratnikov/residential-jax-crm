/**
 * Simulate an incremental pipeline update.
 *
 * POST writes a real change to the data the matcher reads - a court filing, or
 * a movement on the roll - stamped with a synthetic `sim-` run id, then runs
 * the ordinary matcher pass against the affected saved search. The alert that
 * comes back was produced by the same diff a genuine county refresh would
 * produce; nothing about it is staged.
 *
 * DELETE removes every simulated row and restores the published values.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { getPropertyDataSource } from "@/lib/data/source";
import { clearSimulation, simulatePipelineUpdate } from "@/lib/crm/simulate";
import { getSavedSearch, listSimulatedChanges } from "@/lib/crm/repo";
import { runMatcher } from "@/lib/notify/matcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  savedSearchId: z.string().uuid().optional(),
  criteria: criteriaSetSchema.optional(),
  kind: z.enum(["court_filing", "roll_movement"]).default("court_filing"),
  count: z.number().int().min(1).max(25).default(3),
  /** Run the matcher immediately, so the alert lands while the user is looking. */
  runMatcher: z.boolean().default(true),
});

export async function GET(): Promise<Response> {
  try {
    return ok({ changes: await listSimulatedChanges() });
  } catch (error: unknown) {
    return handleError("GET /api/simulate", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = bodySchema.parse(await readJson(request));

    let criteria = input.criteria;
    if (input.savedSearchId) {
      const search = await getSavedSearch(input.savedSearchId);
      if (!search) return fail("not_found", "No such saved search.", 404);
      criteria = criteriaSetSchema.parse(search.criteria);
    }
    if (!criteria) {
      return fail(
        "invalid_request",
        "Name a saved search or supply a criteria set to aim the simulation at.",
        400,
      );
    }

    const { source } = getPropertyDataSource();
    const simulation = await simulatePipelineUpdate(source, {
      criteria,
      kind: input.kind,
      count: input.count,
    });

    const matcher = input.runMatcher
      ? await runMatcher(source, {
          trigger: "simulation",
          savedSearchIds: input.savedSearchId ? [input.savedSearchId] : undefined,
        })
      : null;

    return ok({ simulation, matcher }, { status: 201 });
  } catch (error: unknown) {
    return handleError("POST /api/simulate", error);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    return ok(await clearSimulation());
  } catch (error: unknown) {
    return handleError("DELETE /api/simulate", error);
  }
}
