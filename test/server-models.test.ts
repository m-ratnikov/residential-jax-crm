/**
 * Which models this deployment will spend its own key on.
 *
 * Worth testing rather than eyeballing, because both failure directions are
 * expensive and neither throws. Offering a model the proxy would refuse gives a
 * visitor a dropdown entry that 400s. Accepting a model the registry does not
 * list lets a hand-written request point the deployment's key at the most
 * expensive thing the vendor sells.
 */

import { describe, expect, it } from "vitest";

import { isServerModel, serverKeyFor, serverModels, upstreamFor } from "@/lib/agent/server-models";
import { PROVIDERS } from "@/lib/agent/providers";

/** A fixture environment. NODE_ENV is required on ProcessEnv and irrelevant here. */
const makeEnv = (values: Record<string, string>): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...values }) as NodeJS.ProcessEnv;

const OPENAI = makeEnv({ OPENAI_API_KEY: "sk-test" });

describe("serverModels", () => {
  it("offers nothing when no key is configured", () => {
    expect(serverModels(makeEnv({}))).toEqual([]);
  });

  it("offers exactly the registry's models for a configured provider", () => {
    const offered = serverModels(OPENAI);
    const registry = PROVIDERS.find((provider) => provider.id === "openai");

    expect(offered.length).toBe(registry?.models.length);
    expect(offered.every((model) => model.provider === "openai")).toBe(true);
    expect(offered.map((model) => model.modelId)).toEqual(
      registry?.models.map((model) => model.id),
    );
  });

  it("does not offer a provider whose key is absent", () => {
    const offered = serverModels(OPENAI);
    expect(offered.some((model) => model.provider === "anthropic")).toBe(false);
  });

  it("leads with the provider and model the deployment names", () => {
    const fixture = makeEnv({
      OPENAI_API_KEY: "sk-test",
      GOOGLE_GENERATIVE_AI_API_KEY: "AIza-test",
      AGENT_PROVIDER: "google",
      AGENT_MODEL: "gemini-2.5-pro",
    });

    const offered = serverModels(fixture);
    // The named model leads, because that is the one a reviewer should land on.
    expect(offered[0]?.provider).toBe("google");
    expect(offered[0]?.modelId).toBe("gemini-2.5-pro");
    // And the rest of that provider still comes before the other one.
    expect(offered[1]?.provider).toBe("google");
    expect(offered.some((model) => model.provider === "openai")).toBe(true);
  });

  it("ignores a named provider that has no key, rather than offering it empty", () => {
    const fixture = makeEnv({ OPENAI_API_KEY: "sk-test", AGENT_PROVIDER: "anthropic" });
    // Naming anthropic without a key must not silence openai, and must not
    // conjure anthropic models the proxy would refuse.
    expect(serverModels(fixture).every((model) => model.provider === "openai")).toBe(true);
  });
});

describe("isServerModel", () => {
  it("accepts a listed model on a configured provider", () => {
    expect(isServerModel("openai", "gpt-5-mini", OPENAI)).toBe(true);
  });

  it("refuses a model that is not in the registry", () => {
    expect(isServerModel("openai", "o3-pro", OPENAI)).toBe(false);
  });

  it("refuses a provider with no key here, however real the model is", () => {
    expect(isServerModel("anthropic", "claude-opus-5", OPENAI)).toBe(false);
  });
});

describe("the upstream table", () => {
  it("knows where every registry provider sends its traffic, except Bedrock", () => {
    for (const provider of PROVIDERS) {
      const upstream = upstreamFor(provider.id);
      if (provider.id === "bedrock") {
        // SigV4 signs the whole request, so forwarding bytes cannot
        // authenticate it. Deliberately absent.
        expect(upstream).toBeNull();
        continue;
      }
      expect(upstream, `${provider.id} has no upstream`).not.toBeNull();
      expect(upstream?.baseUrl).toMatch(/^https:\/\//);
      expect(Object.keys(upstream?.auth("k") ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("presents the key the way each provider expects it", () => {
    expect(upstreamFor("openai")?.auth("k")["authorization"]).toBe("Bearer k");
    expect(upstreamFor("google")?.auth("k")["x-goog-api-key"]).toBe("k");
    expect(upstreamFor("anthropic")?.auth("k")["x-api-key"]).toBe("k");
  });
});

describe("serverKeyFor", () => {
  it("takes the first of a provider's environment variables that is set", () => {
    expect(serverKeyFor("google", makeEnv({ GOOGLE_API_KEY: "second" }))).toBe("second");
    expect(
      serverKeyFor(
        "google",
        makeEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "first", GOOGLE_API_KEY: "second" }),
      ),
    ).toBe("first");
  });

  it("treats whitespace as absent, so a blank variable does not look configured", () => {
    expect(serverKeyFor("openai", makeEnv({ OPENAI_API_KEY: "   " }))).toBeNull();
  });
});
