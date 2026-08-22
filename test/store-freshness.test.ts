/**
 * A read must not answer from before a write that has already been acknowledged.
 *
 * The git store caches the branch tree per process, and a deployment runs many
 * processes. A PATCH landed on one instance, the reload after it was routed to
 * another, and that one served a tree up to sixty seconds old: the stage change
 * was committed, the API had said 200, and the board still showed the old
 * stage. `cache: "no-store"` in the browser cannot fix that, because the origin
 * itself is the thing that is behind.
 *
 * The fix is to revalidate on the read path instead of trusting a clock. What
 * makes that affordable is that a conditional tree request costs no rate-limit
 * budget when nothing has changed, so the cost is bounded by the number of
 * WRITES rather than the number of reads - and the write path keeps using the
 * cached tree, so a bulk loop does not spend a tree read per document. That
 * last part is not a detail: request amplification on the write path is what
 * once exhausted GitHub's 5,000 an hour and took every CRM read down with it
 * (commit 7293511), and these tests hold the line on both sides at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpportunityDoc } from "@/lib/crm/documents";
import { serialise } from "@/lib/crm/store";
import { GitHubCrmStore } from "@/lib/crm/store-github";

const REPO = "example/crm-state";
const ROOT = "crm";
const PARCEL = "1654190105R";
const PATH = `${ROOT}/opportunities/${PARCEL}.json`;

function opportunity(stage: OpportunityDoc["stage"], id = PARCEL): OpportunityDoc {
  return {
    id,
    propertyId: id,
    parcelIdentifier: null,
    addressLine: "1 SOMEWHERE ST, JACKSONVILLE",
    addressCity: "JACKSONVILLE",
    addressZip: null,
    latitude: null,
    longitude: null,
    assessedValue: 180_000,
    ownerNameSnapshot: "SMITH JOHN",
    propertySnapshot: {},
    ownerId: null,
    stage,
    savedSearchId: null,
    alertId: null,
    matchScore: 88,
    matchRationale: null,
    assigneeId: null,
    ownerInterest: null,
    askingPrice: null,
    offerPrice: null,
    nextStep: null,
    nextStepDueAt: null,
    stageEvents: [],
    notes: [],
    tasks: [],
    outreach: [],
    createdAt: "2026-08-19T05:00:00.000Z",
    updatedAt: "2026-08-19T05:00:00.000Z",
    closedAt: null,
  };
}

/**
 * A GitHub that behaves like the real one in the two ways that matter here: it
 * versions the branch, and it honours `if-none-match` with a 304.
 *
 * The counters are the point. "Did the read see the write" is only half the
 * question; the other half is what it cost to find out, and a fix that is
 * correct and doubles the request count would be the previous outage again.
 */
class FakeGitHub {
  readonly blobs = new Map<string, string>();
  readonly shas = new Map<string, string>();
  #blobSeq = 0;
  version = 0;

  treeRequests = 0;
  treeNotModified = 0;
  blobRequests = 0;
  putRequests = 0;
  /** When true the branch is refused, as an exhausted hourly budget does. */
  rateLimited = false;

  get etag(): string {
    return `W/"tree-${this.version}"`;
  }

  commit(path: string, body: string): void {
    this.#blobSeq += 1;
    this.version += 1;
    this.blobs.set(path, body);
    this.shas.set(path, `blob${this.#blobSeq}`);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);

    if (url.includes("/git/trees/")) {
      this.treeRequests += 1;

      if (this.rateLimited) {
        return new Response(JSON.stringify({ message: "rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
        });
      }

      if (headers.get("if-none-match") === this.etag) {
        this.treeNotModified += 1;
        return new Response(null, { status: 304, headers: { etag: this.etag } });
      }

      const tree = [...this.shas].map(([path, sha]) => ({ path, type: "blob", sha }));
      return new Response(JSON.stringify({ tree, truncated: false }), {
        status: 200,
        headers: { etag: this.etag },
      });
    }

    if (url.includes("/git/blobs/")) {
      this.blobRequests += 1;
      const sha = url.slice(url.lastIndexOf("/") + 1);
      const path = [...this.shas].find(([, value]) => value === sha)?.[0];
      const body = path ? this.blobs.get(path) : undefined;
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }

    if (url.includes("/contents/") && init?.method === "PUT") {
      this.putRequests += 1;
      const path = decodeURIComponent(url.slice(url.indexOf("/contents/") + "/contents/".length));
      const sent = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if ((this.shas.get(path) ?? undefined) !== sent.sha) {
        return new Response(JSON.stringify({ message: "does not match" }), { status: 409 });
      }
      this.commit(path, Buffer.from(sent.content, "base64").toString("utf8"));
      return new Response(JSON.stringify({ content: { sha: this.shas.get(path) } }), {
        status: 200,
      });
    }

    throw new Error(`the fake was asked for something it does not serve: ${url}`);
  };
}

/** A fresh store object stands in for a separate serverless instance. */
function instance(): GitHubCrmStore {
  return new GitHubCrmStore({
    repository: REPO,
    branch: "crm-state",
    root: ROOT,
    token: "test-token",
    authorName: "test",
    authorEmail: "test@example.invalid",
  });
}

let github: FakeGitHub;

