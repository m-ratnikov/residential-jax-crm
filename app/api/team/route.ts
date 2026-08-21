import { handleError, ok } from "@/lib/api";
import { listTeamMembers } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return ok({ members: await listTeamMembers() });
  } catch {
    // Team assignment is a CRM feature; an unreachable store answers with an
    // empty roster rather than breaking the page that asked.
    return ok({ members: [] });
  }
}
