/**
 * The models this deployment can answer with, using its own keys.
 *
 * The agent's tool loop runs in the visitor's tab, because the tools query the
 * parcel data and the parcel data is read by DuckDB-WASM there. A key held on
 * the server therefore cannot be handed to the loop - so the loop calls the
 * provider through `/api/llm/<provider>`, which is this deployment forwarding
 * the request upstream with the key attached. The key stays on the server, the
 * tools stay in the tab, and neither has to move.
 *
 * What is published to the browser is only ever the provider id, the model ids
 * and their labels. Never a key, and never the name of the variable holding one
 * beyond what the settings page already reports.
 *
 * A visitor can still bring their own key on the settings page. That path is
 * unchanged and takes precedence: their key, their bill, their choice of model.
 */

import { PROVIDERS, type AgentProvider, type ProviderDefinition } from "@/lib/agent/providers";

export interface UpstreamProvider {
  /** Where the provider's API actually lives. */
  baseUrl: string;
  /** How the key is presented, since not everyone uses a bearer token. */
  auth: (key: string) => Record<string, string>;
}

/**
 * Where each provider's traffic goes and how it authenticates.
 *
 * Bedrock is deliberately absent: it signs requests with SigV4 over the whole
 * body rather than carrying a header token, so it cannot be proxied by
 * forwarding bytes and would need the AWS signer on this path. Anyone wanting
 * Bedrock supplies their own credential on the settings page, where the SDK
 * signs it in the tab.
 */
const UPSTREAM: Partial<Record<AgentProvider, UpstreamProvider>> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: (key) => ({ "x-goog-api-key": key }),
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  huggingface: {
    baseUrl: "https://router.huggingface.co/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  "vercel-ai-gateway": {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    auth: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    auth: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

export function upstreamFor(provider: string): UpstreamProvider | null {
  return UPSTREAM[provider as AgentProvider] ?? null;
}

/** The server key for a provider, or null when this deployment has none. */
export function serverKeyFor(
  provider: AgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const definition = PROVIDERS.find((entry) => entry.id === provider);
  if (!definition) return null;
  for (const name of definition.envKeys) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export interface ServerModel {
  provider: AgentProvider;
  providerLabel: string;
  modelId: string;
  label: string;
  free: boolean;
  notes: string;
}

function proxyable(definition: ProviderDefinition, env: NodeJS.ProcessEnv): boolean {
  return Boolean(upstreamFor(definition.id)) && Boolean(serverKeyFor(definition.id, env));
}

/**
 * Every model this deployment can run on its own key, in the order the registry
 * declares them.
 *
 * The order matters: within a provider the registry puts the model it wants
 * chosen first, and `AGENT_PROVIDER` names the provider that should lead. What
 * comes out of here is what the Ask page's dropdown shows, top to bottom, and
 * the first entry is what answers if nobody chooses.
 */
export function serverModels(env: NodeJS.ProcessEnv = process.env): ServerModel[] {
  const preferred = env.AGENT_PROVIDER?.trim().toLowerCase();
  const available = PROVIDERS.filter((definition) => proxyable(definition, env));

  const ordered = preferred
    ? [
        ...available.filter((definition) => definition.id === preferred),
        ...available.filter((definition) => definition.id !== preferred),
      ]
    : available;

  const models = ordered.flatMap((definition) =>
    definition.models.map((model) => ({
      provider: definition.id,
      providerLabel: definition.label,
      modelId: model.id,
      label: model.label,
      free: model.free,
      notes: model.notes,
    })),
  );

  // An explicit AGENT_MODEL leads, so a deployment can name the exact model it
  // wants a reviewer to land on rather than relying on registry order.
  const named = env.AGENT_MODEL?.trim();
  if (!named) return models;
  const index = models.findIndex((model) => model.modelId === named);
  if (index <= 0) return models;
  return [models[index]!, ...models.slice(0, index), ...models.slice(index + 1)];
}

/** True when this pair is one the server is willing to spend its key on. */
export function isServerModel(
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return serverModels(env).some(
    (model) => model.provider === provider && model.modelId === modelId,
  );
}
