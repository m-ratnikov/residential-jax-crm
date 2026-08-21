/**
 * Shared plumbing for the API routes.
 *
 * Routes should read as "parse the request, call one function, return it".
 * Everything that would otherwise be repeated at the top and bottom of each
 * handler - typed errors to status codes, zod issues to a readable message,
 * the store-not-configured case - lives here.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { CrmStoreNotWritableError } from "@/lib/crm/db";
import { logError } from "@/lib/notify/log";

export interface ApiErrorBody {
  error: string;
  code: string;
  detail?: unknown;
}

export function ok<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, init);
}

export function fail(
  code: string,
  message: string,
  status: number,
  detail?: unknown,
): NextResponse {
  const body: ApiErrorBody = { error: message, code };
  if (detail !== undefined) body.detail = detail;
  return NextResponse.json(body, { status });
}

/**
 * One place that decides what an exception means to a caller.
 *
 * A store attached read only is 503 with a code the UI recognises, because it
 * is a deployment state rather than a bug, and the affected pages render an
 * explanation instead of an error.
 */
export function handleError(route: string, error: unknown): NextResponse {
  if (error instanceof CrmStoreNotWritableError) {
    return fail(error.code, error.message, 503);
  }
  if (error instanceof ZodError) {
    return fail("invalid_request", "The request body did not validate.", 400, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  logError("api.unhandled", error, { route });
  return fail(
    "internal_error",
    error instanceof Error ? error.message : "Something went wrong.",
    500,
  );
}

/**
 * Parse a JSON body, treating an absent one as `{}` and inflating a gzipped one.
 *
 * The browser compresses a large post (see `postLarge` in lib/client.ts): the
 * matcher sends every match it evaluated, which measured 2.75 MB for one saved
 * search against the real artifact, and the platform refuses a body over
 * 4.5 MB. Runtimes do not transparently inflate a request the way they do a
 * response, so the one place that receives one does it here.
 */
export async function readJson(request: Request): Promise<unknown> {
  const encoding = request.headers.get("content-encoding")?.toLowerCase() ?? "";

  let text: string;
  if (encoding.includes("gzip")) {
    const { gunzipSync } = await import("node:zlib");
    const raw = Buffer.from(await request.arrayBuffer());
    try {
      text = gunzipSync(raw).toString("utf8");
    } catch {
      throw new SyntaxError("The request body announced gzip but could not be decompressed.");
    }
  } else {
    text = await request.text();
  }

  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError("The request body was not valid JSON.");
  }
}

/**
 * The matcher endpoint is called by a scheduler, not by a browser, so it is
 * guarded by a shared secret rather than a session. With no secret configured
 * the endpoint is open, which is correct for a public demo and stated in the
 * README rather than left as a surprise.
 */
export function matcherTokenValid(request: Request): boolean {
  const expected = process.env.MATCHER_TOKEN?.trim();
  if (!expected) return true;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || (request.headers.get("x-matcher-token") ?? "").trim();
  if (provided.length !== expected.length) return false;
  // Constant time enough for a shared secret of this size.
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

export function searchParamNumber(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function searchParamList(url: URL, key: string): string[] | undefined {
  const raw = url.searchParams.getAll(key).flatMap((value) => value.split(","));
  const cleaned = raw.map((value) => value.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}
