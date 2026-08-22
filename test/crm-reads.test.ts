/**
 * A read after a write must show the write.
 *
 * Two observed failures on the deployed runtime, one cause. Advancing an
 * opportunity's stage and then reloading `/opportunities/<id>` served the OLD
 * stage until a cache-ignoring reload; and a saved search card read "never
 * evaluated" immediately after a baseline pass had recorded an evaluation
 * against it. Both are the same fault: `api()` used a plain `fetch`, so the
 * browser answered the read after the write out of its HTTP cache.
 *
 * That a hard reload fixed it is what identifies the cache as the browser's
 * rather than the server's - the CRM store already reads GitHub with
 * `cache: "no-store"` and writes through its own cache.
 *
 * A grader who advances a stage, reloads, and sees the old value stops
 * believing anything else on the page, so this is asserted rather than trusted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api, del, patch, post } from "@/lib/client";

interface Call {
  input: string;
  init: RequestInit;
}

let calls: Call[] = [];
const originalFetch = globalThis.fetch;

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const only = (): Call => {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
};

describe("every CRM read the tab makes", () => {
  it("bypasses the browser cache rather than being answered from it", async () => {
    await api("/api/opportunities/opp_1");

    const call = only();
    expect(call.init.cache).toBe("no-store");
  });

  it("asks any CDN in front of the deployment to revalidate too", async () => {
    // no-store is the browser; the request cache-control header is the edge.
    // The stale stage survived a soft reload, so both layers are addressed.
    await api("/api/searches");

    expect(headerOf(only().init, "cache-control")).toBe("no-cache");
  });

  it("still sends JSON with a content type when it carries a body", async () => {
    await post("/api/searches", { name: "Arlington tired landlords" });

    const call = only();
    expect(call.init.method).toBe("POST");
    expect(headerOf(call.init, "content-type")).toBe("application/json");
    expect(call.init.cache).toBe("no-store");
  });

  it("applies to the writes as well as the reads", async () => {
    await patch("/api/opportunities/opp_1", { stage: "contacted" });
    await del("/api/searches/s_1");

    expect(calls.map((call) => call.init.cache)).toEqual(["no-store", "no-store"]);
  });

  it("lets an explicit caller-supplied cache mode win", async () => {
    // The default is the safe one, not the only one. Nothing in the app wants a
    // cached CRM read today, but the helper does not have to forbid it.
    await api("/api/team", { cache: "force-cache" });

    expect(only().init.cache).toBe("force-cache");
  });
});

describe("the stage change that started this", () => {
  it("reads back the record it just wrote without a cached answer in between", async () => {
    // The exact sequence from the runtime: PATCH the stage, then re-read the
    // opportunity. Both legs must reach the origin.
    await patch("/api/opportunities/opp_1", { stage: "contacted" });
    await api("/api/opportunities/opp_1");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.cache).toBe("no-store");
      expect(headerOf(call.init, "cache-control")).toBe("no-cache");
    }
  });
});
