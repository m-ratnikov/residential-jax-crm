import { handleError, ok } from "@/lib/api";
import { listTeamMembers } from "@/lib/crm/repo";
import { tryDb } from "@/lib/crm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // Team assignment is a CRM feature; with no store the rest of the app still
    // works, so this answers with an empty roster rather than a 503.
    if (!tryDb()) return ok({ members: [] });
    return ok({ members: await listTeamMembers() });
  } catch (error: unknown) {
    return handleError("GET /api/team", error);
  }
}
