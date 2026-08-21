/**
 * The dashboard.
 *
 * Ordered by what an acquisitions lead actually opens the app to find out, in
 * order: is the data current, did anything new match overnight, what is in the
 * pipeline, what is due. Everything here links to the surface where it can be
 * acted on; nothing here is a number without a way through to the thing behind
 * it.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Button, Empty, Panel, ScoreBadge, Spinner, Stat, StageBadge, ago, count, money } from "@/components/ui";
import { api, type AlertRow, type MatcherRunRow, type OpportunityRow } from "@/lib/client";
import { STAGE_LABELS, type AcquisitionStage } from "@/lib/notify/types";

interface DataSourceStatus {
  dataSource: {
    label: string;
    location: string;
    isSample: boolean;
    rowCount: number;
    columnCount: number;
    countyName: string;
    runId: string | null;
    generatedAt: string | null;
  };
  crmStore: { configured: boolean };
  overlay: { courtDataAvailable: boolean; courtProperties: number; simulatedProperties: number };
  pipeline: { runId: string; status: string; startedAt: string; finishedAt: string | null } | null;
}

const STAGE_ORDER: AcquisitionStage[] = [
  "identified",
  "contacted",
  "negotiating",
  "under_contract",
  "closed",
];

export default function DashboardPage() {
  const [status, setStatus] = useState<DataSourceStatus | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [opportunities, setOpportunities] = useState<OpportunityRow[] | null>(null);
  const [passes, setPasses] = useState<MatcherRunRow[] | null>(null);
  const [storeMissing, setStoreMissing] = useState(false);

  useEffect(() => {
    api<DataSourceStatus>("/api/datasource").then(setStatus).catch(() => undefined);

    api<{ alerts: AlertRow[] }>("/api/alerts?limit=8")
      .then((body) => setAlerts(body.alerts))
      .catch(() => {
        setAlerts([]);
        setStoreMissing(true);
      });

    api<{ opportunities: OpportunityRow[] }>("/api/opportunities?limit=500")
      .then((body) => setOpportunities(body.opportunities))
      .catch(() => setOpportunities([]));

    api<{ matcherRuns: MatcherRunRow[] }>("/api/runs?limit=5")
      .then((body) => setPasses(body.matcherRuns))
      .catch(() => setPasses([]));
  }, []);

  const byStage = new Map<AcquisitionStage, OpportunityRow[]>();
  for (const row of opportunities ?? []) {
    const list = byStage.get(row.opportunity.stage) ?? [];
    list.push(row);
    byStage.set(row.opportunity.stage, list);
  }

  const unread = (alerts ?? []).filter((alert) => alert.readAt === null).length;
  const live = (opportunities ?? []).filter(
    (row) => row.opportunity.stage !== "closed" && row.opportunity.stage !== "dead",
  );
  const lastPass = passes?.[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Acquisitions dashboard</h1>
          <p className="text-xs text-ink-500">
            {status
              ? `${status.dataSource.label} - ${count(status.dataSource.rowCount)} parcels over ${status.dataSource.columnCount} published columns`
              : "Reading the data source"}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/search">
            <Button variant="primary">Find properties</Button>
          </Link>
          <Link href="/searches">
            <Button>Saved criteria</Button>
          </Link>
        </div>
      </div>

      {storeMissing && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          <p className="font-medium">No CRM store is attached to this deployment.</p>
          <p className="mt-1 text-warn-500/80">
            The map, search, criteria and the agent all work without one. Saved searches, alerts,
            opportunities and outreach need a Postgres connection: set DATABASE_URL and run
            <span className="mono"> pnpm db:migrate</span>.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Unread alerts"
          value={count(unread)}
          tone={unread > 0 ? "warn" : "default"}
          hint={alerts?.length ? `${count(alerts.length)} recent` : "nothing yet"}
        />
        <Stat
          label="Live opportunities"
          value={count(live.length)}
          hint={`${count((opportunities ?? []).length)} tracked in total`}
        />
        <Stat
          label="Pipeline value"
          value={money(
            live.reduce((sum, row) => sum + (row.opportunity.assessedValue ?? 0), 0),
            "$0",
          )}
          hint="assessed, not offer"
        />
        <Stat
          label="Last matcher pass"
          value={lastPass ? ago(lastPass.startedAt) : "never"}
          tone={lastPass?.error ? "bad" : "default"}
          hint={
            lastPass
              ? `${count(lastPass.alertsCreated)} alerts from ${count(lastPass.searchesEvaluated)} searches`
              : "no pass recorded"
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel
          title="Latest matches"
          subtitle="Raised by your saved criteria against the continuous pipeline."
          actions={
            <Link href="/alerts">
              <Button size="sm" variant="ghost">
                All alerts
              </Button>
            </Link>
          }
        >
          {alerts === null ? (
            <Spinner label="Reading alerts" />
          ) : alerts.length === 0 ? (
            <Empty title="No alerts yet">
              Save a set of criteria, then let the matcher run - or simulate a pipeline update from
              the Pipeline page to see the whole loop in one go.
            </Empty>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {alerts.map((alert) => {
                const snapshot = alert.propertySnapshot as { address?: string };
                return (
                  <li key={alert.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <ScoreBadge score={alert.score} title={alert.rationale} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link
                          href={`/alerts?focus=${alert.id}`}
                          className="truncate text-[13px] font-medium text-ink-100 hover:underline"
                        >
                          {snapshot.address ?? alert.propertyId}
                        </Link>
                        <Badge tone={alert.kind === "new_match" ? "good" : "accent"}>
                          {alert.kind === "new_match" ? "new match" : "changed"}
                        </Badge>
                        {alert.readAt === null && <Badge tone="warn">unread</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-ink-500">
                        {alert.searchName ?? "a saved search"} - {ago(alert.createdAt)}
                        {alert.changedFields.length
                          ? ` - ${alert.changedFields.length} field${alert.changedFields.length === 1 ? "" : "s"} moved`
                          : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Pipeline"
          subtitle="Opportunities by acquisition stage."
          actions={
            <Link href="/opportunities">
              <Button size="sm" variant="ghost">
                Open board
              </Button>
            </Link>
          }
        >
          {opportunities === null ? (
            <Spinner label="Reading opportunities" />
          ) : opportunities.length === 0 ? (
            <Empty title="Nothing in the pipeline">
              Track a parcel from the search page or from an alert and it appears here at the
              Identified stage.
            </Empty>
          ) : (
            <div className="space-y-2">
              {STAGE_ORDER.map((stage) => {
                const list = byStage.get(stage) ?? [];
                const width = opportunities.length
                  ? Math.round((list.length / opportunities.length) * 100)
                  : 0;
                return (
                  <div key={stage}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-ink-400">{STAGE_LABELS[stage]}</span>
                      <span className="tabular text-ink-300">{count(list.length)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--panel-raised)]">
                      <div
                        className="h-full rounded-full bg-accent-500"
                        style={{ width: `${Math.max(width, list.length ? 3 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {(byStage.get("dead")?.length ?? 0) > 0 && (
                <p className="pt-1 text-[11px] text-ink-500">
                  {count(byStage.get("dead")?.length ?? 0)} marked dead.
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Data source"
          subtitle="What this CRM is reading, and how current it is."
          actions={
            <Link href="/pipeline">
              <Button size="sm" variant="ghost">
                Pipeline detail
              </Button>
            </Link>
          }
        >
          {!status ? (
            <Spinner />
          ) : (
            <dl className="space-y-1.5 text-[11px]">
              <Row label="Dataset" value={status.dataSource.label} />
              <Row
                label="Scale"
                value={`${count(status.dataSource.rowCount)} parcels, ${status.dataSource.columnCount} columns`}
              />
              <Row
                label="Kind"
                value={
                  status.dataSource.isSample
                    ? "bundled sample extract"
                    : "published county query table"
                }
              />
              <Row label="Location" value={status.dataSource.location} mono />
              <Row label="Latest pipeline run" value={status.pipeline?.runId ?? "unknown"} mono />
              <Row
                label="Ran"
                value={status.pipeline ? ago(status.pipeline.startedAt) : "no run history"}
              />
              <Row
                label="Court signals"
                value={
                  status.overlay.courtDataAvailable
                    ? `${count(status.overlay.courtProperties)} parcels with filings`
                    : "no court source attached"
                }
              />
              {status.overlay.simulatedProperties > 0 && (
                <Row
                  label="Simulated"
                  value={`${count(status.overlay.simulatedProperties)} parcels carry simulated values`}
                />
              )}
            </dl>
          )}
        </Panel>

        <Panel
          title="Next steps"
          subtitle="Opportunities with something due."
          actions={
            <Link href="/opportunities">
              <Button size="sm" variant="ghost">
                All
              </Button>
            </Link>
          }
        >
          {opportunities === null ? (
            <Spinner />
          ) : (
            (() => {
              const due = live
                .filter((row) => row.opportunity.nextStep)
                .sort((a, b) =>
                  (a.opportunity.nextStepDueAt ?? "9999").localeCompare(
                    b.opportunity.nextStepDueAt ?? "9999",
                  ),
                )
                .slice(0, 6);
              if (!due.length) {
                return <Empty title="Nothing scheduled">Set a next step on an opportunity.</Empty>;
              }
              return (
                <ul className="divide-y divide-[var(--line)]">
                  {due.map((row) => (
                    <li key={row.opportunity.id} className="py-2 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2">
                        <StageBadge stage={row.opportunity.stage} />
                        <Link
                          href={`/opportunities/${row.opportunity.id}`}
                          className="truncate text-[13px] text-ink-100 hover:underline"
                        >
                          {row.opportunity.addressLine}
                        </Link>
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-500">
                        {row.opportunity.nextStep}
                        {row.opportunity.nextStepDueAt
                          ? ` - due ${new Date(row.opportunity.nextStepDueAt).toLocaleDateString("en-US")}`
                          : ""}
                        {row.assignee ? ` - ${row.assignee.name}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              );
            })()
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-ink-500">{label}</dt>
      <dd className={`min-w-0 flex-1 break-words text-ink-200 ${mono ? "mono" : ""}`}>{value}</dd>
    </div>
  );
}
