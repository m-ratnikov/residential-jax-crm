/**
 * The id contract, driven through the real route handlers.
 *
 * These exist because of a bug that every other kind of test missed. Four
 * fields on `POST /api/opportunities` asserted `z.string().uuid()`, and nothing
 * in this application has ever minted a UUID: saved searches are base-36
 * (`0mt3kjly274lvwt7f`) and alerts are composite (`<pass>__<search>__<parcel>`).
 * So converting an alert into an opportunity - the first step of the demo
 * script - answered 400 on every alert, `alert_id` was null on every
 * opportunity, and the export's lineage columns were permanently empty.
 *
 * It survived because `scripts/seed.ts` writes to the store directly and the
 * store has no opinion about ids, so the seeded database looked correct while
 * the HTTP surface refused everything. Every test here therefore imports the
 * route module and calls the exported handler with a `Request`. A test that
 * goes around the route proves nothing about the route.
 *
 * They are also the guard against the other half of the same mistake: a
 * validator loosened to `z.string()` to make the error go away. Each id shape
 * has a paired case showing junk is still refused - including junk with a path
 * separator in it, because `propertyId` becomes a file name in the git backend.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { POST as createOpportunity } from "@/app/api/opportunities/route";
import { PATCH as patchOpportunity } from "@/app/api/opportunities/[id]/route";
import { POST as postActivity } from "@/app/api/opportunities/[id]/activity/route";
import { PATCH as patchAlert } from "@/app/api/alerts/[id]/route";
import { POST as createSearch } from "@/app/api/searches/route";
import { POST as runMatcher } from "@/app/api/matcher/run/route";
import { POST as sendOutreachRoute } from "@/app/api/outreach/route";
import { POST as applySimulation } from "@/app/api/simulate/route";
import { GET as getProperty } from "@/app/api/property/[id]/route";

import { crmStore, setCrmStore } from "@/lib/crm/db";
import type { AlertDoc, OpportunityDoc, SavedSearchDoc } from "@/lib/crm/documents";
import { newId } from "@/lib/crm/documents";
import { isDocumentKey, isGeneratedId } from "@/lib/crm/ids";
import { alertId, createSavedSearch, createTeamMember, getOpportunity } from "@/lib/crm/repo";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";

const HOST = "jax-crm.example.com";
const PARCEL = "1654190105R";

const criteria: CriteriaSet = {
  name: "Tired landlord",
  filters: { residentialOnly: true, minRoofAge: 15 },
  weights: DEFAULT_WEIGHTS,
};

/**
 * What the browser actually sends when a page on this deployment posts to its
 * own API. Without the Origin the same-origin gate answers 403 and every case
 * below would pass for the wrong reason.
 */
