/**
 * The bounds on an anonymous caller.
 *
 * Worth testing rather than eyeballing, because every one of these failures is
 * silent. A gate that lets a bare request through leaves the deployment's store
 * token writing whatever a stranger posts; a gate that rejects a same-origin
 * request breaks the reviewer's browser and nothing in the UI says why; and a
 * proxy path guard that admits `..` hands the deployment's model key to an
 * upstream endpoint the model allowlist never saw.
 */

import { describe, expect, it } from "vitest";

import {
  checkMutation,
  guardMutation,
  isSafeProxyPath,
  isSafeProxySegment,
  sameOriginRequest,
} from "@/lib/api-auth";
import { RateLimiter } from "@/lib/agent/ratelimit";

const DEPLOYMENT = "https://jax-crm.example.com";

const makeEnv = (values: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...values }) as NodeJS.ProcessEnv;

/** What the browser sends when a page on this deployment posts to its own API. */
function browserRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${DEPLOYMENT}/api/searches`, {
    method: "POST",
    headers: {
      origin: DEPLOYMENT,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body: "{}",
  });
}

/** What `curl -X POST` sends: no Origin, no fetch metadata. */
function bareRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${DEPLOYMENT}/api/searches`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

/** A fresh limiter per test, so one test's budget is not another's. */
const limiterOf = (limit: number) => new RateLimiter({ limit, windowMs: 60_000 });

