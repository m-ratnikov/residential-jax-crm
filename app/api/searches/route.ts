/**
 * Saved criteria sets.
 *
 * Saving a search is what turns a one-off query into something the scheduled
 * matcher watches, so this POST is the hinge between the search page and the
 * notification story.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { criteriaSetSchema } from "@/lib/criteria/types";
import { createSavedSearch, listSavedSearches } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  criteria: criteriaSetSchema,
  ownerId: z.string().uuid().nullish(),
  notifyInApp: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  alertLimitPerRun: z.number().int().min(1).max(500).optional(),
});

export async function GET(): Promise<Response> {
  try {
    return ok({ searches: await listSavedSearches() });
  } catch (error: unknown) {
    return handleError("GET /api/searches", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
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
