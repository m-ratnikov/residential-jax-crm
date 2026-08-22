/**
 * The CRM's view of one parcel.
 *
 * The parcel record itself comes from the browser, which reads it out of the
 * published parquet. What the server holds is what the CRM has added: court
 * filings recorded against it, and whether it is already being worked.
 */

import { fail, handleError, ok } from "@/lib/api";
import { parseDocumentKey } from "@/lib/crm/ids";
import { getOpportunity, getOwner, listCourtRecords } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const id = parseDocumentKey((await context.params).id);
    if (!id) {
      return fail(
        "invalid_request",
        "That is not a parcel id this application could have issued.",
        400,
      );
    }

    const [opportunity, court] = await Promise.all([
      getOpportunity(id).catch(() => null),
      listCourtRecords(id).catch(() => null),
    ]);

    // The owner of record travels with the opportunity, because the drawer's
    // question is "who owns this and how do I reach them". The mailing address
    // on that document is real and carries its provenance; the `skipTrace`
    // block on it is simulated and says so in every field. The drawer renders
    // the two apart for that reason.
    const owner = opportunity?.ownerId
      ? await getOwner(opportunity.ownerId).catch(() => null)
      : null;

    return ok({ opportunity, owner, court: court?.records ?? [] });
  } catch (error: unknown) {
    return handleError("GET /api/property/[id]", error);
  }
}
