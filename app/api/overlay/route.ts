/**
 * Everything true about a parcel that is not in the published parquet.
 *
 * The browser reads the parcels itself, straight from the gateway, so the only
 * thing it needs from this server is the overlay: court filings, which arrive
 * continuously and live in Postgres, and any simulated pipeline update
 * currently applied. Both are small by construction.
 *
 * No query engine is involved, which is the point: this route is pure Postgres
 * and deploys as a few kilobytes.
 */

import { handleError, ok } from "@/lib/api";
import { loadOverlay } from "@/lib/crm/overlay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const summary = await loadOverlay();
    return ok({
      overlay: summary.overlay,
      courtDataAvailable: summary.courtDataAvailable,
      courtProperties: summary.courtPropertyCount,
      simulatedProperties: summary.simulatedPropertyCount,
      simulatedRunIds: summary.simulatedRunIds,
    });
  } catch (error: unknown) {
    return handleError("GET /api/overlay", error);
  }
}
