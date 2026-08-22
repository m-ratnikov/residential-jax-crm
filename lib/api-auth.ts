/**
 * What a caller has to be to change anything.
 *
 * THE SITUATION, STATED PLAINLY. This runtime is deliberately public and has no
 * login, because a reviewer has to be able to use every feature from a cold
 * browser with no credentials. It also holds a write token for the CRM store
 * (a branch of a GitHub repository, or a Postgres). Those two facts together
 * mean the deployment writes on the owner's credential on behalf of whoever
 * shows up. There is no configuration of this file that changes that while the
 * runtime stays open, and pretending otherwise would be the dishonest option.
 *
 * So this is not authentication. It is a set of bounds on what an anonymous
 * caller can do, in the order they are cheapest to apply:
 *
 *  1. A KILL SWITCH. `CRM_READ_ONLY=1` refuses every mutation with a 503 the
 *     UI already knows how to render. It is an environment variable rather than
 *     a code change so a deployment under abuse can be frozen from a dashboard
 *     in seconds, without a redeploy and without taking search offline.
 *  2. A LOCK, for deployments that are not demos. With `CRM_WRITE_TOKEN` set,
 *     mutations require it and the public runtime becomes read only to
 *     strangers. Unset by default, which is what keeps the reviewer's browser
 *     working with no login.
 *  3. A SAME ORIGIN GATE. A mutation must carry an `Origin` naming this
 *     deployment's own host, and must not announce itself as cross-site. This
 *     is real protection against one thing and one thing only: another web page
 *     driving a visitor's browser into writing here (CSRF). Browsers set both
 *     headers themselves and a page cannot forge either. It also happens to
 *     turn the one-line attack - `curl -X POST https://.../api/searches` with a
 *     body - into a 403, because curl sends no Origin.
 *  4. A RATE LIMIT per address on the mutations, and a tighter one on the
 *     expensive ones (a matcher pass, an outreach campaign, a simulation).
 *
 * WHAT THIS DOES NOT STOP, exactly. A determined caller who adds
 * `-H "Origin: https://<this deployment>"` to that curl is through the gate:
 * step 3 checks a header, and only a browser is bound to tell the truth in it.
 * What is left in their way is step 4, and the limiter's own comment is honest
 * that it counts per serverless instance rather than globally. So the boundary
 * this file draws is: no cross-site writes at all, no drive-by writes from a
 * bare request, and a bounded rate of writes for someone who reads this file
 * and decides to write anyway. Preventing that last case needs a login, and a
 * login is the one thing this runtime is not allowed to have.
 *
 * None of it applies to the scheduled matcher or the seed and verify scripts:
 * they call the store directly rather than over HTTP.
 */

import { NextResponse } from "next/server";

import { RateLimiter, clientAddress } from "@/lib/agent/ratelimit";
import { noStoreHeaders } from "@/lib/api";

/**
 * Standard is a note, a stage change, a saved search. Heavy is a pass over the
 * whole county, a campaign across hundreds of opportunities, a simulation: work
 * that costs the deployment real time and writes many documents at once.
 */
export type MutationCost = "standard" | "heavy";

export interface MutationDenial {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface MutationGuardOptions {
  cost?: MutationCost;
  /**
   * Shared secrets that identify a trusted non-browser caller. The matcher
   * endpoint passes MATCHER_TOKEN here so a scheduler holding it is not asked
   * to look like a browser.
   */
  secrets?: readonly (string | undefined | null)[];
  /** Injected in tests. */
  env?: NodeJS.ProcessEnv;
  limiter?: RateLimiter;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A reviewer working through the app clicks a handful of times a minute: track
 * a parcel, move a stage, add a note. A hundred and twenty in ten minutes is
 * far more than that and far less than a script wants. Both numbers are
 * overridable so a deployment that attracts attention can be tightened without
 * a code change.
 */
export const MUTATION_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.CRM_WRITE_RATE_LIMIT, 120),
  windowMs: readPositiveInt(process.env.CRM_WRITE_RATE_WINDOW_MS, 10 * 60 * 1000),
});

/** A matcher pass, an outreach campaign, a simulation. Seconds of work each. */
export const HEAVY_MUTATION_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.CRM_HEAVY_WRITE_RATE_LIMIT, 20),
  windowMs: readPositiveInt(process.env.CRM_HEAVY_WRITE_RATE_WINDOW_MS, 10 * 60 * 1000),
});

function truthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Constant time enough for a shared secret of this size. */
function secretMatches(expected: string, provided: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

/** Every place a caller is allowed to put a shared secret. */
function presentedSecrets(request: Request): string[] {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return [
    bearer,
    (request.headers.get("x-crm-write-token") ?? "").trim(),
    (request.headers.get("x-matcher-token") ?? "").trim(),
  ].filter(Boolean);
}

function presentsAnySecret(request: Request, expected: readonly (string | undefined | null)[]) {
  const wanted = expected.map((value) => value?.trim() ?? "").filter(Boolean);
  if (!wanted.length) return false;
  const provided = presentedSecrets(request);
  return wanted.some((secret) => provided.some((value) => secretMatches(secret, value)));
}

/**
 * The host this request was actually addressed to.
 *
 * Header first, because behind Vercel's proxy the URL a function sees is not
 * always the URL the browser typed; the URL is the fallback so this is testable
 * with a plain `new Request(...)`.
 */
function requestHost(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.toLowerCase();
  const host = request.headers.get("host")?.trim();
  if (host) return host.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether this request came from a page served by this deployment.
 *
 * Hosts are compared, not full origins: behind a TLS terminating proxy the
 * function is reached over http while the browser is on https, so comparing
 * schemes would reject every real request.
 */
export function sameOriginRequest(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  // Set by every current browser, and not settable by page script. `none` is a
  // user typing the URL, `same-origin` and `same-site` are our own pages.
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site") return false;

  const origin = request.headers.get("origin")?.trim();
  // A browser always sends Origin on a state changing fetch. Its absence means
  // the caller is not a browser, which is exactly the drive-by case.
  if (!origin || origin === "null") return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const allowed = (env.CRM_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry.includes("://") ? entry : `https://${entry}`).host.toLowerCase();
      } catch {
        return entry.toLowerCase();
      }
    });
  if (allowed.includes(originHost)) return true;

  const host = requestHost(request);
  return Boolean(host) && originHost === host;
}

/**
 * The decision, without a Response attached, so the reasoning can be tested
 * without a Next runtime. `null` means the mutation may proceed.
 */
export function checkMutation(
  request: Request,
  options: MutationGuardOptions = {},
): MutationDenial | null {
  const env = options.env ?? process.env;

  if (truthy(env.CRM_READ_ONLY)) {
    return {
      status: 503,
      code: "writes_disabled",
      message:
        "This deployment is running read only: CRM_READ_ONLY is set, so nothing can be changed through the API.",
    };
  }

  const writeToken = env.CRM_WRITE_TOKEN?.trim() || null;
  if (presentsAnySecret(request, [writeToken, ...(options.secrets ?? [])])) {
    // A caller holding a secret this deployment configured is the deployment's
    // own automation. It is not a browser and is not asked to look like one.
    return null;
  }
  if (writeToken) {
    return {
      status: 401,
      code: "unauthorised",
      message: "This deployment requires a write token for anything that changes CRM state.",
    };
  }

  if (!sameOriginRequest(request, env)) {
    return {
      status: 403,
      code: "cross_origin_write",
      message:
        "Changes have to come from this application's own pages. This request carried no matching Origin.",
    };
  }

  const limiter =
    options.limiter ?? (options.cost === "heavy" ? HEAVY_MUTATION_RATE_LIMIT : MUTATION_RATE_LIMIT);
  const decision = limiter.check(clientAddress(request.headers));
  if (!decision.allowed) {
    return {
      status: 429,
      code: "rate_limited",
      message: `Rate limit reached: ${decision.limit} changes per window from one address on this public deployment. Try again in ${decision.retryAfterSeconds}s.`,
      retryAfterSeconds: decision.retryAfterSeconds,
    };
  }

  return null;
}

/** The same decision as a response, or `null` to carry on. */
export function guardMutation(
  request: Request,
  options: MutationGuardOptions = {},
): NextResponse | null {
  const denial = checkMutation(request, options);
  if (!denial) return null;
  // A 429 that a cache is allowed to replay would keep refusing a caller whose
  // window has already reset, so the denials carry the directive too.
  return NextResponse.json(
    { error: denial.message, code: denial.code },
    {
      status: denial.status,
      headers: noStoreHeaders(
        denial.retryAfterSeconds ? { "retry-after": String(denial.retryAfterSeconds) } : undefined,
      ),
    },
  );
}

/**
 * Whether a path segment is one the LLM proxy may forward.
 *
 * Validated rather than escaped, because Google's path is
 * `models/gemini-3.5-flash:generateContent` and percent-encoding that colon
 * makes it a 404 upstream. The charset admits every path any provider in the
 * registry uses.
 *
 * `.` and `..` are rejected outright rather than left to the charset. They pass
 * it - both are made only of characters the charset allows - and a `..` segment
 * is resolved away by the URL parser inside fetch, so a request to
 * `/api/llm/google/v1beta/../<something else>` would reach an upstream path
 * this route never checked, and with it a model the allowlist never approved.
 * That is the whole point of the allowlist: this deployment's key is not
 * supposed to be pointable at the most expensive thing the vendor sells.
 */
const PROXY_SEGMENT = /^[A-Za-z0-9._:-]+$/;

export function isSafeProxySegment(segment: string): boolean {
  if (segment === "." || segment === "..") return false;
  return PROXY_SEGMENT.test(segment);
}

export function isSafeProxyPath(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.every(isSafeProxySegment);
}
