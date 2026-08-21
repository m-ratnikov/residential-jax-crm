/**
 * One opportunity, with everything a reviewer needs on one screen: the stage
 * history, notes, tasks, the outreach thread and its simulated lifecycle, and
 * the owner record.
 *
 * The PATCH is the stage machine. A stage change always writes a stage event,
 * because reconstructing history from an updated_at column is not possible and
 * "stage history is recorded" is an acceptance criterion.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import {
  getOpportunity,
  listNotes,
  listOutreach,
  listStageEvents,
  listTasks,
  updateOpportunity,
} from "@/lib/crm/repo";
import { advanceOutreach } from "@/lib/notify/outreach";
import { ACQUISITION_STAGES } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  stage: z.enum(ACQUISITION_STAGES).optional(),
  assigneeId: z.string().uuid().nullish(),
  ownerInterest: z.string().max(2000).nullish(),
  askingPrice: z.number().min(0).nullish(),
  offerPrice: z.number().min(0).nullish(),
  nextStep: z.string().max(1000).nullish(),
  nextStepDueAt: z.string().datetime().nullish(),
  actorId: z.string().uuid().nullish(),
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

    const row = await getOpportunity(id);
    if (!row) return fail("not_found", "No such opportunity.", 404);

    const [stages, notes, tasks, outreach] = await Promise.all([
      listStageEvents(id),
      listNotes(id),
      listTasks(id),
      listOutreach(id),
    ]);

    return ok({ ...row, stageEvents: stages, notes, tasks, outreach });
  } catch (error: unknown) {
    return handleError("GET /api/opportunities/[id]", error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const patch = patchSchema.parse(await readJson(request));

    const updated = await updateOpportunity(id, {
      stage: patch.stage,
      assigneeId: patch.assigneeId === undefined ? undefined : (patch.assigneeId ?? null),
      ownerInterest: patch.ownerInterest === undefined ? undefined : (patch.ownerInterest ?? null),
      askingPrice: patch.askingPrice === undefined ? undefined : (patch.askingPrice ?? null),
      offerPrice: patch.offerPrice === undefined ? undefined : (patch.offerPrice ?? null),
      nextStep: patch.nextStep === undefined ? undefined : (patch.nextStep ?? null),
      nextStepDueAt:
        patch.nextStepDueAt === undefined
          ? undefined
          : patch.nextStepDueAt
            ? new Date(patch.nextStepDueAt)
            : null,
      actorId: patch.actorId ?? null,
      stageNote: patch.stageNote ?? null,
    });

    if (!updated) return fail("not_found", "No such opportunity.", 404);
    return ok({ opportunity: updated });
  } catch (error: unknown) {
    return handleError("PATCH /api/opportunities/[id]", error);
  }
}
