/**
 * Model settings.
 *
 * This deployment carries no model key on purpose: /api/agent is public and
 * unauthenticated, and a server-side key attached to it is a bill any stranger
 * can run up. So a visitor brings their own. The key is held in their browser
 * and travels in a header with each question; the server keeps no copy.
 *
 * Every free-tier claim on this page comes from the provider registry, which
 * records the URL it was read from and the date it was read, because free tiers
 * move and an undated claim is worth nothing.
 */

"use client";

import { useEffect, useState } from "react";

import { Badge, Button, Field, Panel, Select, TextInput, cx, when } from "@/components/ui";
import {
  PROVIDERS,
  defaultModelFor,
  findProvider,
  FREE_TIER_VERIFIED_ON,
  type AgentProvider,
} from "@/lib/agent/providers";
import { KEY_HEADER, MODEL_HEADER, PROVIDER_HEADER } from "@/lib/agent/credentials";
import {
  clearSettings,
  maskKey,
  useAgentSettings,
  writeSettings,
} from "@/lib/agent/settings-client";

interface AgentStatus {
  configured: boolean;
  active: { provider: string; model: string; source: "user" | "server" } | null;
  server_default: { provider: string; model: string; env_key: string } | null;
}

export default function SettingsPage() {
  const { settings, loaded, refresh } = useAgentSettings();
  const [provider, setProvider] = useState<AgentProvider>("google");
  const [modelId, setModelId] = useState<string>(defaultModelFor("google"));
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!loaded || !settings) return;
    setProvider(settings.provider);
    setModelId(settings.modelId);
  }, [loaded, settings]);

  useEffect(() => {
    fetch("/api/agent")
      .then((response) => (response.ok || response.status === 501 ? response.json() : null))
      .then((body: AgentStatus | null) => setStatus(body))
      .catch(() => undefined);
  }, [settings]);

  const definition = findProvider(provider);

  const save = () => {
    const stored = writeSettings({ provider, modelId, apiKey: apiKey.trim() });
    if (stored) {
      setApiKey("");
      refresh();
      setResult({ ok: true, text: "Saved to this browser. Nothing was sent to the server." });
    } else {
      setResult({ ok: false, text: "Could not save. Check the provider, model and key." });
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch("/api/agent/test", {
        method: "POST",
        headers: {
          [KEY_HEADER]: apiKey.trim() || settings?.apiKey || "",
          [PROVIDER_HEADER]: provider,
          [MODEL_HEADER]: modelId,
        },
      });
      const body = (await response.json()) as { ok?: boolean; error?: string; message?: string };
      setResult({
        ok: response.ok && body.ok !== false,
        text:
          response.ok && body.ok !== false
            ? `The provider accepted the credential for ${provider}:${modelId}.`
            : (body.error ?? body.message ?? "The provider rejected the credential."),
      });
    } catch {
      setResult({ ok: false, text: "The test could not reach the server." });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Model settings</h1>
        <p className="text-xs text-ink-500">
          Only the Ask page needs a model. The map, search, saved criteria, alerts and the whole CRM
          work without one.
        </p>
      </div>

      <Panel title="What is answering now">
        {!status ? (
          <p className="text-xs text-ink-500">Checking</p>
        ) : status.active ? (
          <p className="text-xs text-ink-300">
            <span className="mono">
              {status.active.provider}:{status.active.model}
            </span>{" "}
            using{" "}
            {status.active.source === "user"
              ? "the key stored in this browser"
              : "this deployment's own key"}
            .
          </p>
        ) : (
          <p className="text-xs text-warn-500">
            No model is configured. This deployment sets no key of its own, because a public
            unauthenticated agent endpoint with a server-side key attached is a bill any stranger
            can run up. Add your own below.
          </p>
        )}
        {settings && (
          <p className="mt-1.5 text-[11px] text-ink-500">
            Stored in this browser: <span className="mono">{maskKey(settings.apiKey)}</span>, saved{" "}
            {when(settings.savedAt)}.{" "}
            <button
              type="button"
              onClick={() => {
                clearSettings();
                refresh();
                setResult({ ok: true, text: "Removed from this browser." });
              }}
              className="text-accent-400 hover:underline"
            >
              Remove
            </button>
          </p>
        )}
      </Panel>

      <Panel
        title="Bring your own key"
        subtitle={`Free-tier terms below were read from each provider's own page on ${FREE_TIER_VERIFIED_ON}.`}
      >
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Provider">
              <Select
                value={provider}
                onChange={(value) => {
                  setProvider(value);
                  setModelId(defaultModelFor(value));
                }}
                options={PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
            </Field>
            <Field label="Model">
              <Select
                value={modelId}
                onChange={setModelId}
                options={(definition?.models ?? []).map((model) => ({
                  value: model.id,
                  label: `${model.label}${model.free ? " (free tier)" : ""}`,
                }))}
              />
            </Field>
          </div>

          {definition && (
            <div className="rounded-md border border-[var(--line)] bg-[var(--panel-raised)] px-3 py-2.5 text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={definition.freeTier.available ? "good" : "warn"}>
                  {definition.freeTier.available ? "free tier, no card" : "paid"}
                </Badge>
                <a
                  href={definition.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-400 hover:underline"
                >
                  Get a key
                </a>
                <a
                  href={definition.freeTier.source}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-500 hover:underline"
                >
                  source, read {definition.freeTier.readOn}
                </a>
              </div>
              <p className="mt-1.5 text-ink-400">{definition.freeTier.summary}</p>
              {(() => {
                const model = definition.models.find((entry) => entry.id === modelId);
                return model?.notes ? <p className="mt-1 text-ink-500">{model.notes}</p> : null;
              })()}
            </div>
          )}

          <Field
            label="API key"
            hint={definition?.keyHint ?? "Stored in this browser only. The server keeps no copy."}
          >
            <TextInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={settings ? "leave blank to keep the stored key" : "paste your key"}
            />
          </Field>

          {result && (
            <p
              className={cx(
                "rounded-md border px-3 py-2 text-[11px]",
                result.ok
                  ? "border-good-500/40 bg-good-500/10 text-good-500"
                  : "border-bad-500/40 bg-bad-500/10 text-bad-500",
              )}
            >
              {result.text}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={!apiKey.trim() && !settings}>
              Save to this browser
            </Button>
            <Button onClick={test} disabled={testing || (!apiKey.trim() && !settings)}>
              {testing ? "Testing" : "Test the credential"}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="How the key travels">
        <p className="text-[11px] leading-relaxed text-ink-400">
          The key is written to this browser&apos;s local storage and sent with each question in the{" "}
          <span className="mono">{KEY_HEADER}</span> header, alongside{" "}
          <span className="mono">{PROVIDER_HEADER}</span> and{" "}
          <span className="mono">{MODEL_HEADER}</span>. It exists on the server for the duration of
          one request: it is not stored, not cached, not written to a cookie and not logged. Every
          message on that path is redacted before it can reach a log line, because several providers
          quote the offending credential back in the body of a 401.
        </p>
      </Panel>
    </div>
  );
}
