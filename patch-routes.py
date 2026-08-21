"""Port the API routes and scripts from the relational repository to documents."""

import io
import os

def edit(path, *pairs, required=True):
    src = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in src:
            if required:
                raise SystemExit(f"pattern not found in {path}:\n{old[:120]}")
            continue
        src = src.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="\n").write(src)
    print("patched", path)


def write(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8", newline="\n").write(body)
    print("wrote", path)


# --- alerts ---------------------------------------------------------------
write(
    "app/api/alerts/route.ts",
    '''/**
 * The notification history.
 *
 * Every alert carries the saved search that raised it, the pipeline run it was
 * evaluated against, the fields that changed, the score rationale, and its
 * per-channel deliveries. That set is the acceptance criterion: "show
 * notification history and the specific pipeline run / record change that
 * triggered each alert". They travel together because they are one document.
 */

import { z } from "zod";

import { handleError, ok, readJson } from "@/lib/api";
import { listAlerts, listSavedSearches, markAllAlertsRead } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const [alerts, searches] = await Promise.all([
      listAlerts({
        savedSearchId: url.searchParams.get("savedSearchId") ?? undefined,
        unreadOnly: url.searchParams.get("unread") === "true",
        limit: Number(url.searchParams.get("limit") ?? 100) || 100,
      }),
      listSavedSearches(),
    ]);

    const nameById = new Map(searches.map((search) => [search.id, search.name]));

    return ok({
      alerts: alerts.map((alert) => ({
        ...alert,
        searchName: nameById.get(alert.savedSearchId) ?? null,
      })),
      unread: alerts.filter((alert) => alert.readAt === null).length,
    });
  } catch (error: unknown) {
    return handleError("GET /api/alerts", error);
  }
}

const patchSchema = z.object({ markAllRead: z.literal(true) });

export async function PATCH(request: Request): Promise<Response> {
  try {
    patchSchema.parse(await readJson(request));
    return ok({ ok: true, marked: await markAllAlertsRead() });
  } catch (error: unknown) {
    return handleError("PATCH /api/alerts", error);
  }
}
''',
)

# --- datasource -----------------------------------------------------------
edit(
    "app/api/datasource/route.ts",
    (
        'import { hasDatabase } from "@/lib/crm/db";',
        'import { storeStatus } from "@/lib/crm/db";',
    ),
    (
        """      crmStore: {
        configured: hasDatabase(),
        provider: hasDatabase() ? "postgres" : null,
      },""",
        "      crmStore: storeStatus(),",
    ),
)

# --- property -------------------------------------------------------------
write(
    "app/api/property/[id]/route.ts",
    '''/**
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
''',
)

# --- team -----------------------------------------------------------------
write(
    "app/api/team/route.ts",
    '''import { handleError, ok } from "@/lib/api";
import { listTeamMembers } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return ok({ members: await listTeamMembers() });
  } catch {
    // Team assignment is a CRM feature; an unreachable store answers with an
    // empty roster rather than breaking the page that asked.
    return ok({ members: [] });
  }
}
''',
)

# --- runs -----------------------------------------------------------------
edit(
    "app/api/runs/route.ts",
    (
        '''import { desc } from "drizzle-orm";

import { handleError, ok } from "@/lib/api";''',
        'import { handleError, ok } from "@/lib/api";',
    ),
    (
        '''import { tryDb } from "@/lib/crm/db";
import { matcherRuns } from "@/lib/crm/schema";''',
        'import { listMatcherRuns } from "@/lib/crm/repo";',
    ),
    (
        """    const database = tryDb();
    let passes: unknown[] = [];
    if (database) {
      try {
        passes = await database
          .select()
          .from(matcherRuns)
          .orderBy(desc(matcherRuns.startedAt))
          .limit(limit);
      } catch {
        // Unmigrated store: the pipeline half of this page still renders.
      }
    }""",
        """    // An unreadable store degrades this page to its pipeline half rather than
    // failing it.
    const passes = await listMatcherRuns(limit).catch(() => []);""",
    ),
)

# --- matcher run ----------------------------------------------------------
edit(
    "app/api/matcher/run/route.ts",
    (
        '''import { desc } from "drizzle-orm";
import { z } from "zod";''',
        'import { z } from "zod";',
    ),
    (
        '''import { db } from "@/lib/crm/db";
import { matcherRuns } from "@/lib/crm/schema";
import { evaluateAndAlert } from "@/lib/notify/evaluate";''',
        '''import { listMatcherRuns } from "@/lib/crm/repo";
import { evaluateAndAlert } from "@/lib/notify/evaluate";''',
    ),
    (
        """    const rows = await db().select().from(matcherRuns).orderBy(desc(matcherRuns.startedAt)).limit(10);
    return ok({ runs: rows, tokenRequired: Boolean(process.env.MATCHER_TOKEN?.trim()) });""",
        """    return ok({
      runs: await listMatcherRuns(10),
      tokenRequired: Boolean(process.env.MATCHER_TOKEN?.trim()),
    });""",
    ),
    (
        """    const result = await evaluateAndAlert(db(), {""",
        """    const result = await evaluateAndAlert({""",
    ),
)

# --- opportunity detail ---------------------------------------------------
write(
    "app/api/opportunities/[id]/route.ts",
    '''/**
 * One opportunity, whole.
 *
 * Stage history, notes, tasks and the outreach thread are part of the same
 * document, so this is one read rather than five joins. The PATCH is the stage
 * machine: a stage change always appends a stage event, because reconstructing
 * history from an updatedAt field is not possible and "stage history is
 * recorded" is an acceptance criterion.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { getOpportunityView, updateOpportunity } from "@/lib/crm/repo";
import { advanceOutreach } from "@/lib/notify/outreach";
import { ACQUISITION_STAGES } from "@/lib/notify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  stage: z.enum(ACQUISITION_STAGES).optional(),
  assigneeId: z.string().nullish(),
  ownerInterest: z.string().max(2000).nullish(),
  askingPrice: z.number().min(0).nullish(),
  offerPrice: z.number().min(0).nullish(),
  nextStep: z.string().max(1000).nullish(),
  nextStepDueAt: z.string().datetime().nullish(),
  actorId: z.string().nullish(),
  stageNote: z.string().max(1000).nullish(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;

    // Opening the record is a natural moment to apply any provider events that
    // have come due, so the thread is current without a background worker.
    await advanceOutreach().catch(() => undefined);

    const view = await getOpportunityView(id);
    if (!view) return fail("not_found", "No such opportunity.", 404);
    return ok(view);
  } catch (error: unknown) {
    return handleError("GET /api/opportunities/[id]", error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const patch = patchSchema.parse(await readJson(request));

    const updated = await updateOpportunity(id, {
      stage: patch.stage,
      assigneeId: patch.assigneeId === undefined ? undefined : (patch.assigneeId ?? null),
      ownerInterest: patch.ownerInterest === undefined ? undefined : (patch.ownerInterest ?? null),
      askingPrice: patch.askingPrice === undefined ? undefined : (patch.askingPrice ?? null),
      offerPrice: patch.offerPrice === undefined ? undefined : (patch.offerPrice ?? null),
      nextStep: patch.nextStep === undefined ? undefined : (patch.nextStep ?? null),
      nextStepDueAt: patch.nextStepDueAt === undefined ? undefined : (patch.nextStepDueAt ?? null),
      actorId: patch.actorId ?? null,
      stageNote: patch.stageNote ?? null,
    });

    if (!updated) return fail("not_found", "No such opportunity.", 404);
    return ok({ opportunity: updated });
  } catch (error: unknown) {
    return handleError("PATCH /api/opportunities/[id]", error);
  }
}
''',
)

# --- opportunity activity -------------------------------------------------
write(
    "app/api/opportunities/[id]/activity/route.ts",
    '''/**
 * Notes and tasks on an opportunity.
 *
 * One endpoint with a discriminated body rather than three nearly identical
 * routes, because they share the same 404 and the same response shape. Each
 * returns the whole opportunity, since they all mutate one document.
 */

import { z } from "zod";

import { fail, handleError, ok, readJson } from "@/lib/api";
import { addNote, addTask, setTaskStatus } from "@/lib/crm/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note"),
    body: z.string().min(1).max(5000),
    authorId: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("task"),
    title: z.string().min(1).max(300),
    assigneeId: z.string().nullish(),
    dueAt: z.string().datetime().nullish(),
  }),
  z.object({
    kind: z.literal("task_status"),
    taskId: z.string().min(1),
    status: z.enum(["open", "done", "cancelled"]),
  }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const input = bodySchema.parse(await readJson(request));

    const updated =
      input.kind === "note"
        ? await addNote(id, input.body, input.authorId ?? null)
        : input.kind === "task"
          ? await addTask({
              propertyId: id,
              title: input.title,
              assigneeId: input.assigneeId ?? null,
              dueAt: input.dueAt ?? null,
            })
          : await setTaskStatus(id, input.taskId, input.status);

    if (!updated) return fail("not_found", "No such opportunity.", 404);
    return ok({ opportunity: updated }, { status: input.kind === "task_status" ? 200 : 201 });
  } catch (error: unknown) {
    return handleError("POST /api/opportunities/[id]/activity", error);
  }
}
''',
)

# --- outreach -------------------------------------------------------------
edit(
    "app/api/outreach/route.ts",
    (
        'import { listCampaigns } from "@/lib/crm/repo";\n',
        "",
    ),
    (
        """import {
  advanceOutreach,
  fastForwardOutreach,
  OUTREACH_TEMPLATES,
  sendOutreach,
} from "@/lib/notify/outreach";""",
        """import {
  advanceOutreach,
  fastForwardOutreach,
  listAllOutreach,
  OUTREACH_TEMPLATES,
  sendOutreach,
} from "@/lib/notify/outreach";""",
    ),
    (
        "      campaigns: await listCampaigns(),",
        "      messages: await listAllOutreach(),",
    ),
    (
        """  opportunityIds: z.array(z.string().uuid()).min(1).max(500),""",
        """  opportunityIds: z.array(z.string().min(1)).min(1).max(500),""",
    ),
    (
        """  createdById: z.string().uuid().nullish(),""",
        """  createdById: z.string().nullish(),""",
    ),
)

# --- export ---------------------------------------------------------------
edit(
    "app/api/export/route.ts",
    (
        "            row.opportunity.createdAt?.toISOString?.() ?? row.opportunity.createdAt,",
        "            row.opportunity.createdAt,",
    ),
    required=False,
)

# --- scheduled matcher ----------------------------------------------------
edit(
    "scripts/run-matcher.ts",
    (
        'import { hasDatabase } from "@/lib/crm/db";',
        'import { storeStatus } from "@/lib/crm/db";',
    ),
    (
        """  if (!hasDatabase()) {
    console.error("DATABASE_URL is not set, so there are no saved searches to evaluate.");
    process.exit(2);
  }""",
        """  const store = storeStatus();
  console.log(`crm store: ${store.kind} (${store.location})`);

  if (!store.writable) {
    console.error("The CRM store is read only, so a pass could not record anything.");
    process.exit(2);
  }
  if (store.ephemeral) {
    // A scheduled pass against an in-process store would evaluate an empty set
    // and record a pass that proves nothing.
    console.error(
      "The CRM store is in-process only, so a scheduled pass has no saved searches to evaluate. Configure CRM_STORE_REPO or DATABASE_URL.",
    );
    process.exit(2);
  }""",
    ),
)

print("done")
