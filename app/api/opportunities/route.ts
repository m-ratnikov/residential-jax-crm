/**
 * Opportunities: the list, and turning a matched parcel into one.
 *
 * The POST takes the parcel as the client read it. That is not a shortcut: the
 * browser is where the query engine lives, so it holds the authoritative record
 * straight from the published artifact, along with the score and the rationale
 * the same criteria produced on screen. Re-reading it here would need a second
 * query engine on the server to arrive at the same answer.
 *
 * What is stored is a snapshot, not a cache to query against: every search
 * still hits the parquet. It is here so an opportunity created six months ago
 * still renders if the parcel later leaves the roll.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { createOpportunityFromSnapshot, listOpportunities } from "@/lib/crm/repo";
import { ACQUISITION_STAGES } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  propertyId: z.string().min(1),
  parcelIdentifier: z.string().nullish(),
  addressLine: z.string().min(1).max(400),
  addressCity: z.string().max(200).nullish(),
  addressZip: z.string().max(40).nullish(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  assessedValue: z.number().nullish(),
  ownerName: z.string().max(400).nullish(),
  ownerMailingAddress: z.string().max(400).nullish(),
  ownerMailingCity: z.string().max(200).nullish(),
  ownerMailingState: z.string().max(40).nullish(),
  ownerMailingZip: z.string().max(40).nullish(),
  sourceSystem: z.string().max(200).nullish(),
  sourceUrl: z.string().max(2000).nullish(),
  propertySnapshot: z.record(z.string(), z.unknown()).default({}),

  matchScore: z.number().nullish(),
  matchRationale: z.string().max(4000).nullish(),
  savedSearchId: z.string().uuid().nullish(),
  alertId: z.string().uuid().nullish(),
  assigneeId: z.string().uuid().nullish(),
  actorId: z.string().uuid().nullish(),
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
    const result = await createOpportunityFromSnapshot(input);
    return ok(
      { opportunity: result.opportunity, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error: unknown) {
    return handleError("POST /api/opportunities", error);
  }
}
