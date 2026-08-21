/**
 * Saved criteria.
 *
 * The thing this page has to make obvious is that a saved search is not a
 * bookmark: it is standing instruction to the matcher. So every row shows when
 * it was last evaluated, against which pipeline run, and how many parcels
 * matched then - and the buttons that matter are "check now" and "simulate an
 * update", which is the whole notification loop in two clicks.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Empty, Panel, Spinner, Toggle, ago, count } from "@/components/ui";
import { ApiError, api, del, patch, post, type SavedSearch } from "@/lib/client";
import type { MatcherResult } from "@/lib/notify/matcher";

interface SimulationResponse {
  simulation: {
    runId: string;
    kind: string;
    changes: { propertyId: string; addressLine: string; label: string; detail: string }[];
  };
  matcher: MatcherResult | null;
}

export default function SavedSearchesPage() {
  const [searches, setSearches] = useState<SavedSearch[] | null>(null);
  const [storeMissing, setStoreMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; text: string; tone: "good" | "bad" } | null>(
    null,
  );

  const load = useCallback(() => {
    api<{ searches: SavedSearch[] }>("/api/searches")
      .then((body) => {
        setSearches(body.searches);
        setStoreMissing(false);
      })
      .catch((cause: ApiError) => {
        setSearches([]);
        setStoreMissing(cause.isStoreMissing);
      });
  }, []);

  useEffect(load, [load]);

  const runNow = async (search: SavedSearch) => {
    setBusy(search.id);
    setOutcome(null);
    try {
      const result = await post<MatcherResult>(`/api/searches/${search.id}/run`, {});
      const own = result.outcomes[0];
      setOutcome({
        id: search.id,
        tone: "good",
        text: own?.seeded
          ? `Baseline recorded: ${count(own.matched)} parcels match now. You will be told when that set changes.`
          : `${count(result.alertsCreated)} alerts raised from ${count(own?.matched ?? 0)} matches${
              result.alertsSuppressed ? `, ${count(result.alertsSuppressed)} suppressed by the cap` : ""
            }.`,
      });
      load();
    } catch (cause: unknown) {
      setOutcome({
        id: search.id,
        tone: "bad",
        text: cause instanceof Error ? cause.message : "The pass failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const simulate = async (search: SavedSearch, kind: "court_filing" | "roll_movement") => {
    setBusy(search.id);
    setOutcome(null);
    try {
      const result = await post<SimulationResponse>("/api/simulate", {
        savedSearchId: search.id,
        kind,
        count: 3,
        runMatcher: true,
      });
      setOutcome({
        id: search.id,
        tone: "good",
        text: `Pipeline run ${result.simulation.runId} changed ${count(result.simulation.changes.length)} parcels (${result.simulation.changes.map((change) => change.label).join(", ")}). The matcher raised ${count(result.matcher?.alertsCreated ?? 0)} alerts.`,
      });
      load();
    } catch (cause: unknown) {
      setOutcome({
        id: search.id,
        tone: "bad",
        text: cause instanceof Error ? cause.message : "The simulation failed.",
      });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (search: SavedSearch, patchBody: Partial<SavedSearch>) => {
    await patch(`/api/searches/${search.id}`, patchBody).catch(() => undefined);
    load();
  };

  const remove = async (search: SavedSearch) => {
    await del(`/api/searches/${search.id}`).catch(() => undefined);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Saved criteria</h1>
          <p className="text-xs text-ink-500">
            Each of these is evaluated against every pipeline refresh. New and changed matches become
            alerts.
          </p>
        </div>
        <Link href="/search">
          <Button variant="primary">New search</Button>
        </Link>
      </div>

      {storeMissing && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          No CRM store is attached, so criteria cannot be saved. Set DATABASE_URL and run
          <span className="mono"> pnpm db:migrate</span>. Ad hoc search still works.
        </div>
      )}

      {searches === null ? (
        <Spinner label="Reading saved criteria" />
      ) : searches.length === 0 && !storeMissing ? (
        <Empty title="Nothing saved yet">
          Build a set of criteria on the search page and save it. The first pass records what already
          matches as a baseline; after that you are told about changes.
        </Empty>
      ) : (
        <div className="space-y-3">
          {searches.map((search) => (
            <Panel
              key={search.id}
              title={
                <span className="flex items-center gap-2">
                  {search.name}
                  {!search.active && <Badge tone="neutral">paused</Badge>}
                  {search.lastEvaluatedAt === null && <Badge tone="warn">never evaluated</Badge>}
                </span>
              }
              subtitle={search.description ?? undefined}
              actions={
                <>
                  <Link href={`/search?saved=${search.id}`}>
                    <Button size="sm">Open</Button>
                  </Link>
                  <Link href={`/alerts?savedSearchId=${search.id}`}>
                    <Button size="sm" variant="ghost">
                      Alerts
                    </Button>
                  </Link>
                </>
              }
            >
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
                <div className="space-y-2.5">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
                    <Row label="Matched last pass" value={count(search.lastMatchCount ?? 0)} />
                    <Row label="Last evaluated" value={ago(search.lastEvaluatedAt)} />
                    <Row
                      label="Against run"
                      value={search.lastPipelineRunId ?? "none yet"}
                      mono
                    />
                  </dl>

                  <div className="flex flex-wrap gap-3">
                    <Toggle
                      checked={search.notifyInApp}
                      onChange={(checked) => void toggle(search, { notifyInApp: checked })}
                      label="In app"
                    />
                    <Toggle
                      checked={search.notifyEmail}
                      onChange={(checked) => void toggle(search, { notifyEmail: checked })}
                      label="Mocked email"
                    />
                    <Toggle
                      checked={search.notifySms}
                      onChange={(checked) => void toggle(search, { notifySms: checked })}
                      label="Mocked SMS"
                    />
                    <Toggle
                      checked={search.active}
                      onChange={(checked) => void toggle(search, { active: checked })}
                      label="Watched by the matcher"
                    />
                  </div>

                  {outcome?.id === search.id && (
                    <p
                      className={
                        outcome.tone === "good"
                          ? "rounded-md border border-good-500/40 bg-good-500/10 px-3 py-2 text-[11px] text-good-500"
                          : "rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-[11px] text-bad-500"
                      }
                    >
                      {outcome.text}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    className="w-full"
                    disabled={busy === search.id}
                    onClick={() => void runNow(search)}
                  >
                    {busy === search.id ? "Running" : "Check for matches now"}
                  </Button>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={busy === search.id}
                    onClick={() => void simulate(search, "court_filing")}
                    title="Records real court filings against parcels that fit everything else, then runs the matcher."
                  >
                    Simulate: new court filings
                  </Button>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={busy === search.id}
                    onClick={() => void simulate(search, "roll_movement")}
                    title="Moves values on parcels that already match - a reassessment, a roof permit, an owner change - then runs the matcher."
                  >
                    Simulate: roll movement
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full"
                    onClick={() => void remove(search)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-ink-500">{label}</dt>
      <dd className={`truncate text-ink-200 ${mono ? "mono" : "tabular"}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
