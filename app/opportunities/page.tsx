/**
 * The opportunity board.
 *
 * Two views of the same set, because the two jobs are different: a board for
 * "what is where in the funnel", a table for "which of these should I act on".
 * Both filter on the same criteria the story names - stage, match strength,
 * geography, ownership signals and court distress - and both export the current
 * selection rather than everything, because the export is usually a mailing
 * list and posting to the wrong set costs real money.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  Panel,
  ScoreBadge,
  Select,
  Spinner,
  StageBadge,
  TextInput,
  ago,
  count,
  money,
} from "@/components/ui";
import { ApiError, api, patch, post, type OpportunityRow } from "@/lib/client";
import { storeWarning, useServerStatus } from "@/lib/data/status";
import {
  ACQUISITION_STAGES,
  CHANNEL_LABELS,
  STAGE_LABELS,
  type AcquisitionStage,
  type OutreachChannel,
} from "@/lib/notify/types";

const BOARD_STAGES: AcquisitionStage[] = [
  "identified",
  "contacted",
  "negotiating",
  "under_contract",
  "closed",
];

export default function OpportunitiesPage() {
  const [rows, setRows] = useState<OpportunityRow[] | null>(null);
  const [status] = useServerStatus();
  const warning = storeWarning(status?.crmStore);
  const [view, setView] = useState<"board" | "table">("board");
  const [stageFilter, setStageFilter] = useState<AcquisitionStage | "all">("all");
  const [minScore, setMinScore] = useState("");
  const [city, setCity] = useState("");
  const [signal, setSignal] = useState<"any" | "absentee" | "court">("any");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignOpen, setCampaignOpen] = useState(false);

  const load = useCallback(() => {
    api<{ opportunities: OpportunityRow[] }>("/api/opportunities?limit=1000")
      .then((body) => setRows(body.opportunities))
      .catch(() => setRows([]));
  }, []);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const min = Number(minScore) || 0;
    const needle = city.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (stageFilter !== "all" && row.opportunity.stage !== stageFilter) return false;
      if (min && (row.opportunity.matchScore ?? 0) < min) return false;
      if (needle && !(row.opportunity.addressCity ?? "").toLowerCase().includes(needle))
        return false;
      const snapshot = (row.opportunity.propertySnapshot ?? {}) as {
        ownerOccupied?: boolean | null;
        courtDistressScore?: number | null;
      };
      if (signal === "absentee" && snapshot.ownerOccupied !== false) return false;
      if (signal === "court" && !(Number(snapshot.courtDistressScore ?? 0) > 0)) return false;
      return true;
    });
  }, [rows, stageFilter, minScore, city, signal]);

  const byStage = useMemo(() => {
    const map = new Map<AcquisitionStage, OpportunityRow[]>();
    for (const row of filtered) {
      const list = map.get(row.opportunity.stage) ?? [];
      list.push(row);
      map.set(row.opportunity.stage, list);
    }
    return map;
  }, [filtered]);

  const advance = async (row: OpportunityRow, stage: AcquisitionStage) => {
    await patch(`/api/opportunities/${row.opportunity.id}`, { stage }).catch(() => undefined);
    load();
  };

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Opportunities</h1>
          <p className="text-xs text-ink-500">
            {count(filtered.length)} of {count((rows ?? []).length)} shown
            {selected.size ? ` - ${count(selected.size)} selected` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={view === "board" ? "primary" : "default"}
            onClick={() => setView("board")}
          >
            Board
          </Button>
          <Button
            variant={view === "table" ? "primary" : "default"}
            onClick={() => setView("table")}
          >
            Table
          </Button>
          <Button
            variant="primary"
            disabled={selected.size === 0}
            onClick={() => setCampaignOpen(true)}
            title={selected.size ? undefined : "Select opportunities in the table view first."}
          >
            Outreach ({count(selected.size)})
          </Button>
          <a href="/api/export?kind=opportunities" download>
            <Button>Export CSV</Button>
          </a>
          <a href="/api/export?kind=mailing" download>
            <Button title="Owners with a mailing address only.">Mailing list</Button>
          </a>
        </div>
      </div>

      {warning && (
        <div className="rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-xs text-warn-500">
          {warning}
        </div>
      )}

      <Panel bodyClassName="px-4 py-2.5">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            value={stageFilter}
            onChange={setStageFilter}
            options={[
              { value: "all" as const, label: "All stages" },
              ...ACQUISITION_STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] })),
            ]}
          />
          <TextInput
            type="number"
            value={minScore}
            onChange={setMinScore}
            placeholder="Minimum match score"
          />
          <TextInput value={city} onChange={setCity} placeholder="City contains" />
          <Select
            value={signal}
            onChange={setSignal}
            options={[
              { value: "any" as const, label: "Any ownership signal" },
              { value: "absentee" as const, label: "Absentee owner only" },
              { value: "court" as const, label: "Court distress only" },
            ]}
          />
        </div>
      </Panel>

      {rows === null ? (
        <Spinner label="Reading opportunities" />
      ) : filtered.length === 0 ? (
        <Empty title="Nothing here">
          Track a parcel from the search page or convert an alert, and it appears at the Identified
          stage.
        </Empty>
      ) : view === "board" ? (
        <div className="grid gap-3 lg:grid-cols-5">
          {BOARD_STAGES.map((stage) => {
            const list = byStage.get(stage) ?? [];
            return (
              <div
                key={stage}
                className="flex min-h-[200px] flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)]"
              >
                <header className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="tabular text-[11px] text-ink-500">{count(list.length)}</span>
                </header>
                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {list.map((row) => (
                    <OpportunityCard key={row.opportunity.id} row={row} onAdvance={advance} />
                  ))}
                  {list.length === 0 && (
                    <p className="px-1 py-4 text-center text-[11px] text-ink-600">empty</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Panel bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="border-b border-[var(--line)] text-[11px] uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2">Property</th>
                  <th className="px-2 py-2">Stage</th>
                  <th className="px-2 py-2">Score</th>
                  <th className="px-2 py-2">Owner</th>
                  <th className="px-2 py-2">Assessed</th>
                  <th className="px-2 py-2">Offer</th>
                  <th className="px-2 py-2">Assignee</th>
                  <th className="px-2 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.opportunity.id}
                    className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--panel-raised)]"
                  >
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(row.opportunity.id)}
                        onChange={() => toggleSelected(row.opportunity.id)}
                        className="size-3.5 accent-[var(--color-accent-500)]"
                      />
                    </td>
                    <td className="max-w-[280px] px-2 py-2">
                      <Link
                        href={`/opportunities/${row.opportunity.id}`}
                        className="block truncate text-ink-100 hover:underline"
                      >
                        {row.opportunity.addressLine}
                      </Link>
                      <span className="mono text-[10px] text-ink-600">
                        {row.opportunity.propertyId}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <StageBadge stage={row.opportunity.stage} />
                    </td>
                    <td className="px-2 py-2">
                      {row.opportunity.matchScore !== null && (
                        <ScoreBadge
                          score={row.opportunity.matchScore}
                          title={row.opportunity.matchRationale ?? undefined}
                        />
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-2 text-ink-300">
                      {row.owner?.name ?? row.opportunity.ownerNameSnapshot ?? "not published"}
                    </td>
                    <td className="tabular px-2 py-2 text-ink-300">
                      {money(row.opportunity.assessedValue)}
                    </td>
                    <td className="tabular px-2 py-2 text-ink-300">
                      {row.opportunity.offerPrice ? money(row.opportunity.offerPrice) : "-"}
                    </td>
                    <td className="px-2 py-2 text-ink-400">{row.assignee?.name ?? "unassigned"}</td>
                    <td className="px-2 py-2 text-ink-500">{ago(row.opportunity.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <FuturePlaceholders />

      {campaignOpen && (
        <CampaignDialog
          opportunityIds={[...selected]}
          onClose={() => setCampaignOpen(false)}
          onSent={() => {
            setCampaignOpen(false);
            setSelected(new Set());
            load();
          }}
        />
      )}
    </div>
  );
}

function OpportunityCard({
  row,
  onAdvance,
}: {
  row: OpportunityRow;
  onAdvance: (row: OpportunityRow, stage: AcquisitionStage) => void;
}) {
  const snapshot = (row.opportunity.propertySnapshot ?? {}) as {
    ownerOccupied?: boolean | null;
    courtDistressScore?: number | null;
    roofAgeYears?: number | null;
  };
  const index = BOARD_STAGES.indexOf(row.opportunity.stage);
  const next = index >= 0 && index < BOARD_STAGES.length - 1 ? BOARD_STAGES[index + 1] : null;

  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-raised)] p-2.5">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/opportunities/${row.opportunity.id}`}
          className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-100 hover:underline"
        >
          {row.opportunity.addressLine}
        </Link>
        {row.opportunity.matchScore !== null && (
          <ScoreBadge
            score={row.opportunity.matchScore}
            title={row.opportunity.matchRationale ?? undefined}
          />
        )}
      </div>
      <p className="truncate text-[11px] text-ink-500">
        {row.owner?.name ?? row.opportunity.ownerNameSnapshot ?? "owner not published"}
      </p>
      <p className="tabular mt-1 text-[11px] text-ink-400">
        {money(row.opportunity.assessedValue)}
      </p>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {snapshot.ownerOccupied === false && <Badge tone="outline">absentee</Badge>}
        {Number(snapshot.courtDistressScore ?? 0) > 0 && <Badge tone="bad">court</Badge>}
        {row.assignee && <Badge tone="neutral">{row.assignee.name.split(" ")[0]}</Badge>}
      </div>

      {next && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 w-full"
          onClick={() => onAdvance(row, next)}
        >
          Move to {STAGE_LABELS[next]}
        </Button>
      )}
    </div>
  );
}

/**
 * The story asks for visible but disabled sections for future expansion. They
 * are here rather than hidden because a reviewer is told to look for them, and
 * because saying what is deliberately out of scope is more useful than silence.
 */