function request(path: string, body?: unknown, method = "POST"): Request {
  return new Request(`https://${HOST}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: `https://${HOST}`,
      host: HOST,
      "sec-fetch-site": "same-origin",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const parcelBody = (overrides: Record<string, unknown> = {}) => ({
  propertyId: PARCEL,
  addressLine: "1 SOMEWHERE ST, JACKSONVILLE",
  addressCity: "JACKSONVILLE",
  ownerName: "SMITH JOHN",
  ownerMailingAddress: "PO BOX 1",
  propertySnapshot: {},
  matchScore: 88,
  matchRationale: "held 26 years; roof about 52 years old",
  ...overrides,
});

beforeEach(() => {
  setCrmStore(new MemoryCrmStore());
});

describe("the ids this system actually mints", () => {
  it("mints saved search ids that are base-36, not UUIDs", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });

    expect(search.id).toMatch(/^[0-9a-z]{9,32}$/);
    expect(isGeneratedId(search.id)).toBe(true);
    // The shape the old schema demanded, for the record.
    expect(search.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("mints alert ids that are composite document keys, not UUIDs", () => {
    const id = alertId("run-2026-08-19T04-00-00Z", newId(), PARCEL);

    expect(id).toContain("__");
    expect(isDocumentKey(id)).toBe(true);
    expect(isGeneratedId(id)).toBe(false);
  });
});

describe("POST /api/opportunities", () => {
  /** A saved search and an alert with the ids the system really produces. */
  async function seedAlert(): Promise<{ search: SavedSearchDoc; alert: AlertDoc }> {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });
    const alert: AlertDoc = {
      id: alertId("run-2026-08-19T04-00-00Z", search.id, PARCEL),
      savedSearchId: search.id,
      matcherRunId: newId(),
      kind: "new_match",
      propertyId: PARCEL,
      propertySnapshot: {},
      score: 88,
      rationale: "held 26 years; roof about 52 years old",
      changedFields: [],
      pipelineRunId: "run-2026-08-19T04-00-00Z",
      readAt: null,
      dismissedAt: null,
      opportunityId: null,
      createdAt: "2026-08-19T05:00:00.000Z",
      notifications: [],
    };
    await crmStore().put("alerts", alert);
    return { search, alert };
  }

  it("converts an alert into an opportunity and keeps the lineage", async () => {
    const { search, alert } = await seedAlert();

    const response = await createOpportunity(
      request(
        "/api/opportunities",
        parcelBody({ savedSearchId: search.id, alertId: alert.id, actorId: null }),
      ),
    );

    // This was a 400 with {"savedSearchId":"Invalid UUID","alertId":"Invalid UUID"}.
    expect(response.status).toBe(201);

    const stored = await getOpportunity(PARCEL);
    expect(stored?.alertId).toBe(alert.id);
    expect(stored?.savedSearchId).toBe(search.id);

    // And the other half of the lineage: the alert now points back, which is
    // what the export reads to fill matcher_run_id.
    const linked = await crmStore().get<AlertDoc>("alerts", alert.id);
    expect(linked?.opportunityId).toBe(PARCEL);
  });

  it("accepts an assignee and an actor minted by newId()", async () => {
    const member = await createTeamMember({
      name: "Dana Whitfield",
      email: "dana@example.invalid",
    });

    const response = await createOpportunity(
      request("/api/opportunities", parcelBody({ assigneeId: member.id, actorId: member.id })),
    );

    expect(response.status).toBe(201);
    const stored = await getOpportunity(PARCEL);
    expect(stored?.assigneeId).toBe(member.id);
    expect(stored?.stageEvents[0]?.actorId).toBe(member.id);
  });

  it("still refuses an id that nothing could have minted", async () => {
    const response = await createOpportunity(
      request("/api/opportunities", parcelBody({ savedSearchId: "not an id at all" })),
    );

    expect(response.status).toBe(400);
    expect((await bodyOf(response)).code).toBe("invalid_request");
    expect(await getOpportunity(PARCEL)).toBeNull();
  });

  it("refuses a parcel id that would escape its collection", async () => {
    // Not theoretical: the git backend writes this to
    // `<root>/opportunities/<propertyId>.json`.
    for (const propertyId of ["../../secrets", "a/b", "..", "with space"]) {
      const response = await createOpportunity(
        request("/api/opportunities", parcelBody({ propertyId })),
      );
      expect(response.status).toBe(400);
    }
    expect(await crmStore().list<OpportunityDoc>("opportunities")).toHaveLength(0);
  });
});

