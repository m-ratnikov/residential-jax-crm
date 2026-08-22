/**
 * Notes and tasks on an opportunity.
 *
 * One endpoint with a discriminated body rather than three nearly identical
 * routes, because they share the same 404 and the same response shape. Each
 * returns the whole opportunity, since all three mutate one document.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { generatedIdSchema, parseDocumentKey } from "@/lib/crm/ids";
import { addNote, addTask, setTaskStatus } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    body: z.string().min(1).max(5000),
    authorId: generatedIdSchema.nullish(),
  }),
  z.object({
    kind: z.literal("task"),
    title: z.string().min(1).max(300),
    assigneeId: generatedIdSchema.nullish(),
    dueAt: z.string().datetime().nullish(),
  }),
  z.object({
    kind: z.literal("task_status"),
    // Minted by newId() when the task was added, so it has the same shape as
    // every other generated id rather than being any non-empty string.
    taskId: generatedIdSchema,
    status: z.enum(["open", "done", "cancelled"]),
  }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // A public runtime with no login: this bounds an anonymous write, it does
    // not authenticate one. lib/api-auth.ts says exactly where the line is.
    const denied = guardMutation(request);
    if (denied) return denied;

    const id = parseDocumentKey((await context.params).id);
    if (!id) {
      return fail(
        "invalid_request",
        "That is not a parcel id this application could have issued.",
        400,
      );
    }

    const input = bodySchema.parse(await readJson(request));

    const updated =
      input.kind === "note"
        ? await addNote(id, input.body, input.authorId ?? null)
        : input.kind === "task"
          ? await addTask({
              propertyId: id,
              title: input.title,
              assigneeId: input.assigneeId ?? null,
              dueAt: input.dueAt ?? null,
            })
          : await setTaskStatus(id, input.taskId, input.status);

    if (!updated) return fail("not_found", "No such opportunity.", 404);
    return ok({ opportunity: updated }, { status: input.kind === "task_status" ? 200 : 201 });
  } catch (error: unknown) {
    return handleError("POST /api/opportunities/[id]/activity", error);
  }
}