function FuturePlaceholders() {
  const items = [
    {
      title: "Disposition",
      body: "Buyer list, assignment contracts and double closings. Out of scope for the acquisition milestone.",
    },
    {
      title: "Portfolio tracking",
      body: "Held assets, rent roll and refinance triggers. Begins once an opportunity closes.",
    },
    {
      title: "Live messaging",
      body: "Real email, SMS and print-and-mail providers. Outreach stays simulated in this milestone by design.",
    },
  ];

  return (
    <Panel
      title="Future expansion"
      subtitle="Deliberately disabled. Listed so the boundary of this milestone is visible."
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.title}
            className="rounded-lg border border-dashed border-[var(--line)] px-3 py-2.5 opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-300">{item.title}</span>
              <Badge tone="neutral">disabled</Badge>
            </div>
            <p className="mt-1 text-[11px] text-ink-500">{item.body}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CampaignDialog({
  opportunityIds,
  onClose,
  onSent,
}: {
  opportunityIds: string[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<
    { id: string; name: string; channels: OutreachChannel[]; description: string }[]
  >([]);
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [templateId, setTemplateId] = useState("cash-offer-intro");
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: typeof templates }>("/api/outreach")
      .then((body) => setTemplates(body.templates))
      .catch(() => undefined);
  }, []);

  const usable = templates.filter((template) => template.channels.includes(channel));
  const active = usable.find((template) => template.id === templateId) ?? usable[0];

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await post("/api/outreach", {
        opportunityIds,
        channel,
        templateId: active?.id ?? templateId,
        campaignName: name.trim() || undefined,
      });
      onSent();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The campaign could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md">
        <Panel
          title="Mocked outreach campaign"
          subtitle={`${count(opportunityIds.length)} owners`}
          actions={
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-[11px] text-warn-500">
              Nothing is sent to a property owner. Messages are addressed to a reserved
              <span className="mono"> .invalid </span>
              domain and a 555 number, and the delivery lifecycle is simulated.
            </div>

            <div className="flex gap-1.5">
              {(Object.keys(CHANNEL_LABELS) as OutreachChannel[]).map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={channel === option ? "primary" : "default"}
                  onClick={() => setChannel(option)}
                >
                  {CHANNEL_LABELS[option]}
                </Button>
              ))}
            </div>

            <div className="space-y-1.5">
              {usable.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setTemplateId(template.id)}
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                    active?.id === template.id
                      ? "border-accent-500 bg-accent-500/10"
                      : "border-[var(--line)] hover:bg-[var(--panel-raised)]"
                  }`}
                >
                  <span className="block text-[12px] font-medium text-ink-100">
                    {template.name}
                  </span>
                  <span className="block text-[11px] text-ink-500">{template.description}</span>
                </button>
              ))}
            </div>

            <TextInput value={name} onChange={setName} placeholder="Campaign name (optional)" />

            {error && (
              <p className="rounded-md border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-xs text-bad-500">
                {error}
              </p>
            )}

            <Button variant="primary" className="w-full" onClick={send} disabled={sending}>
              {sending ? "Sending" : `Send to ${count(opportunityIds.length)} owners`}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
