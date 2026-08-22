/**
 * An upstream error body must not carry this deployment's key to a visitor.
 *
 * `/api/llm/<provider>` forwards a model call with the server's own key
 * attached, and used to hand back `response.body` verbatim for every status.
 * lib/agent/redact.ts names this exact hazard in its opening comment: providers
 * echo the offending credential in the message of a 401. The runtime is public,
 * the key is the deployment owner's, and making the upstream refuse needs
 * nothing more exotic than an expired key - so the error path was a way for any
 * visitor to read it.
 *
 * The success path is the other half of the fix and matters just as much: a
 * tool-calling turn is long, and buffering it would delay the first token by
 * tens of seconds. Only errors are buffered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/llm/[provider]/[...path]/route";
import { PROVIDERS } from "@/lib/agent/providers";

/** A key with a real vendor prefix, so the shaped pass has something to catch. */
const SERVER_KEY = "sk-ant-api03-THISISTHEDEPLOYMENTSOWNKEY0123456789";

const MODEL = PROVIDERS.find((provider) => provider.id === "anthropic")?.models[0]?.id ?? "";

const params = (path: string[]) => ({ params: Promise.resolve({ provider: "anthropic", path }) });

function modelRequest(): Request {
  return new Request("https://crm.example.com/api/llm/anthropic/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://crm.example.com",
      host: "crm.example.com",
      "sec-fetch-site": "same-origin",
      // A distinct address per test file, so this suite cannot exhaust the
      // shared in-process budget for another one.
      "x-forwarded-for": "198.51.100.77",
    },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }] }),
  });
}

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SERVER_KEY;
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
  vi.unstubAllGlobals();
});

describe("an upstream error", () => {
  it("does not carry the key it just refused", async () => {
    // Anthropic's own 401 shape, quoting the credential back.
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: `invalid x-api-key: ${SERVER_KEY}`,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 })),
    );

    const response = await POST(modelRequest(), params(["messages"]));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain(SERVER_KEY);
    // Not merely absent: visibly removed, so a reader can see it was there.
    expect(text).toContain("[redacted]");
    // And still useful. A visitor told only "401" cannot tell a dead key from a
    // broken deployment.
    expect(text).toContain("authentication_error");
  });

  it("redacts a credential the provider quotes that is not ours", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("your key AIzaSyA0000000000000000000000000000000 is not valid", {
            status: 403,
          }),
      ),
    );

    const response = await POST(modelRequest(), params(["messages"]));
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(text).not.toContain("AIzaSyA0000000000000000000000000000000");
  });

  it("answers with the status even when the body is unreadable", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 502 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => broken),
    );

    const response = await POST(modelRequest(), params(["messages"]));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("502");
    expect(text).not.toContain(SERVER_KEY);
  });
});

describe("a successful turn", () => {
  it("is still streamed rather than buffered", async () => {
    // Never closed. A route that buffered the success path would hang here, and
    // that is the point: the first token has to leave before the turn ends.
    // Held in an object so control flow narrowing cannot decide the assignment
    // inside `start` never happens.
    const writer: { enqueue: ((chunk: string) => void) | null } = { enqueue: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        writer.enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const response = await Promise.race([
      POST(modelRequest(), params(["messages"])),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the proxy buffered a 200")), 2_000),
      ),
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.body).not.toBeNull();

    // The body is live: a chunk written after the response was returned is
    // readable through it, which a buffered response could not do.
    expect(writer.enqueue).not.toBeNull();
    writer.enqueue?.('data: {"type":"message_start"}\n\n');
    const first = await response.body?.getReader().read();
    expect(new TextDecoder().decode(first?.value)).toContain("message_start");
  });
});
