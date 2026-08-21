/**
 * One opportunity, whole.
 *
 * Stage history, notes, tasks and the outreach thread are part of the same
 * document, so this is one read rather than five joins. The PATCH is the stage
 * machine: a stage change always appends a stage event, because reconstructing
 * history from an updatedAt field is not possible and "stage history is
 * recorded" is an acceptance criterion.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { getOpportunityView, updateOpportunity } from "@/lib/crm/repo";
import { advanceOutreach } from "@/lib/notify/outreach";
import { ACQUISITION_STAGES } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  stage: z.enum(ACQUISITION_STAGES).optional(),
  assigneeId: z.string().nullish(),
  ownerInterest: z.string().max(2000).nullish(),
  askingPrice: z.number().min(0).nullish(),
  offerPrice: z.number().min(0).nullish(),
  nextStep: z.string().max(1000).nullish(),
  nextStepDueAt: z.string().datetime().nullish(),
  actorId: z.string().nullish(),
  stageNote: z.string().max(1000).nullish(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;

    // Opening the record is a natural moment to apply any provider events that
    // have come due, so the thread is current without a background worker.
    await advanceOutreach().catch(() => undefined);

    const view = await getOpportunityView(id);
    if (!view) return fail("not_found", "No such opportunity.", 404);
    return ok(view);
  } catch (error: unknown) {
    return handleError("GET /api/opportunities/[id]", error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // A public runtime with no login: this bounds an anonymous write, it does
    // not authenticate one. lib/api-auth.ts says exactly where the line is.
    const denied = guardMutation(request);
    if (denied) return denied;

    const { id } = await context.params;
    const patch = patchSchema.parse(await readJson(request));

    const updated = await updateOpportunity(id, {
      stage: patch.stage,
      assigneeId: patch.assigneeId === undefined ? undefined : (patch.assigneeId ?? null),
      ownerInterest: patch.ownerInterest === undefined ? undefined : (patch.ownerInterest ?? null),
      askingPrice: patch.askingPrice === undefined ? undefined : (patch.askingPrice ?? null),
      offerPrice: patch.offerPrice === undefined ? undefined : (patch.offerPrice ?? null),
      nextStep: patch.nextStep === undefined ? undefined : (patch.nextStep ?? null),
      nextStepDueAt: patch.nextStepDueAt === undefined ? undefined : (patch.nextStepDueAt ?? null),
      actorId: patch.actorId ?? null,
      stageNote: patch.stageNote ?? null,
    });

    if (!updated) return fail("not_found", "No such opportunity.", 404);
    return ok({ opportunity: updated });
  } catch (error: unknown) {
    return handleError("PATCH /api/opportunities/[id]", error);
  }
}
