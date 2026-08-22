/**
 * Saved criteria sets.
 *
 * Saving a search is what turns a one-off query into something the scheduled
 * matcher watches, so this POST is the hinge between the search page and the
 * notification story.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { generatedIdSchema } from "@/lib/crm/ids";
import { createSavedSearch, listSavedSearchesForDisplay } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  criteria: criteriaSetSchema,
  // A team member id, minted by newId(). It asserted `uuid()`, which nothing in
  // this system produces, so any request that actually named an owner was
  // rejected; see lib/crm/ids.ts.
  ownerId: generatedIdSchema.nullish(),
  notifyInApp: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  alertLimitPerRun: z.number().int().min(1).max(500).optional(),
});

export async function GET(): Promise<Response> {
  try {
    return ok({ searches: await listSavedSearchesForDisplay() });
  } catch (error: unknown) {
    return handleError("GET /api/searches", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // A public runtime with no login: this bounds an anonymous write, it does
    // not authenticate one. lib/api-auth.ts says exactly where the line is.
    const denied = guardMutation(request);
    if (denied) return denied;

    const input = createSchema.parse(await readJson(request));
    const created = await createSavedSearch({
      ...input,
      description: input.description ?? null,
      ownerId: input.ownerId ?? null,
    });
    return ok({ search: created }, { status: 201 });
  } catch (error: unknown) {
    return handleError("POST /api/searches", error);
  }
}
