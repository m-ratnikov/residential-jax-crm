/**
 * What the server knows about this deployment.
 *
 * Deliberately NOT the parcel dataset: the browser reads that itself, straight
 * from the gateway, and reports its own row count and column count once the
 * artifact is attached. Asking a server function to count 404,023 rows to
 * populate a badge would put a query engine on the critical path of every page
 * load for information the tab already has.
 *
 * What the server does know is whether a CRM store is attached, what the
 * overlay holds, and what the pipeline's published run history says.
 */

import { handleError, ok } from "@/lib/api";
import { dataConfig } from "@/lib/data/config";
import { loadRunHistory } from "@/lib/data/runs";
import { loadOverlay } from "@/lib/crm/overlay";
import { hasDatabase } from "@/lib/crm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const config = dataConfig();
    const [runs, overlay] = await Promise.all([
      loadRunHistory(config.runHistoryUrl, 1),
      loadOverlay(),
    ]);

    const latest = runs[0] ?? null;

    return ok({
      crmStore: {
        configured: hasDatabase(),
        provider: hasDatabase() ? "postgres" : null,
      },
      overlay: {
        courtDataAvailable: overlay.courtDataAvailable,
        courtProperties: overlay.courtPropertyCount,
        simulatedProperties: overlay.simulatedPropertyCount,
        simulatedRunIds: overlay.simulatedRunIds,
      },
      pipeline: latest
        ? {
            runId: latest.runId,
            status: latest.status,
            startedAt: latest.startedAt,
            finishedAt: latest.finishedAt,
            tracks: latest.tracks,
            limitations: latest.limitations,
          }
        : null,
      county: { name: config.countyName, state: config.stateCode },
    });
  } catch (error: unknown) {
    return handleError("GET /api/datasource", error);
  }
}
