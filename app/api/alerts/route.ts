/**
 * The notification history.
 *
 * Every alert comes back with the saved search that raised it, the pipeline run
 * it was evaluated against, the fields that changed, the score rationale, and
 * the per-channel deliveries. That set is the acceptance criterion: "show
 * notification history and the specific pipeline run / record change that
 * triggered each alert".
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { listAlertNotifications, listAlerts, markAllAlertsRead } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rows = await listAlerts({
      savedSearchId: url.searchParams.get("savedSearchId") ?? undefined,
      unreadOnly: url.searchParams.get("unread") === "true",
      limit: Number(url.searchParams.get("limit") ?? 100) || 100,
    });

    const deliveries = await listAlertNotifications(rows.map((row) => row.alert.id));
    const byAlert = new Map<string, typeof deliveries>();
    for (const delivery of deliveries) {
      const list = byAlert.get(delivery.alertId) ?? [];
      list.push(delivery);
      byAlert.set(delivery.alertId, list);
    }

    return ok({
      alerts: rows.map((row) => ({
        ...row.alert,
        searchName: row.searchName,
        matcherTrigger: row.matcherTrigger,
        matcherStartedAt: row.matcherStartedAt,
        notifications: byAlert.get(row.alert.id) ?? [],
      })),
      unread: rows.filter((row) => row.alert.readAt === null).length,
    });
  } catch (error: unknown) {
    return handleError("GET /api/alerts", error);
  }
}

const patchSchema = z.object({ markAllRead: z.literal(true) });

export async function PATCH(request: Request): Promise<Response> {
  try {
    patchSchema.parse(await readJson(request));
    await markAllAlertsRead();
    return ok({ ok: true });
  } catch (error: unknown) {
    return handleError("PATCH /api/alerts", error);
  }
}