describe("the other id-carrying routes", () => {
  async function track(): Promise<void> {
    const response = await createOpportunity(request("/api/opportunities", parcelBody()));
    expect(response.status).toBe(201);
  }

  it("PATCH /api/opportunities/[id] takes a real team member id", async () => {
    await track();
    const member = await createTeamMember({ name: "Dana", email: "dana@example.invalid" });

    const ok = await patchOpportunity(
      request(
        `/api/opportunities/${PARCEL}`,
        { stage: "contacted", assigneeId: member.id, actorId: member.id },
        "PATCH",
      ),
      params(PARCEL),
    );
    expect(ok.status).toBe(200);

    const junk = await patchOpportunity(
      request(`/api/opportunities/${PARCEL}`, { assigneeId: "SOME-UUID-SHAPED-THING" }, "PATCH"),
      params(PARCEL),
    );
    expect(junk.status).toBe(400);

    const escaped = await patchOpportunity(
      request("/api/opportunities/x", { stage: "contacted" }, "PATCH"),
      params("../../etc/passwd"),
    );
    expect(escaped.status).toBe(400);
  });

  it("POST /api/opportunities/[id]/activity takes a note author and a task id", async () => {
    await track();
    const member = await createTeamMember({ name: "Dana", email: "dana@example.invalid" });

    const note = await postActivity(
      request(`/api/opportunities/${PARCEL}/activity`, {
        kind: "note",
        body: "Owner called back.",
        authorId: member.id,
      }),
      params(PARCEL),
    );
    expect(note.status).toBe(201);

    const task = await postActivity(
      request(`/api/opportunities/${PARCEL}/activity`, {
        kind: "task",
        title: "Post the offer letter",
        assigneeId: member.id,
      }),
      params(PARCEL),
    );
    expect(task.status).toBe(201);

    const stored = await getOpportunity(PARCEL);
    const taskId = stored?.tasks[0]?.id ?? "";
    expect(isGeneratedId(taskId)).toBe(true);

    const done = await postActivity(
      request(`/api/opportunities/${PARCEL}/activity`, {
        kind: "task_status",
        taskId,
        status: "done",
      }),
      params(PARCEL),
    );
    expect(done.status).toBe(200);

    const junk = await postActivity(
      request(`/api/opportunities/${PARCEL}/activity`, {
        kind: "note",
        body: "x",
        authorId: "6f1c9f0e-0000-4000-8000-000000000000",
      }),
      params(PARCEL),
    );
    expect(junk.status).toBe(400);
  });

  it("POST /api/searches takes an owner id minted by newId()", async () => {
    const member = await createTeamMember({ name: "Dana", email: "dana@example.invalid" });

    const ok = await createSearch(
      request("/api/searches", { name: "Tired landlord", criteria, ownerId: member.id }),
    );
    expect(ok.status).toBe(201);

    // The exact value the old schema wanted, which no team member ever has.
    const junk = await createSearch(
      request("/api/searches", {
        name: "Tired landlord",
        criteria,
        ownerId: "6f1c9f0e-0000-4000-8000-000000000000",
      }),
    );
    expect(junk.status).toBe(400);
  });

  it("PATCH /api/alerts/[id] takes a composite alert id", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });
    const id = alertId("run-1", search.id, PARCEL);
    await crmStore().put<AlertDoc>("alerts", {
      id,
      savedSearchId: search.id,
      matcherRunId: newId(),
      kind: "new_match",
      propertyId: PARCEL,
      propertySnapshot: {},
      score: 88,
      rationale: "",
      changedFields: [],
      pipelineRunId: null,
      readAt: null,
      dismissedAt: null,
      opportunityId: null,
      createdAt: "2026-08-19T05:00:00.000Z",
      notifications: [],
    });

    const ok = await patchAlert(request(`/api/alerts/${id}`, { read: true }, "PATCH"), params(id));
    expect(ok.status).toBe(200);

    const escaped = await patchAlert(
      request("/api/alerts/x", { read: true }, "PATCH"),
      params("../../opportunities/1654190105R"),
    );
    expect(escaped.status).toBe(400);
  });

  it("POST /api/outreach takes opportunity ids, which are parcel ids", async () => {
    await track();

    const ok = await sendOutreachRoute(
      request("/api/outreach", {
        opportunityIds: [PARCEL],
        channel: "email",
        templateId: "cash-offer-intro",
      }),
    );
    expect(ok.status).toBe(201);
    expect((await bodyOf(ok)).sent).toBe(1);

    const escaped = await sendOutreachRoute(
      request("/api/outreach", {
        opportunityIds: ["../../owners/x"],
        channel: "email",
        templateId: "cash-offer-intro",
      }),
    );
    expect(escaped.status).toBe(400);
  });

  it("POST /api/simulate takes parcel ids that become document keys", async () => {
    const ok = await applySimulation(
      request("/api/simulate", {
        kind: "court_filing",
        targets: [{ propertyId: PARCEL, addressLine: "1 SOMEWHERE ST", ownerName: "SMITH JOHN" }],
      }),
    );
    expect(ok.status).toBe(201);

    const escaped = await applySimulation(
      request("/api/simulate", {
        kind: "court_filing",
        targets: [{ propertyId: "../court/x", addressLine: "1 SOMEWHERE ST" }],
      }),
    );
    expect(escaped.status).toBe(400);
  });

  it("GET /api/property/[id] refuses a path-shaped parcel id", async () => {
    const ok = await getProperty(
      request(`/api/property/${PARCEL}`, undefined, "GET"),
      params(PARCEL),
    );
    expect(ok.status).toBe(200);

    const escaped = await getProperty(
      request("/api/property/x", undefined, "GET"),
      params("../../opportunities/1654190105R"),
    );
    expect(escaped.status).toBe(400);
  });
});

