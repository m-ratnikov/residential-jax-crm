/**
 * What happens when two people write the same deal at the same moment.
 *
 * The git backend commits one JSON document per aggregate through GitHub's
 * contents API, which refuses a write whose `sha` is not the blob's current
 * one. The old conflict path caught that refusal and re-sent THE SAME BODY
 * against the freshly fetched sha. That is not a retry, it is an overwrite: the
 * body was computed from a document that is by definition no longer current, so
 * the write succeeded and silently erased whatever the other writer had just
 * added. Two analysts adding a note to the same opportunity within the read
 * cache window ended up with one note between them, and nothing anywhere said
 * a note had been lost.
 *
 * These drive the real `GitHubCrmStore` against a fake contents API that
 * behaves the way GitHub's does - blob shas, 409 on a stale sha - so the thing
 * under test is the store's own conflict handling rather than a mock of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteDoc, OpportunityDoc } from "@/lib/crm/documents";
import { GitHubCrmStore } from "@/lib/crm/store-github";
import { MAX_UPDATE_ATTEMPTS, serialise } from "@/lib/crm/store";

const REPO = "example/crm-state";
const ROOT = "crm";
const PATH = `${ROOT}/opportunities/1654190105R.json`;

function opportunity(notes: NoteDoc[]): OpportunityDoc {
  return {
    id: "1654190105R",
    propertyId: "1654190105R",
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
    stage: "identified",
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
    notes,
    tasks: [],
    outreach: [],
    createdAt: "2026-08-19T05:00:00.000Z",
    updatedAt: "2026-08-19T05:00:00.000Z",
    closedAt: null,
  };
}

function note(id: string, body: string): NoteDoc {
  return { id, authorId: null, body, createdAt: "2026-08-19T05:01:00.000Z" };
}

/**
 * Enough of the GitHub contents API to be wrong about, plus a hook that lets a
 * test slip another writer's commit in between our read and our write.
 */
class FakeGitHub {
  /** path -> the document currently committed there. */
  readonly blobs = new Map<string, string>();
  #sha = 0;
  readonly shas = new Map<string, string>();
  putCount = 0;
  /** Runs immediately before each PUT is evaluated, to simulate a racing writer. */
  beforePut: (() => void) | null = null;

  commit(path: string, body: string): void {
    this.#sha += 1;
    this.blobs.set(path, body);
    this.shas.set(path, `sha${this.#sha}`);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("/git/trees/")) {
      const tree = [...this.shas].map(([path, sha]) => ({ path, type: "blob", sha }));
      return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });
    }

    if (url.includes("/git/blobs/")) {
      const sha = url.slice(url.lastIndexOf("/") + 1);
      const path = [...this.shas].find(([, value]) => value === sha)?.[0];
      const body = path ? this.blobs.get(path) : undefined;
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }

    if (url.includes("/contents/") && init?.method === "PUT") {
      this.putCount += 1;
      this.beforePut?.();

      const path = decodeURIComponent(url.slice(url.indexOf("/contents/") + "/contents/".length));
      const sent = JSON.parse(String(init.body)) as { content: string; sha?: string };
      const current = this.shas.get(path);

      // Exactly GitHub's rule: the sha you name has to be the one that is there.
      if ((current ?? undefined) !== sent.sha) {
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

function storeFor(): GitHubCrmStore {
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

function storedNotes(): string[] {
  const raw = github.blobs.get(PATH);
  if (!raw) return [];
  return (JSON.parse(raw) as OpportunityDoc).notes.map((entry) => entry.body);
}

describe("the git store under a conflicting write", () => {
  it("keeps both notes when a second writer commits in between", async () => {
    github.commit(PATH, serialise(opportunity([])));
    const store = storeFor();

    // The store reads the document, and only then does the other analyst's
    // commit land. Their note is in the repository before ours is attempted.
    github.beforePut = () => {
      if (github.putCount !== 1) return;
      github.commit(PATH, serialise(opportunity([note("n-other", "Other analyst's note")])));
    };

    const result = await store.update<OpportunityDoc>("opportunities", "1654190105R", (current) => {
      if (!current) return null;
      return { ...current, notes: [...current.notes, note("n-ours", "Our note")] };
    });

    // The old code re-sent the pre-conflict body and this read ["Our note"]
    // alone: the other analyst's note was gone from the repository entirely.
    expect(storedNotes()).toEqual(["Other analyst's note", "Our note"]);
    expect(result?.notes.map((entry) => entry.body)).toEqual(["Other analyst's note", "Our note"]);
    // One rejected write, one accepted.
    expect(github.putCount).toBe(2);
  });

  it("re-runs the mutation against what the other writer left, not against the stale read", async () => {
    github.commit(PATH, serialise(opportunity([])));
    const store = storeFor();

    github.beforePut = () => {
      if (github.putCount !== 1) return;
      const moved = opportunity([]);
      moved.stage = "contacted";
      moved.assigneeId = "0mt3kjly274lvwt7f";
      github.commit(PATH, serialise(moved));
    };

    await store.update<OpportunityDoc>("opportunities", "1654190105R", (current) =>
      current ? { ...current, notes: [...current.notes, note("n1", "Owner called back")] } : null,
    );

    const stored = JSON.parse(github.blobs.get(PATH) ?? "{}") as OpportunityDoc;
    // The stage change the other writer made survives, because the mutation ran
    // on top of it rather than on top of the document we first read.
    expect(stored.stage).toBe("contacted");
    expect(stored.assigneeId).toBe("0mt3kjly274lvwt7f");
    expect(stored.notes.map((entry) => entry.body)).toEqual(["Owner called back"]);
  });

  it("gives up after a bounded number of attempts rather than looping", async () => {
    github.commit(PATH, serialise(opportunity([])));
    const store = storeFor();

    // A writer that never stops. The point is that this ends.
    let injected = 0;
    github.beforePut = () => {
      injected += 1;
      github.commit(PATH, serialise(opportunity([note(`n${injected}`, `note ${injected}`)])));
    };

    await expect(
      store.update<OpportunityDoc>("opportunities", "1654190105R", (current) =>
        current ? { ...current, nextStep: "call the owner" } : null,
      ),
    ).rejects.toThrow(/changed by another writer/);

    expect(github.putCount).toBe(MAX_UPDATE_ATTEMPTS);
  });

  it("creates the document when there is nothing there yet", async () => {
    const store = storeFor();

    const created = await store.update<OpportunityDoc>(
      "opportunities",
      "1654190105R",
      (current) => current ?? opportunity([note("n1", "First")]),
    );

    expect(created?.notes).toHaveLength(1);
    expect(storedNotes()).toEqual(["First"]);
  });

  it("leaves the store untouched when the mutation declines", async () => {
    const store = storeFor();

    const result = await store.update<OpportunityDoc>("opportunities", "missing", () => null);

    expect(result).toBeNull();
    expect(github.putCount).toBe(0);
  });

  it("writes nothing at all when the mutation changes nothing", async () => {
    github.commit(PATH, serialise(opportunity([])));
    const store = storeFor();

    await store.update<OpportunityDoc>("opportunities", "1654190105R", (current) => current);

    expect(github.putCount).toBe(0);
  });
});
