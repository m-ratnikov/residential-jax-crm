/**
 * What this deployment can answer with.
 *
 * There is no POST here. The agent's tools have to reach the parcel data, and
 * the parcel data is read by DuckDB-WASM in the visitor's tab, so the tool loop
 * runs there (lib/agent/client-run.ts). The model call it makes is forwarded by
 * /api/llm/<provider>, which is where this deployment's key is attached.
 *
 * So this route publishes one thing: the provider and model pairs the server
 * holds a key for, in the order the Ask page should offer them. Ids and labels
 * only - never the key, and never the name of the variable holding it.
 *
 * There is no per-visitor credential any more. A CRM that asks the person
 * evaluating it to go and mint an API key before it will answer a question has
 * failed at the question, so the deployment answers on its own key or says
 * plainly that it has none.
 */

import { NextResponse } from "next/server";

import { PROVIDERS } from "@/lib/agent/providers";
import { serverModels } from "@/lib/agent/server-models";
import { noStoreHeaders } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const available = serverModels();
  const first = available[0] ?? null;

  return NextResponse.json(
    {
      configured: available.length > 0,
      /** The pair that answers when the visitor does not choose. */
      active: first ? { provider: first.provider, model: first.modelId, source: "server" } : null,
      server_models: available.map((model) => ({
        provider: model.provider,
        provider_label: model.providerLabel,
        id: model.modelId,
        label: model.label,
        free: model.free,
        notes: model.notes,
      })),
      /** Where the loop sends a model call. */
      proxy_url: "/api/llm",
      runs_in: "browser",
      /**
       * The full registry, so a clone can see what this build supports before
       * configuring anything. Free-tier terms carry the URL and the date they
       * were read, because those numbers move monthly.
       */
      providers: PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        free_tier: provider.freeTier,
        models: provider.models.map((model) => ({
          id: model.id,
          label: model.label,
          free: model.free,
        })),
      })),
    },
    { headers: noStoreHeaders() },
  );
}