beforeEach(() => {
  github = new FakeGitHub();
  vi.stubGlobal("fetch", github.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a read on another instance", () => {
  it("sees a write that a different instance has already acknowledged", async () => {
    github.commit(PATH, serialise(opportunity("identified")));

    const writer = instance();
    const reader = instance();

    // The reader is warm, which is the whole difficulty: it has a tree, the
    // tree is recent, and under a time-based cache it would be trusted.
    const before = await reader.get<OpportunityDoc>("opportunities", PARCEL);
    expect(before?.stage).toBe("identified");

    // Somebody advances the stage, on the instance their PATCH happened to
    // reach. This returns only once GitHub has committed it.
    await writer.update<OpportunityDoc>("opportunities", PARCEL, (current) =>
      current ? { ...current, stage: "contacted" } : null,
    );

    // The reload is routed back to the first instance. It must not answer from
    // its own minute-old copy.
    const after = await reader.get<OpportunityDoc>("opportunities", PARCEL);
    expect(after?.stage).toBe("contacted");
  });

  it("sees a document another instance created, not just one it changed", async () => {
    const writer = instance();
    const reader = instance();

    expect(await reader.list<OpportunityDoc>("opportunities")).toHaveLength(0);

    await writer.put<OpportunityDoc>("opportunities", opportunity("identified"));

    expect(await reader.list<OpportunityDoc>("opportunities")).toHaveLength(1);
  });

  it("sees a document another instance deleted", async () => {
    github.commit(PATH, serialise(opportunity("identified")));
    const reader = instance();
    await reader.list<OpportunityDoc>("opportunities");

    // Deleting outside the store, the way another instance's commit looks from
    // here: the branch moves and nothing local is told.
    github.version += 1;
    github.blobs.delete(PATH);
    github.shas.delete(PATH);

    expect(await reader.list<OpportunityDoc>("opportunities")).toHaveLength(0);
  });
});

describe("what revalidating costs", () => {
  it("spends no budget and reads no blob when nothing has changed", async () => {
    github.commit(PATH, serialise(opportunity("identified")));
    const store = instance();

    await store.list<OpportunityDoc>("opportunities");
    const blobsAfterFirst = github.blobRequests;

    // Five more reads over a tree that has not moved.
    for (let index = 0; index < 5; index += 1) {
      await store.list<OpportunityDoc>("opportunities");
    }

    // Each read did ask - that is the guarantee - but every answer was a 304,
    // which GitHub does not charge against the hourly budget, and none of them
    // re-read a document.
    expect(github.treeRequests).toBe(6);
    expect(github.treeNotModified).toBe(5);
    expect(github.blobRequests).toBe(blobsAfterFirst);
  });

  it("re-reads only the document whose sha moved", async () => {
    for (let index = 0; index < 5; index += 1) {
      github.commit(
        `${ROOT}/opportunities/parcel-${index}.json`,
        serialise(opportunity("identified", `parcel-${index}`)),
      );
    }

    const writer = instance();
    const reader = instance();
    await reader.list<OpportunityDoc>("opportunities");
    expect(github.blobRequests).toBe(5);

    await writer.put<OpportunityDoc>("opportunities", opportunity("contacted", "parcel-2"));
    // The writer is a cold instance and had to load the collection to find the
    // sha it was writing against, so measure the reader's cost from here.
    const beforeReread = github.blobRequests;

    const rows = await reader.list<OpportunityDoc>("opportunities");
    expect(rows.find((row) => row.id === "parcel-2")?.stage).toBe("contacted");
    // One changed document, one blob read. Not five.
    expect(github.blobRequests).toBe(beforeReread + 1);
  });

  it("collapses the four collections one page load reads into a single request", async () => {
    const store = instance();

    await Promise.all([
      store.list("opportunities"),
      store.list("owners"),
      store.list("team"),
      store.list("searches"),
    ]);

    expect(github.treeRequests).toBe(1);
  });

  it("does not read the tree again for every document a bulk write touches", async () => {
    const store = instance();
    await store.list<OpportunityDoc>("opportunities");
    const treeAfterWarmup = github.treeRequests;

    // A campaign across twenty opportunities. This is the shape that once
    // walked the account into the hourly limit: one tree read per document on
    // top of the write itself.
    for (let index = 0; index < 20; index += 1) {
      await store.put<OpportunityDoc>("opportunities", opportunity("contacted", `parcel-${index}`));
    }

    expect(github.putRequests).toBe(20);
    expect(github.treeRequests).toBe(treeAfterWarmup);
  });
});

describe("when the hourly budget is gone", () => {
  it("serves the last good copy and stops asking until the reset", async () => {
    github.commit(PATH, serialise(opportunity("identified")));
    const store = instance();

    await store.list<OpportunityDoc>("opportunities");
    const before = github.treeRequests;

    github.rateLimited = true;

    const first = await store.list<OpportunityDoc>("opportunities");
    const second = await store.list<OpportunityDoc>("opportunities");
    const third = await store.get<OpportunityDoc>("opportunities", PARCEL);

    // A board showing state a few minutes old beats a board answering 500.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third?.stage).toBe("identified");
    expect(store.degraded).toBe(true);
    // One refusal was enough to learn there is nothing to gain by asking again.
    expect(github.treeRequests).toBe(before + 1);
  });
});
