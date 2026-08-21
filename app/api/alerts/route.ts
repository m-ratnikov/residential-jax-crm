/**
 * The notification history.
 *
 * Every alert carries the saved search that raised it, the pipeline run it was
 * evaluated against, the fields that changed, the score rationale, and its
 * per-channel deliveries. That set is the acceptance criterion: "show
 * notification history and the specific pipeline run / record change that
 * triggered each alert". They travel together because they are one document.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { guardMutation } from "@/lib/api-auth";
import { listAlerts, listSavedSearches, markAllAlertsRead } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const [alerts, searches] = await Promise.all([
      listAlerts({
        savedSearchId: url.searchParams.get("savedSearchId") ?? undefined,
        unreadOnly: url.searchParams.get("unread") === "true",
        limit: Number(url.searchParams.get("limit") ?? 100) || 100,
      }),
      listSavedSearches(),
    ]);

    const nameById = new Map(searches.map((search) => [search.id, search.name]));

    return ok({
      alerts: alerts.map((alert) => ({
        ...alert,
        searchName: nameById.get(alert.savedSearchId) ?? null,
      })),
      unread: alerts.filter((alert) => alert.readAt === null).length,
    });
  } catch (error: unknown) {
    return handleError("GET /api/alerts", error);
  }
}

const patchSchema = z.object({ markAllRead: z.literal(true) });

export async function PATCH(request: Request): Promise<Response> {
  try {
    // A public runtime with no login: this bounds an anonymous write, it does
    // not authenticate one. lib/api-auth.ts says exactly where the line is.
    const denied = guardMutation(request);
    if (denied) return denied;

    patchSchema.parse(await readJson(request));
    return ok({ ok: true, marked: await markAllAlertsRead() });
  } catch (error: unknown) {
    return handleError("PATCH /api/alerts", error);
  }
}