/**
 * The field the schema silently dropped.
 *
 * `lib/notify/client-matcher.ts` has always posted `dataSource.artifactRunId`,
 * and `evaluateAndAlert` uses it to suppress an alert whose fingerprint moved
 * while the underlying artifact did not - the unstable-read case that once had
 * four consecutive cron passes alerting on the same 23 parcels. Zod strips
 * unknown keys, so omitting it from the schema did not fail: it turned the
 * suppression off on the browser path only, which is the path a live demo
 * drives, while the cron path kept it. Two matchers, silently disagreeing.
 */
describe("POST /api/matcher/run", () => {
  const dataSource = (artifactRunId: string | null) => ({
    kind: "parquet",
    location: "https://gateway.example.invalid/duval.parquet",
    rowCount: 404_023,
    isSample: false,
    artifactRunId,
  });

  const evaluation = (savedSearchId: string, matchHash: string) => ({
    savedSearchId,
    matched: 1,
    truncated: false,
    rows: [
      {
        propertyId: PARCEL,
        matchHash,
        snapshot: { roofAgeYears: 22, lastSaleDate: matchHash === "h1" ? "2001-04-02" : null },
        score: 88,
        rationale: "held 26 years",
        propertySnapshot: { address: "1 SOMEWHERE ST" },
      },
    ],
  });

  it("carries artifactRunId through to the stored match snapshot", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });

    const response = await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: "run-2026-08-19T04-00-00Z",
        dataSource: dataSource("artifact-9"),
        evaluations: [evaluation(search.id, "h1")],
      }),
    );

    expect(response.status).toBe(200);
    const stored = await crmStore().get<SavedSearchDoc>("searches", search.id);
    // Undefined here when the schema drops the field, which is what made the
    // suppression below impossible.
    expect(stored?.matches[PARCEL]?.artifactRunId).toBe("artifact-9");
  });

  it("suppresses a fingerprint that moved without the artifact moving", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });

    // Pass one seeds the watch. A search the matcher has never evaluated is
    // seeded rather than announced, so nothing is raised here either way.
    await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: "run-2026-08-19T04-00-00Z",
        dataSource: dataSource("artifact-9"),
        evaluations: [evaluation(search.id, "h1")],
      }),
    );

    // Pass two reads the SAME artifact and gets a different fingerprint. That
    // is a bug in the reader, not a change in the world.
    const second = await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: "run-2026-08-19T04-00-00Z",
        dataSource: dataSource("artifact-9"),
        evaluations: [evaluation(search.id, "h2")],
      }),
    );

    const result = (await bodyOf(second)) as {
      alertsCreated: number;
      outcomes: { unstableReads: number; updatedMatches: number }[];
    };

    expect(result.outcomes[0]?.unstableReads).toBe(1);
    expect(result.outcomes[0]?.updatedMatches).toBe(0);
    expect(result.alertsCreated).toBe(0);
    expect(await crmStore().list<AlertDoc>("alerts")).toHaveLength(0);
  });

  it("still alerts when the artifact really did move", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });

    await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: "run-2026-08-19T04-00-00Z",
        dataSource: dataSource("artifact-9"),
        evaluations: [evaluation(search.id, "h1")],
      }),
    );

    const second = await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: "run-2026-08-20T04-00-00Z",
        dataSource: dataSource("artifact-10"),
        evaluations: [evaluation(search.id, "h2")],
      }),
    );

    const result = (await bodyOf(second)) as { alertsCreated: number };
    expect(result.alertsCreated).toBe(1);

    // And the alert is keyed on the generation, so a retry of that pass is a
    // no-op rather than a second notification.
    const [raised] = await crmStore().list<AlertDoc>("alerts");
    expect(raised?.id).toBe(alertId("artifact-10", search.id, PARCEL));
  });

  it("refuses a saved search id that nothing could have minted", async () => {
    const response = await runMatcher(
      request("/api/matcher/run", {
        trigger: "browser",
        pipelineRunId: null,
        dataSource: dataSource(null),
        evaluations: [evaluation("6f1c9f0e-0000-4000-8000-000000000000", "h1")],
      }),
    );

    expect(response.status).toBe(400);
  });
});
