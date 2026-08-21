/**
 * Notes and tasks on an opportunity.
 *
 * One endpoint with a discriminated body rather than two nearly identical
 * routes, because they share the same authorisation, the same 404 and the same
 * shape of response.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { addNote, addTask, setTaskStatus } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    body: z.string().min(1).max(5000),
    authorId: z.string().uuid().nullish(),
  }),
  z.object({
    kind: z.literal("task"),
    title: z.string().min(1).max(300),
    assigneeId: z.string().uuid().nullish(),
    dueAt: z.string().datetime().nullish(),
  }),
  z.object({
    kind: z.literal("task_status"),
    taskId: z.string().uuid(),
    status: z.enum(["open", "done", "cancelled"]),
  }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const input = bodySchema.parse(await readJson(request));

    switch (input.kind) {
      case "note":
        return ok({ note: await addNote(id, input.body, input.authorId ?? null) }, { status: 201 });
      case "task":
        return ok(
          {
            task: await addTask({
              opportunityId: id,
              title: input.title,
              assigneeId: input.assigneeId ?? null,
              dueAt: input.dueAt ? new Date(input.dueAt) : null,
            }),
          },
          { status: 201 },
        );
      case "task_status":
        return ok({ task: await setTaskStatus(input.taskId, input.status) });
    }
  } catch (error: unknown) {
    return handleError("POST /api/opportunities/[id]/activity", error);
  }
}
