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
import { addNote, addTask, setTaskStatus } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    body: z.string().min(1).max(5000),
    authorId: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("task"),
    title: z.string().min(1).max(300),
    assigneeId: z.string().nullish(),
    dueAt: z.string().datetime().nullish(),
  }),
  z.object({
    kind: z.literal("task_status"),
    taskId: z.string().min(1),
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

    const { id } = await context.params;
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
