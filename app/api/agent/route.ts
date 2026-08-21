/**
 * Capability probe for the settings page, the chat page and for curl.
 *
 * There is no POST here any more. The agent's tools have to reach the parcel
 * data, and the parcel data is read by DuckDB-WASM in the visitor's tab, so the
 * tool loop runs there (lib/agent/client-run.ts). The visitor's key was already
 * held in the browser and never sent to this server, so nothing about the
 * credential changed when the loop moved.
 *
 * What this still answers is "what would run, and what does this build
 * support": the full provider registry with each provider's free-tier terms and
 * the URL and date they were read, and whether a server-side key exists. It
 * reports the NAME of the environment variable that supplies a server key and
 * never its value.
 */

import { NextResponse } from "next/server";

import { serverSelection } from "@/lib/agent/model";
import {
  KEY_HEADER,
  MODEL_HEADER,
  PROVIDER_HEADER,
  readUserCredential,
} from "@/lib/agent/credentials";
import { AgentBadRequestError } from "@/lib/agent/errors";
import { PROVIDERS } from "@/lib/agent/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const server = serverSelection();

  let active: { provider: string; model: string; source: "user" | "server" } | null = server
    ? { provider: server.provider, model: server.modelId, source: "server" }
    : null;
  let headerError: string | null = null;

  try {
    const credential = readUserCredential(request.headers);
    if (credential) {
      active = { provider: credential.provider, model: credential.modelId, source: "user" };
    }
  } catch (error: unknown) {
    headerError =
      error instanceof AgentBadRequestError ? error.message : "credential headers rejected";
  }

  return NextResponse.json({
    configured: Boolean(server),
    active,
    server_default: server
      ? { provider: server.provider, model: server.modelId, env_key: server.envKey }
      : null,
    runs_in: "browser",
    bring_your_own_key: {
      headers: { key: KEY_HEADER, provider: PROVIDER_HEADER, model: MODEL_HEADER },
      settings_url: "/settings",
      test_url: "/api/agent/test",
      storage: "browser localStorage only; the server keeps no copy",
    },
    header_error: headerError,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      free_tier: provider.freeTier,
      key_url: provider.keyUrl,
      accepts_user_key: provider.acceptsUserKey,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        free: model.free,
      })),
    })),
  });
}
