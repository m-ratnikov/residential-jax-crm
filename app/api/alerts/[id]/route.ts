import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { parseDocumentKey } from "@/lib/crm/ids";
import { dismissAlert, markAlertRead } from "@/lib/crm/repo";
import { guardMutation } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  read: z.boolean().optional(),
  dismissed: z.literal(true).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = guardMutation(request);
    if (denied) return denied;

    // `<pass>__<search>__<parcel>`, not a UUID. See lib/crm/ids.ts.
    const id = parseDocumentKey((await context.params).id);
    if (!id) {
      return fail(
        "invalid_request",
        "That is not an alert id this application could have issued.",
        400,
      );
    }

    const patch = patchSchema.parse(await readJson(request));

    const updated = patch.dismissed
      ? await dismissAlert(id)
      : patch.read !== undefined
        ? await markAlertRead(id, patch.read)
        : null;

    if (!updated) return fail("not_found", "No such alert, or nothing to change.", 404);
    return ok({ alert: updated });
  } catch (error: unknown) {
    return handleError("PATCH /api/alerts/[id]", error);
  }
}
