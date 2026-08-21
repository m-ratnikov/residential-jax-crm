import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { deleteSavedSearch, getSavedSearch, updateSavedSearch } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullish(),
  criteria: criteriaSetSchema.optional(),
  notifyInApp: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  alertLimitPerRun: z.number().int().min(1).max(500).optional(),
  active: z.boolean().optional(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const search = await getSavedSearch(id);
    if (!search) return fail("not_found", "No such saved search.", 404);
    return ok({ search });
  } catch (error: unknown) {
    return handleError("GET /api/searches/[id]", error);
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
    const updated = await updateSavedSearch(id, {
      ...patch,
      description: patch.description === undefined ? undefined : (patch.description ?? null),
    });
    if (!updated) return fail("not_found", "No such saved search.", 404);
    return ok({ search: updated });
  } catch (error: unknown) {
    return handleError("PATCH /api/searches/[id]", error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = guardMutation(request);
    if (denied) return denied;

    const { id } = await context.params;
    await deleteSavedSearch(id);
    return ok({ deleted: true });
  } catch (error: unknown) {
    return handleError("DELETE /api/searches/[id]", error);
  }
}
