/**
 * Mocked owner outreach.
 *
 * POST launches a campaign across one or more opportunities. PATCH advances the
 * simulated lifecycle: normally that just applies whatever provider events have
 * come due, and `fastForward` pulls the whole timeline to now so a demo does not
 * have to wait days for a direct mail piece to be scanned.
 *
 * Nothing here sends a message to a property owner. The templates address a
 * reserved `.invalid` domain and a 555 number when an owner has no contact
 * detail on file, which is by design rather than an oversight.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import {
  advanceOutreach,
  fastForwardOutreach,
  listAllOutreach,
  OUTREACH_TEMPLATES,
  sendOutreach,
} from "@/lib/notify/outreach";
import { OUTREACH_CHANNELS } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const sendSchema = z.object({
  opportunityIds: z.array(z.string().min(1)).min(1).max(500),
  channel: z.enum(OUTREACH_CHANNELS),
  templateId: z.string().min(1),
  campaignName: z.string().max(200).optional(),
  createdById: z.string().nullish(),
});

const advanceSchema = z.object({ fastForward: z.boolean().default(false) });

export async function GET(): Promise<Response> {
  try {
    return ok({
      templates: OUTREACH_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        channels: template.channels,
        description: template.description,
      })),
      messages: await listAllOutreach(),
    });
  } catch (error: unknown) {
    return handleError("GET /api/outreach", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // A public runtime with no login: this bounds an anonymous write, it does
    // not authenticate one. lib/api-auth.ts says exactly where the line is.
    const denied = guardMutation(request, { cost: "heavy" });
    if (denied) return denied;

    const input = sendSchema.parse(await readJson(request));
    const result = await sendOutreach({
      opportunityIds: input.opportunityIds,
      channel: input.channel,
      templateId: input.templateId,
      campaignName: input.campaignName,
      createdById: input.createdById ?? null,
    });
    return ok(result, { status: 201 });
  } catch (error: unknown) {
    return handleError("POST /api/outreach", error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const denied = guardMutation(request, { cost: "heavy" });
    if (denied) return denied;

    const input = advanceSchema.parse(await readJson(request));
    const result = input.fastForward ? await fastForwardOutreach() : await advanceOutreach();
    return ok(result);
  } catch (error: unknown) {
    return handleError("PATCH /api/outreach", error);
  }
}
