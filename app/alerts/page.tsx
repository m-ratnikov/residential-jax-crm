/**
 * Notification history.
 *
 * The acceptance criterion is specific: show the history, and for each alert
 * show the pipeline run and the record change that triggered it. So every row
 * carries three things a reader can check - which saved search fired, which
 * pipeline run the evaluation ran against, and exactly which fields moved -
 * plus the per-channel deliveries, including the body of the mocked email that
 * would have gone out.
 */

"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  Badge,
  Button,
  Empty,
  Panel,
  ScoreBadge,
  Spinner,
  ago,
  count,
  money,
  when,
} from "@/components/ui";
import { ApiError, api, patch, post, type AlertRow } from "@/lib/client";
import { humanField } from "@/lib/criteria/score";
import { storeWarning, useServerStatus } from "@/lib/data/status";

/**
 * What the "Held" row says, given what the roll can actually support.
 *
 * The alert used to print the published number alone, so a parcel whose sale
 * date is one of the roll's 1899 placeholders read "Held: 127 years" in a
 * structured field directly above a rationale paragraph saying the tenure was
 * unknown. The number is still shown when it means something, and the verdict
 * decides whether it does.
 */
export function heldValue(
  years: number | null | undefined,
  confidence: string | null | undefined,
): string {
  if (confidence === "NO_RECORDED_SALE") return "no recorded sale";
  if (years === null || years === undefined) return "no recorded sale";
  // PREDATES_STRUCTURE is a real recorded sale that is simply older than the
  // house, and this is the published figure, not the capped one the ranking
  // uses - so it is shown as published and the caveat below says what it means.
  // "at most N years" would be a claim this number does not support.
  return `${years} years`;
}

export default function AlertsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-xs text-ink-500">Loading alerts</div>}>
      <AlertsFeed />
    </Suspense>
  );
}

