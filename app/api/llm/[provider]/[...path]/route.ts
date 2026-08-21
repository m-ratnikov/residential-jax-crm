/**
 * The model call, forwarded upstream with this deployment's key attached.
 *
 * The agent's tool loop runs in the visitor's tab, because its tools query the
 * parcel data and that data is read by DuckDB-WASM there. A key held on the
 * server cannot be handed to a loop running in a browser, so the loop points
 * the AI SDK's provider at this route instead: same wire protocol, same request
 * body, one hop through a function that knows the key. The key never reaches
 * the browser and the tools never leave it.
 *
 * WHAT THIS IS NOT. It is not an open proxy. Three things bound it:
 *
 *  1. The provider must be one this build knows and must have a key configured
 *     here. Anything else is 404, so the path cannot be used to reach arbitrary
 *     hosts.
 *  2. The model must be one the registry lists for that provider. Without this,
 *     a hand-written request could point this deployment's key at the most
 *     expensive model the provider sells.
 *  3. Every caller is rate limited by address, using the same limiter the agent
 *     route uses. The limiter is per process and says so - see its own comment
 *     - so this raises the cost of draining the key rather than making it
 *     impossible.
 *
 * The honest residual risk: a public runtime that answers questions on the
 * owner's key can have that key spent by strangers, and no amount of per
 * process counting changes that. The deployment owner decides whether to
 * configure a key at all; with none configured this route 404s and the agent
 * falls back to asking the visitor for their own.
 */

import { NextResponse } from "next/server";

import { PROVIDERS } from "@/lib/agent/providers";
import { isServerModel, serverKeyFor, upstreamFor } from "@/lib/agent/server-models";
import { AGENT_RATE_LIMIT, clientAddress } from "@/lib/agent/ratelimit";
import { logAgent } from "@/lib/agent/log";
import { safeMessage } from "@/lib/agent/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tool-calling turn is many model calls, each of which can take tens of
// seconds on a free tier. This is the Vercel Hobby ceiling with Fluid compute.
export const maxDuration = 300;

/** Headers that are ours to set, or meaningless once the body is re-encoded. */
const STRIPPED = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "origin",
  "referer",
  "accept-encoding",
]);

/**
 * Which model this request is asking for.
 *
 * Two shapes, because the providers differ. OpenAI-compatible APIs put it in
 * the JSON body; Google puts it in the path, as `models/<id>:generateContent`.
 */
function requestedModel(path: string[], body: string): string | null {
  const fromPath = path.join("/").match(/models\/([^:/]+)/);
  if (fromPath?.[1]) return decodeURIComponent(fromPath[1]);
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

function fail(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { message } }, { status });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string; path: string[] }> },
): Promise<Response> {
  const { provider, path } = await context.params;

  const definition = PROVIDERS.find((entry) => entry.id === provider);
  const upstream = upstreamFor(provider);
  if (!definition || !upstream) return fail(404, `Unknown model provider: ${provider}.`);

  const key = serverKeyFor(definition.id);
  if (!key) {
    return fail(
      404,
      `This deployment has no ${definition.label} key. Add your own on the settings page instead.`,
    );
  }

  const limit = AGENT_RATE_LIMIT.check(clientAddress(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: {
          message: `Rate limit reached for this deployment's shared key: ${limit.limit} requests per window. Try again in ${limit.retryAfterSeconds}s, or add your own key on the settings page for an unshared allowance.`,
        },
      },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await request.text();
  const model = requestedModel(path, body);
  if (!model || !isServerModel(provider, model)) {
    return fail(
      400,
      `This deployment does not offer ${model ?? "that model"} on ${definition.label}. Pick one from the list the Ask page publishes.`,
    );
  }

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
  });
  for (const [name, value] of Object.entries(upstream.auth(key))) headers.set(name, value);

  // Validated rather than escaped: Google's path is
  // `models/gemini-3.5-flash:generateContent` and percent-encoding that colon
  // makes it a 404. This charset admits every path any provider in the registry
  // uses and nothing that could climb out of the base URL.
  if (path.some((part) => !/^[A-Za-z0-9._:-]+$/.test(part))) {
    return fail(400, "That is not a path any supported provider uses.");
  }

  const target = `${upstream.baseUrl}/${path.join("/")}${new URL(request.url).search}`;

  const started = Date.now();
  try {
    const response = await fetch(target, { method: "POST", headers, body });

    logAgent("info", "llm.proxied", {
      provider,
      model,
      status: response.status,
      ms: Date.now() - started,
    });

    // Streamed straight back. A tool-calling turn is long enough that buffering
    // it would delay the first token by tens of seconds for no reason.
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error: unknown) {
    logAgent("error", "llm.proxy_failed", { provider, model, reason: safeMessage(error) });
    return fail(502, `The ${definition.label} API could not be reached: ${safeMessage(error)}`);
  }
}
