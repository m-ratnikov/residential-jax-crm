/**
 * Apply a simulated incremental pipeline update.
 *
 * The client picks the target parcels, because choosing them means querying the
 * published data and the query engine lives in the tab. This route writes the
 * change - a court filing, or a movement on the roll - stamped with a synthetic
 * `sim-` run id. The client then runs an ordinary matcher pass, and the alert
 * that comes back was produced by the same diff a genuine county refresh would
 * produce. Nothing about it is staged.
 *
 * DELETE removes every simulated row and restores the published values.
 */

import { z } from "zod";

import { handleError, ok } from "@/lib/api";
import { readJson } from "@/lib/api";
import { applySimulation, clearSimulation } from "@/lib/crm/simulate";
import { listSimulatedChanges } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["court_filing", "roll_movement"]).default("court_filing"),
  targets: z
    .array(
      z.object({
        propertyId: z.string().min(1),
        parcelIdentifier: z.string().nullish(),
        addressLine: z.string().min(1).max(400),
        ownerName: z.string().max(400).nullish(),
        assessedValue: z.number().nullish(),
        roofPermitCount: z.number().nullish(),
      }),
    )
    .min(1)
    .max(25),
});

export async function GET(): Promise<Response> {
  try {
    return ok({ changes: await listSimulatedChanges() });
  } catch (error: unknown) {
    return handleError("GET /api/simulate", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = bodySchema.parse(await readJson(request));
    const simulation = await applySimulation(
      input.kind,
      input.targets.map((target) => ({
        propertyId: target.propertyId,
        parcelIdentifier: target.parcelIdentifier ?? null,
        addressLine: target.addressLine,
        ownerName: target.ownerName ?? null,
        assessedValue: target.assessedValue ?? null,
        roofPermitCount: target.roofPermitCount ?? null,
      })),
    );
    return ok({ simulation }, { status: 201 });
  } catch (error: unknown) {
    return handleError("POST /api/simulate", error);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    return ok(await clearSimulation());
  } catch (error: unknown) {
    return handleError("DELETE /api/simulate", error);
  }
}
