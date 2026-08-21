"use client";

/**
 * Build a provider client that talks to this deployment instead of the vendor.
 *
 * Same SDK, same wire protocol, one substitution: the base URL points at
 * `/api/llm/<provider>`, which forwards the request upstream with this
 * deployment's key attached. The loop keeps running in the tab, where the tools
 * and the parcel data are, and the key stays on the server.
 *
 * The `apiKey` below is a placeholder rather than a secret. Every provider
 * package refuses to construct without one, and the proxy strips the
 * authorization headers off the incoming request and sets its own, so whatever
 * is written here never reaches a vendor. It is spelled out so nobody later
 * mistakes it for something that was supposed to be filled in.
 *
 * Two things fall out of routing through our own origin, both worth having:
 * providers that refuse browser origins outright now work, and Anthropic no
 * longer needs the dangerous-direct-browser-access opt-in, because from its
 * point of view the caller is a server.
 *
 * Bedrock is absent on purpose. It signs the whole request with SigV4 rather
 * than carrying a header token, so forwarding bytes cannot authenticate it, and
 * this deployment offers only what it can forward.
 */

import type { LanguageModel } from "ai";

import type { AgentProvider } from "@/lib/agent/providers";

const PLACEHOLDER = "proxied-by-this-deployment";

function proxyUrl(provider: AgentProvider): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/api/llm/${provider}`;
}

export function isProxyable(provider: AgentProvider): boolean {
  return provider !== "bedrock";
}

export async function createProxiedModel(
  provider: AgentProvider,
  modelId: string,
): Promise<LanguageModel> {
  const baseURL = proxyUrl(provider);

  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      return createCerebras({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "vercel-ai-gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      return createGateway({ apiKey: PLACEHOLDER, baseURL })(modelId);
    }
    case "openrouter":
    case "huggingface": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({ name: provider, baseURL, apiKey: PLACEHOLDER })(modelId);
    }
    default:
      throw new Error(`${provider} cannot be proxied by this deployment, so it is not offered.`);
  }
}
