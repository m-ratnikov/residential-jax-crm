/**
 * The CRM's view of one parcel.
 *
 * The parcel record itself comes from the browser, which reads it out of the
 * published parquet. What the server holds is what the CRM has added: court
 * filings recorded against it, and whether it is already being worked.
 */

import { desc, eq } from "drizzle-orm";

import { handleError, ok } from "@/lib/api";
import { tryDb } from "@/lib/crm/db";
import { courtRecords, opportunities } from "@/lib/crm/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const database = tryDb();

    if (!database) return ok({ opportunity: null, court: [] });

    try {
      const [opportunity] = await database
        .select()
        .from(opportunities)
        .where(eq(opportunities.propertyId, id))
        .limit(1);

      const court = await database
        .select()
        .from(courtRecords)
        .where(eq(courtRecords.propertyId, id))
        .orderBy(desc(courtRecords.filedDate));

      return ok({ opportunity: opportunity ?? null, court });
    } catch {
      // A configured but unmigrated store must not break the detail view.
      return ok({ opportunity: null, court: [] });
    }
  } catch (error: unknown) {
    return handleError("GET /api/property/[id]", error);
  }
}
