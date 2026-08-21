/**
 * The CRM's view of one parcel.
 *
 * The parcel record itself comes from the browser, which reads it out of the
 * published parquet. What the server holds is what the CRM has added: court
 * filings recorded against it, and whether it is already being worked.
 */

import { handleError, ok } from "@/lib/api";
import { getOpportunity, listCourtRecords } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const [opportunity, court] = await Promise.all([
      getOpportunity(id).catch(() => null),
      listCourtRecords(id).catch(() => null),
    ]);
    return ok({ opportunity, court: court?.records ?? [] });
  } catch (error: unknown) {
    return handleError("GET /api/property/[id]", error);
  }
}