describe("checkMutation", () => {
  it("lets the application's own pages write, with no login", () => {
    expect(checkMutation(browserRequest(), { env: makeEnv(), limiter: limiterOf(10) })).toBeNull();
  });

  it("refuses a request that carries no Origin at all", () => {
    const denial = checkMutation(bareRequest(), { env: makeEnv(), limiter: limiterOf(10) });
    expect(denial?.status).toBe(403);
    expect(denial?.code).toBe("cross_origin_write");
  });

  it("refuses a page on another site driving a visitor's browser", () => {
    const denial = checkMutation(
      browserRequest({ origin: "https://evil.example.net", "sec-fetch-site": "cross-site" }),
      { env: makeEnv(), limiter: limiterOf(10) },
    );
    expect(denial?.status).toBe(403);
  });

  it("refuses an Origin naming a different host even without fetch metadata", () => {
    const request = new Request(`${DEPLOYMENT}/api/searches`, {
      method: "POST",
      headers: { origin: "https://jax-crm.example.com.evil.net" },
    });
    expect(checkMutation(request, { env: makeEnv(), limiter: limiterOf(10) })?.status).toBe(403);
  });

  it("trusts the host the proxy says the request was addressed to", () => {
    const request = new Request("http://internal.vercel.local/api/searches", {
      method: "POST",
      headers: {
        origin: DEPLOYMENT,
        "x-forwarded-host": "jax-crm.example.com",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(checkMutation(request, { env: makeEnv(), limiter: limiterOf(10) })).toBeNull();
  });

  it("accepts an origin the deployment names explicitly", () => {
    const request = browserRequest({
      origin: "https://crm.acme.test",
      "sec-fetch-site": "same-site",
    });
    const env = makeEnv({ CRM_ALLOWED_ORIGINS: "https://crm.acme.test" });
    expect(checkMutation(request, { env, limiter: limiterOf(10) })).toBeNull();
  });

  it("freezes every mutation when the deployment is switched to read only", () => {
    const denial = checkMutation(browserRequest(), {
      env: makeEnv({ CRM_READ_ONLY: "1" }),
      limiter: limiterOf(10),
    });
    expect(denial?.status).toBe(503);
    expect(denial?.code).toBe("writes_disabled");
  });

  it("read only outranks a valid write token, so the switch cannot be worked around", () => {
    const env = makeEnv({ CRM_READ_ONLY: "true", CRM_WRITE_TOKEN: "s3cret" });
    const denial = checkMutation(browserRequest({ authorization: "Bearer s3cret" }), {
      env,
      limiter: limiterOf(10),
    });
    expect(denial?.code).toBe("writes_disabled");
  });

  describe("with CRM_WRITE_TOKEN configured", () => {
    const env = makeEnv({ CRM_WRITE_TOKEN: "s3cret" });

    it("refuses a browser that does not hold it", () => {
      const denial = checkMutation(browserRequest(), { env, limiter: limiterOf(10) });
      expect(denial?.status).toBe(401);
      expect(denial?.code).toBe("unauthorised");
    });

    it("accepts it as a bearer token", () => {
      const request = bareRequest({ authorization: "Bearer s3cret" });
      expect(checkMutation(request, { env, limiter: limiterOf(10) })).toBeNull();
    });

    it("accepts it as x-crm-write-token", () => {
      const request = bareRequest({ "x-crm-write-token": "s3cret" });
      expect(checkMutation(request, { env, limiter: limiterOf(10) })).toBeNull();
    });

    it("refuses a token that is merely a prefix of the real one", () => {
      const request = bareRequest({ authorization: "Bearer s3cre" });
      expect(checkMutation(request, { env, limiter: limiterOf(10) })?.status).toBe(401);
    });
  });

  it("lets a scheduler holding the matcher token through without a browser Origin", () => {
    const request = bareRequest({ "x-matcher-token": "cron-token" });
    const denial = checkMutation(request, {
      env: makeEnv({ MATCHER_TOKEN: "cron-token" }),
      secrets: ["cron-token"],
      limiter: limiterOf(10),
    });
    expect(denial).toBeNull();
  });

  it("does not treat an unconfigured secret as a way in", () => {
    const request = bareRequest({ "x-matcher-token": "anything" });
    const denial = checkMutation(request, {
      env: makeEnv(),
      secrets: [undefined, "", null],
      limiter: limiterOf(10),
    });
    expect(denial?.status).toBe(403);
  });

  it("bounds how many writes one address gets", () => {
    const limiter = limiterOf(3);
    const env = makeEnv();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(checkMutation(browserRequest(), { env, limiter })).toBeNull();
    }

    const denial = checkMutation(browserRequest(), { env, limiter });
    expect(denial?.status).toBe(429);
    expect(denial?.code).toBe("rate_limited");
    expect(denial?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each address separately, so one abuser does not lock out a reviewer", () => {
    const limiter = limiterOf(1);
    const env = makeEnv();
    expect(
      checkMutation(browserRequest({ "x-forwarded-for": "198.51.100.1" }), { env, limiter }),
    ).toBeNull();
    expect(
      checkMutation(browserRequest({ "x-forwarded-for": "198.51.100.2" }), { env, limiter }),
    ).toBeNull();
    expect(
      checkMutation(browserRequest({ "x-forwarded-for": "198.51.100.1" }), { env, limiter })
        ?.status,
    ).toBe(429);
  });
});

describe("guardMutation", () => {
  it("says nothing when the mutation may proceed", () => {
    expect(guardMutation(browserRequest(), { env: makeEnv(), limiter: limiterOf(10) })).toBeNull();
  });

  it("answers a refused mutation with the API's own error shape", async () => {
    const response = guardMutation(bareRequest(), { env: makeEnv(), limiter: limiterOf(10) });
    expect(response?.status).toBe(403);

    const body = (await response?.json()) as { error: string; code: string };
    expect(body.code).toBe("cross_origin_write");
    expect(body.error).toMatch(/own pages/i);
  });

  it("tells a rate limited caller when to come back", async () => {
    const limiter = limiterOf(1);
    const env = makeEnv();
    guardMutation(browserRequest(), { env, limiter });

    const response = guardMutation(browserRequest(), { env, limiter });
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("sameOriginRequest", () => {
  it("reads sec-fetch-site before anything else", () => {
    expect(sameOriginRequest(browserRequest({ "sec-fetch-site": "cross-site" }), makeEnv())).toBe(
      false,
    );
  });

  it("rejects an opaque origin", () => {
    expect(sameOriginRequest(browserRequest({ origin: "null" }), makeEnv())).toBe(false);
  });

  it("rejects an unparseable origin rather than throwing", () => {
    expect(sameOriginRequest(browserRequest({ origin: "not a url" }), makeEnv())).toBe(false);
  });
});

describe("isSafeProxySegment", () => {
  it("admits the paths the providers in the registry actually use", () => {
    expect(isSafeProxyPath(["v1", "chat", "completions"])).toBe(true);
    expect(isSafeProxyPath(["v1", "messages"])).toBe(true);
    // Google names the model in the path, and the colon is load bearing.
    expect(isSafeProxyPath(["v1beta", "models", "gemini-3.5-flash:generateContent"])).toBe(true);
    expect(isSafeProxyPath(["v1beta", "models", "gemini-3.5-flash:streamGenerateContent"])).toBe(
      true,
    );
  });

  it("refuses a traversal segment, which the charset alone would admit", () => {
    // The whole point: `..` is made only of characters the charset allows, and
    // fetch resolves it away, so it would reach an upstream path the model
    // allowlist never checked.
    expect(/^[A-Za-z0-9._:-]+$/.test("..")).toBe(true);
    expect(isSafeProxySegment("..")).toBe(false);
    expect(isSafeProxySegment(".")).toBe(false);
    expect(isSafeProxyPath(["v1beta", "..", "..", "v1", "models"])).toBe(false);
    expect(isSafeProxyPath(["models", "..", "expensive-model:generateContent"])).toBe(false);
  });

  it("still admits names that merely contain dots", () => {
    expect(isSafeProxySegment("gpt-4.1-mini")).toBe(true);
    expect(isSafeProxySegment("...")).toBe(true);
  });

  it("refuses anything that could climb out of the base URL another way", () => {
    for (const segment of [
      "..%2f..",
      "%2e%2e",
      "a/b",
      "a\\b",
      "a b",
      "?x=1",
      "#fragment",
      "@evil.example.net",
      "",
    ]) {
      expect(isSafeProxySegment(segment)).toBe(false);
    }
  });

  it("refuses an empty path", () => {
    expect(isSafeProxyPath([])).toBe(false);
  });
});