function AlertsFeed() {
  const params = useSearchParams();
  const savedSearchId = params.get("savedSearchId");
  const focus = params.get("focus");

  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [status] = useServerStatus();
  const warning = storeWarning(status?.crmStore);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(focus);
  const [converting, setConverting] = useState<string | null>(null);

  const load = useCallback(() => {
    const query = new URLSearchParams({ limit: "200" });
    if (savedSearchId) query.set("savedSearchId", savedSearchId);
    if (unreadOnly) query.set("unread", "true");
    return api<{ alerts: AlertRow[] }>(`/api/alerts?${query.toString()}`)
      .then((body) => setAlerts(body.alerts))
      .catch(() => setAlerts([]));
  }, [savedSearchId, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const convert = async (alert: AlertRow) => {
    setConverting(alert.id);
    try {
      // The alert already carries the parcel as it looked when it fired, which
      // is exactly what should be tracked: the record the decision was made on.
      const snapshot = alert.propertySnapshot as Record<string, unknown>;
      const provenance = (snapshot["provenance"] ?? {}) as {
        sourceSystem?: string | null;
        sourceUrl?: string | null;
      };

      await post("/api/opportunities", {
        propertyId: alert.propertyId,
        addressLine: String(snapshot["address"] ?? `Parcel ${alert.propertyId}`),
        addressCity: (snapshot["addressCity"] as string | null) ?? null,
        addressZip: (snapshot["addressZip"] as string | null) ?? null,
        latitude: (snapshot["latitude"] as number | null) ?? null,
        longitude: (snapshot["longitude"] as number | null) ?? null,
        assessedValue: (snapshot["assessedValue"] as number | null) ?? null,
        ownerName: (snapshot["ownerName"] as string | null) ?? null,
        sourceSystem: provenance.sourceSystem ?? null,
        sourceUrl: provenance.sourceUrl ?? null,
        propertySnapshot: snapshot,
        matchScore: alert.score,
        matchRationale: alert.rationale,
        savedSearchId: alert.savedSearchId,
        alertId: alert.id,
      });
      await patch(`/api/alerts/${alert.id}`, { read: true }).catch(() => undefined);
      await load();
    } finally {
      setConverting(null);
    }
  };

  const unread = (alerts ?? []).filter((alert) => alert.readAt === null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Alerts</h1>
          <p className="text-xs text-ink-500">
            Raised when a parcel newly matches a saved criteria set, or when one that already
            matched changes underneath you.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={unreadOnly ? "primary" : "default"}
            onClick={() => setUnreadOnly((value) => !value)}
          >
            {unreadOnly ? "Showing unread" : `Unread only (${count(unread)})`}
          </Button>
          <Button
            disabled={!unread}
            onClick={async () => {
              await patch("/api/alerts", { markAllRead: true }).catch(() => undefined);
              await load();
            }}
          >
            Mark all read
          </Button>
        </div>
      </div>

      {warning && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          {warning}
        </div>
      )}

      {alerts === null ? (
        <Spinner label="Reading the notification history" />
      ) : alerts.length === 0 ? (
        <Empty title="No alerts yet">
          Save a set of criteria, then either wait for the scheduled matcher or use the simulate
          buttons on the saved criteria page to drive the whole loop now.
        </Empty>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const snapshot = alert.propertySnapshot as {
              address?: string;
              ownerName?: string | null;
              assessedValue?: number | null;
              roofAgeYears?: number | null;
              yearsSinceLastSale?: number | null;
              tenureConfidence?: string | null;
              tenureCaveat?: string | null;
              courtDistressScore?: number | null;
              provenance?: { sourceSystem?: string | null; sourceUrl?: string | null };
            };
            const open = expanded === alert.id;

            return (
              <Panel
                key={alert.id}
                className={alert.readAt === null ? "border-accent-500/30" : undefined}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{snapshot.address ?? alert.propertyId}</span>
                    <Badge tone={alert.kind === "new_match" ? "good" : "accent"}>
                      {alert.kind === "new_match" ? "new match" : "changed"}
                    </Badge>
                    {alert.readAt === null && <Badge tone="warn">unread</Badge>}
                    {alert.opportunityId && <Badge tone="accent">in pipeline</Badge>}
                  </span>
                }
                subtitle={`${alert.searchName ?? "a saved search"} - ${ago(alert.createdAt)}`}
                actions={
                  <>
                    <ScoreBadge score={alert.score} />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(open ? null : alert.id)}
                    >
                      {open ? "Less" : "Detail"}
                    </Button>
                  </>
                }
              >
                <div className="space-y-2.5">
                  <p className="text-xs leading-relaxed text-ink-300">{alert.rationale}</p>

                  {alert.changedFields.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-ink-500">Changed:</span>
                      {alert.changedFields.map((field) => (
                        <Badge key={field} tone="accent">
                          {humanField(field)}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Labelled rather than left implicit: these are the values
                      that were read when the alert was raised, not a live
                      lookup. A parcel can move on afterwards, and an alert that
                      silently re-read would stop being a record of anything. */}
                  <p className="text-[10px] uppercase tracking-wide text-ink-600">
                    the parcel as it was when this was raised
                  </p>
                  <dl className="tabular grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                    <Row label="Owner" value={snapshot.ownerName ?? "not published"} />
                    <Row label="Assessed" value={money(snapshot.assessedValue ?? null)} />
                    <Row
                      label="Roof age"
                      value={
                        snapshot.roofAgeYears !== null && snapshot.roofAgeYears !== undefined
                          ? `${snapshot.roofAgeYears} years`
                          : "unknown"
                      }
                    />
                    <Row
                      label="Held"
                      value={heldValue(snapshot.yearsSinceLastSale, snapshot.tenureConfidence)}
                    />
                  </dl>
                  {snapshot.tenureCaveat && (
                    <p
                      data-testid="alert-tenure-caveat"
                      className="text-[10px] leading-snug text-ink-500"
                    >
                      {snapshot.tenureCaveat.charAt(0).toUpperCase() +
                        snapshot.tenureCaveat.slice(1)}
                      .
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-ink-500">Triggered by pipeline run</span>
                    <span className="mono text-[11px] text-ink-300">
                      {alert.pipelineRunId ?? "unknown"}
                    </span>
                    {alert.matcherTrigger && (
                      <Badge tone="outline">matcher: {alert.matcherTrigger}</Badge>
                    )}
                    {/* A simulated run can be cleared after it raised an alert,
                        and then the parcel no longer holds the values quoted
                        above. The alert is still a true record of what was
                        observed - it is history, not a live reading - but a
                        reader comparing the two would otherwise just see two
                        different numbers and no explanation. */}
                    {alert.pipelineRunId?.startsWith("sim-") && (
                      <Badge
                        tone="warn"
                        title="A simulated pipeline update raised this. The values above are what was observed at the time; if the simulation has since been cleared, the parcel now shows its published values again."
                      >
                        simulated run
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    {!alert.opportunityId ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={converting === alert.id}
                        onClick={() => void convert(alert)}
                      >
                        {converting === alert.id ? "Adding" : "Convert to opportunity"}
                      </Button>
                    ) : (
                      <Link href={`/opportunities/${alert.opportunityId}`}>
                        <Button size="sm">Open opportunity</Button>
                      </Link>
                    )}
                    <Link href={`/search?focus=${alert.propertyId}`}>
                      <Button size="sm" variant="ghost">
                        Show on map
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await patch(`/api/alerts/${alert.id}`, {
                          read: alert.readAt === null,
                        }).catch(() => undefined);
                        await load();
                      }}
                    >
                      {alert.readAt === null ? "Mark read" : "Mark unread"}
                    </Button>
                  </div>

                  {open && (
                    <div className="space-y-2 border-t border-[var(--line)] pt-2.5">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                        Deliveries
                      </h3>
                      {alert.notifications.length === 0 ? (
                        <p className="text-[11px] text-ink-500">
                          No channels were enabled on this saved search.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {alert.notifications.map((delivery) => (
                            <li
                              key={delivery.id}
                              className="rounded border border-[var(--line)] px-2.5 py-2"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone="outline">{delivery.channel.replace("_", " ")}</Badge>
                                <Badge tone={delivery.status === "delivered" ? "good" : "neutral"}>
                                  {delivery.status}
                                </Badge>
                                <span className="text-[11px] text-ink-500">
                                  {delivery.recipient ?? "in the app"} - {when(delivery.sentAt)}
                                </span>
                              </div>
                              {delivery.subject && (
                                <p className="mt-1 text-[11px] font-medium text-ink-200">
                                  {delivery.subject}
                                </p>
                              )}
                              {delivery.body && (
                                <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-400">
                                  {delivery.body}
                                </pre>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}

                      {snapshot.provenance?.sourceUrl && (
                        <p className="text-[11px] text-ink-500">
                          Source:{" "}
                          <a
                            href={snapshot.provenance.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-accent-400 hover:underline"
                          >
                            {snapshot.provenance.sourceUrl}
                          </a>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-500">{label}</dt>
      <dd className="truncate text-ink-200" title={value}>
        {value}
      </dd>
    </div>
  );
}
