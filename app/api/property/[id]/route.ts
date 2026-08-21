/**
 * One parcel, in full.
 *
 * Returns every published column rather than the subset the list needs, grouped
 * the way the pipeline's own column contract groups them, plus provenance and
 * whether the CRM is already working this parcel. Any column the pipeline adds
 * later appears under "other published columns" without a change here.
 */

import { desc, eq } from "drizzle-orm";

import { fail, handleError, ok } from "@/lib/api";
import { COLUMN_GROUPS, ungroupedColumns } from "@/lib/oracle/columns";
import { displayAddress } from "@/lib/data/map";
import { getPropertyDataSource } from "@/lib/data/source";
import { loadOverlay } from "@/lib/crm/overlay";
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
    const { source } = getPropertyDataSource();
    const overlay = await loadOverlay();

    const property = await source.getProperty(id, overlay.overlay);
    if (!property) return fail("not_found", `No parcel ${id} in the loaded dataset.`, 404);

    const database = tryDb();
    let opportunity: unknown = null;
    let court: unknown[] = [];

    if (database) {
      try {
        const [row] = await database
          .select()
          .from(opportunities)
          .where(eq(opportunities.propertyId, id))
          .limit(1);
        opportunity = row ?? null;

        court = await database
          .select()
          .from(courtRecords)
          .where(eq(courtRecords.propertyId, id))
          .orderBy(desc(courtRecords.filedDate));
      } catch {
        // A configured but unmigrated store must not break the detail view.
      }
    }

    const available = Object.keys(property.raw);

    return ok({
      property: { ...property, address: displayAddress(property) },
      groups: COLUMN_GROUPS.map((group) => ({
        title: group.title,
        description: group.description,
        columns: group.columns.filter((column) => available.includes(column)),
      })).filter((group) => group.columns.length),
      otherColumns: ungroupedColumns(available),
      court,
      opportunity,
      simulated: Boolean(property.raw["overlay_run_id"]),
    });
  } catch (error: unknown) {
    return handleError("GET /api/property/[id]", error);
  }
}
