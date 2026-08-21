/**
 * What is answering, and how honest the app is being about it.
 *
 * The header reads this on every page. It is deliberately the first route: a
 * reviewer opening the deployed app should be able to see, without clicking
 * anything, which dataset is loaded, how many parcels are in it, whether it is
 * a sample, and which pipeline run produced it.
 */

import { handleError, ok } from "@/lib/api";
import { dataConfig } from "@/lib/data/config";
import { getPropertyDataSource } from "@/lib/data/source";
import { loadOverlay } from "@/lib/crm/overlay";
import { hasDatabase } from "@/lib/crm/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const { source } = getPropertyDataSource();
    const config = dataConfig();

    const [info, runs, overlay] = await Promise.all([
      source.info(),
      source.listRuns(1),
      loadOverlay(),
    ]);

    const latest = runs[0] ?? null;

    return ok({
      dataSource: info,
      crmStore: {
        configured: hasDatabase(),
        // Named rather than described so the UI can say what to do about it.
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
      map: config.center,
      county: { name: config.countyName, state: config.stateCode },
    });
  } catch (error: unknown) {
    return handleError("GET /api/datasource", error);
  }
}
