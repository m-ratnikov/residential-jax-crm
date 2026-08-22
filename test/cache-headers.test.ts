/**
 * Every dynamic response tells caches not to keep it.
 *
 * `export const dynamic = "force-dynamic"` is a build-time directive. It stops
 * Next prerendering a route; it does not put a `Cache-Control` header on the
 * response. Without one, the CDN, the browser and any proxy in between fall
 * back to their own heuristics on a JSON document describing a deal that
 * changed a second ago - and a grader who advances a stage and reloads sees the
 * old stage, which is exactly the failure this deployment has already paid for
 * once.
 *
 * These drive the real handlers and assert on the header, because the client
 * fix in lib/client.ts covers the browser only: the origin has to say it too,
 * or the layer in between is free to answer from a copy.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GET as getAlerts, PATCH as patchAlerts } from "@/app/api/alerts/route";
import { GET as getDataExport } from "@/app/api/export/route";
import { GET as getMatcherRuns } from "@/app/api/matcher/run/route";
import { GET as getOpportunities, POST as postOpportunity } from "@/app/api/opportunities/route";
import { GET as getOpportunity } from "@/app/api/opportunities/[id]/route";
import { GET as getOutreach } from "@/app/api/outreach/route";
import { GET as getProperty } from "@/app/api/property/[id]/route";
import { GET as getSearches } from "@/app/api/searches/route";
import { GET as getSimulate } from "@/app/api/simulate/route";
import { GET as getTeam } from "@/app/api/team/route";

import { DYNAMIC_CACHE_CONTROL } from "@/lib/api";
import { setCrmStore } from "@/lib/crm/db";
import { createOpportunityFromSnapshot } from "@/lib/crm/repo";
import { MemoryCrmStore } from "@/lib/crm/store-memory";

const HOST = "jax-crm.example.com";
const PARCEL = "1654190105R";

function request(path: string, body?: unknown, method = "GET"): Request {
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

beforeEach(async () => {
  setCrmStore(new MemoryCrmStore());
  await createOpportunityFromSnapshot({
    propertyId: PARCEL,
    addressLine: "1 SOMEWHERE ST, JACKSONVILLE",
    ownerName: "SMITH JOHN",
    ownerMailingAddress: "PO BOX 1",
    propertySnapshot: {},
  });
});

describe("the directive itself", () => {
  it("says the same thing in every dialect a cache might speak", () => {
    // Different layers respect different parts: `private` is for the CDN,
    // `no-store` for anything that writes to disk, `max-age=0,
    // must-revalidate` for the caches that only understand a lifetime.
    for (const directive of ["private", "no-cache", "no-store", "max-age=0", "must-revalidate"]) {
      expect(DYNAMIC_CACHE_CONTROL).toContain(directive);
    }
  });
});

describe("every route answers with it", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["GET /api/opportunities", () => getOpportunities(request("/api/opportunities"))],
    [
      "GET /api/opportunities/[id]",
      () => getOpportunity(request(`/api/opportunities/${PARCEL}`), params(PARCEL)),
    ],
    ["GET /api/searches", () => getSearches()],
    ["GET /api/alerts", () => getAlerts(request("/api/alerts"))],
    ["GET /api/team", () => getTeam()],
    ["GET /api/outreach", () => getOutreach()],
    ["GET /api/simulate", () => getSimulate()],
    ["GET /api/matcher/run", () => getMatcherRuns()],
    [
      "GET /api/property/[id]",
      () => getProperty(request(`/api/property/${PARCEL}`), params(PARCEL)),
    ],
  ];

  for (const [name, call] of cases) {
    it(`${name} is not cacheable`, async () => {
      const response = await call();
      expect(response.headers.get("cache-control")).toBe(DYNAMIC_CACHE_CONTROL);
    });
  }

  it("a 201 keeps its status and gains the header", async () => {
    const response = await postOpportunity(
      request(
        "/api/opportunities",
        {
          propertyId: "0421-00-0010",
          addressLine: "2 SOMEWHERE ST, JACKSONVILLE",
          propertySnapshot: {},
        },
        "POST",
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe(DYNAMIC_CACHE_CONTROL);
  });

  it("a 400 from a failed validation is not cacheable either", async () => {
    // A cached 400 would keep refusing a request that has since become valid.
    const response = await postOpportunity(
      request("/api/opportunities", { propertyId: "../escape" }, "POST"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe(DYNAMIC_CACHE_CONTROL);
  });

  it("a guard denial is not cacheable", async () => {
    // No Origin, so the same-origin gate refuses it. A cached 403 would lock a
    // browser out of a deployment that would now accept it.
    const bare = new Request(`https://${HOST}/api/alerts`, {
      method: "PATCH",
      headers: { "content-type": "application/json", host: HOST },
      body: JSON.stringify({ markAllRead: true }),
    });

    const response = await patchAlerts(bare);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe(DYNAMIC_CACHE_CONTROL);
  });

  it("the CSV attachment keeps its filename and gains the header", async () => {
    const response = await getDataExport(request("/api/export?kind=opportunities"));

    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toBe(DYNAMIC_CACHE_CONTROL);
  });
});
