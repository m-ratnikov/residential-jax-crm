/**
 * Opportunities: the list, and turning a matched parcel into one.
 *
 * The POST takes a parcel id rather than a body full of property fields. The
 * parcel is re-read from the data source and re-scored against the criteria
 * that surfaced it, so what gets stored is what the pipeline actually says
 * right now rather than whatever the browser happened to be holding.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { criteriaSetSchema, EMPTY_CRITERIA } from "@/lib/criteria/types";
import { getPropertyDataSource } from "@/lib/data/source";
import { loadOverlay } from "@/lib/crm/overlay";
import { createOpportunity, getSavedSearch, listOpportunities } from "@/lib/crm/repo";
import { ACQUISITION_STAGES } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const createSchema = z.object({
  propertyId: z.string().min(1),
  savedSearchId: z.string().uuid().nullish(),
  alertId: z.string().uuid().nullish(),
  assigneeId: z.string().uuid().nullish(),
  actorId: z.string().uuid().nullish(),
  /** Ad hoc criteria, when the parcel came from an unsaved search. */
  criteria: criteriaSetSchema.optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const stages = url.searchParams
      .getAll("stage")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value): value is (typeof ACQUISITION_STAGES)[number] =>
        (ACQUISITION_STAGES as readonly string[]).includes(value),
      );

    const minScoreRaw = url.searchParams.get("minScore");
    const rows = await listOpportunities({
      stages: stages.length ? stages : undefined,
      assigneeId: url.searchParams.get("assigneeId") ?? undefined,
      savedSearchId: url.searchParams.get("savedSearchId") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      minScore: minScoreRaw ? Number(minScoreRaw) : undefined,
      limit: Number(url.searchParams.get("limit") ?? 500) || 500,
    });

    return ok({ opportunities: rows });
  } catch (error: unknown) {
    return handleError("GET /api/opportunities", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = createSchema.parse(await readJson(request));
    const { source } = getPropertyDataSource();
    const overlay = await loadOverlay();

    // Which criteria to score against: the saved search that surfaced it, the
    // ad hoc set the browser was using, or nothing at all.
    let criteria = input.criteria ?? EMPTY_CRITERIA;
    if (input.savedSearchId) {
      const search = await getSavedSearch(input.savedSearchId);
      if (search) {
        const parsed = criteriaSetSchema.safeParse(search.criteria);
        if (parsed.success) criteria = parsed.data;
      }
    }

    const result = await source.search({
      criteria,
      limit: 1,
      propertyIds: [input.propertyId],
      overlay: overlay.overlay,
    });

    // A parcel that no longer matches its criteria is still a legitimate thing
    // to track by hand, so fall back to reading it unscored rather than
    // refusing.
    let scored = result.rows[0];
    if (!scored) {
      const property = await source.getProperty(input.propertyId, overlay.overlay);
      if (!property) {
        return fail("not_found", `No parcel ${input.propertyId} in the loaded dataset.`, 404);
      }
      scored = {
        property,
        score: 0,
        components: [],
        rationale: "Added by hand; this parcel does not currently match a saved criteria set.",
        matchHash: "",
      };
    }

    const created = await createOpportunity({
      scored,
      savedSearchId: input.savedSearchId ?? null,
      alertId: input.alertId ?? null,
      assigneeId: input.assigneeId ?? null,
      actorId: input.actorId ?? null,
    });

    return ok(
      { opportunity: created.opportunity, created: created.created },
      { status: created.created ? 201 : 200 },
    );
  } catch (error: unknown) {
    return handleError("POST /api/opportunities", error);
  }
}
