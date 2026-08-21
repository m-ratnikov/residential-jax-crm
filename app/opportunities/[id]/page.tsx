/**
 * One opportunity.
 *
 * Everything a person needs to act, on one screen: where the parcel came from
 * and why it scored, who the owner is, what stage it is at and how it got
 * there, the outreach thread with its simulated lifecycle, notes and tasks.
 *
 * The stage control writes a stage event every time, so the history below it is
 * the real record rather than a reconstruction.
 */

"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  Field,
  Panel,
  ScoreBadge,
  Select,
  Spinner,
  StageBadge,
  StatusBadge,
  TextArea,
  TextInput,
  ago,
  money,
  when,
} from "@/components/ui";
import { ApiError, api, patch, post, type OpportunityRow, type OutreachMessageRow } from "@/lib/client";
import {
  ACQUISITION_STAGES,
  CHANNEL_LABELS,
  STAGE_LABELS,
  type AcquisitionStage,
} from "@/lib/notify/types";

interface Detail extends OpportunityRow {
  stageEvents: {
    event: { id: string; fromStage: string | null; toStage: string; note: string | null; createdAt: string };
    actor: { id: string; name: string } | null;
  }[];
  notes: { note: { id: string; body: string; createdAt: string }; author: { name: string } | null }[];
  tasks: {
    task: { id: string; title: string; status: string; dueAt: string | null };
    assignee: { id: string; name: string } | null;
  }[];
  outreach: OutreachMessageRow[];
}

export default function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  const [noteBody, setNoteBody] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/api/opportunities/${id}`)
      .then(setDetail)
      .catch((cause: ApiError) => setError(cause.message));
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    api<{ opportunities: OpportunityRow[] }>("/api/opportunities?limit=1")
      .then(() => undefined)
      .catch(() => undefined);
    fetch("/api/team")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { members?: { id: string; name: string }[] } | null) => {
        if (body?.members) setTeam(body.members);
      })
      .catch(() => undefined);
  }, []);

  const update = async (body: Record<string, unknown>) => {
    setSaving(true);
    await patch(`/api/opportunities/${id}`, body).catch(() => undefined);
    setSaving(false);
    load();
  };

  if (error) {
    return (
      <div className="rounded-lg border border-bad-500/40 bg-bad-500/10 px-4 py-3 text-xs text-bad-500">
        {error}
      </div>
    );
  }

  if (!detail) return <Spinner label="Reading the opportunity" />;

  const opportunity = detail.opportunity;
  const snapshot = (opportunity.propertySnapshot ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">{opportunity.addressLine}</h1>
            <StageBadge stage={opportunity.stage} />
            {opportunity.matchScore !== null && (
              <ScoreBadge
                score={opportunity.matchScore}
                title={opportunity.matchRationale ?? undefined}
              />
            )}
          </div>
          <p className="mono text-[11px] text-ink-500">{opportunity.propertyId}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`/search?focus=${opportunity.propertyId}`}>
            <Button>Show on map</Button>
          </Link>
          <Link href="/opportunities">
            <Button variant="ghost">Back to board</Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Panel title="Why this is here">
            <p className="text-xs leading-relaxed text-ink-300">
              {opportunity.matchRationale ?? "Added by hand rather than from a criteria match."}
            </p>
            {detail.searchName && (
              <p className="mt-1.5 text-[11px] text-ink-500">
                Surfaced by the saved search <span className="text-ink-300">{detail.searchName}</span>.
              </p>
            )}
            <dl className="tabular mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <Row label="Assessed" value={money(opportunity.assessedValue)} />
              <Row label="Built" value={String(snapshot["builtYear"] ?? "unknown")} />
              <Row
                label="Roof age"
                value={
                  snapshot["roofAgeYears"] !== null && snapshot["roofAgeYears"] !== undefined
                    ? `${snapshot["roofAgeYears"]} years`
                    : "unknown"
                }
              />
              <Row
                label="Held"
                value={
                  snapshot["yearsSinceLastSale"] !== null && snapshot["yearsSinceLastSale"] !== undefined
                    ? `${snapshot["yearsSinceLastSale"]} years`
                    : "no recorded sale"
                }
              />
            </dl>
            {Boolean(snapshot["provenance"]) && (
              <p className="mt-2 text-[11px] text-ink-500">
                Source:{" "}
                {(snapshot["provenance"] as { sourceSystem?: string })?.sourceSystem ?? "unknown"}
                {(snapshot["provenance"] as { fetchedAt?: string })?.fetchedAt
                  ? `, collected ${when((snapshot["provenance"] as { fetchedAt?: string }).fetchedAt)}`
                  : ""}
              </p>
            )}
          </Panel>

          <Panel
            title="Outreach"
            subtitle="Simulated. Nothing reaches a property owner."
            actions={
              <Button
                size="sm"
                onClick={async () => {
                  await patch("/api/outreach", { fastForward: true }).catch(() => undefined);
                  load();
                }}
                title="Pull every pending provider event forward to now, so a direct mail piece does not take days to be scanned."
              >
                Fast forward lifecycle
              </Button>
            }
          >
            {detail.outreach.length === 0 ? (
              <Empty title="Nothing sent">
                Select this opportunity on the board and launch a campaign.
              </Empty>
            ) : (
              <ul className="space-y-2.5">
                {detail.outreach.map(({ message, events }) => (
                  <li key={message.id} className="rounded-lg border border-[var(--line)] p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="outline">{CHANNEL_LABELS[message.channel]}</Badge>
                      <StatusBadge status={message.status} />
                      <span className="text-[11px] text-ink-500">
                        to {message.toAddress} - {ago(message.createdAt)}
                      </span>
                    </div>
                    {message.subject && (
                      <p className="mt-1.5 text-[12px] font-medium text-ink-200">{message.subject}</p>
                    )}
                    <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-400">
                      {message.body}
                    </pre>
                    <div className="mt-2 border-t border-[var(--line)] pt-1.5">
                      <p className="mono text-[10px] text-ink-600">{message.providerMessageId}</p>
                      <ul className="mt-1 space-y-0.5">
                        {events.map((event) => {
                          const future = new Date(event.occurredAt).getTime() > Date.now();
                          return (
                            <li
                              key={event.id}
                              className={`flex items-center gap-2 text-[11px] ${future ? "opacity-45" : ""}`}
                            >
                              <StatusBadge status={event.status} />
                              <span className="text-ink-500">{event.detail}</span>
                              <span className="ml-auto text-ink-600">
                                {future ? `scheduled ${when(event.occurredAt)}` : ago(event.occurredAt)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Notes">
            <div className="flex gap-2">
              <div className="flex-1">
                <TextArea value={noteBody} onChange={setNoteBody} rows={2} placeholder="What happened" />
              </div>
              <Button
                variant="primary"
                disabled={!noteBody.trim()}
                onClick={async () => {
                  await post(`/api/opportunities/${id}/activity`, {
                    kind: "note",
                    body: noteBody.trim(),
                  }).catch(() => undefined);
                  setNoteBody("");
                  load();
                }}
              >
                Add
              </Button>
            </div>
            {detail.notes.length > 0 && (
              <ul className="mt-3 space-y-2">
                {detail.notes.map(({ note, author }) => (
                  <li key={note.id} className="rounded border border-[var(--line)] px-2.5 py-2">
                    <p className="text-[12px] text-ink-200">{note.body}</p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      {author?.name ?? "someone"} - {ago(note.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Stage history">
            {detail.stageEvents.length === 0 ? (
              <Empty title="No stage changes yet" />
            ) : (
              <ol className="space-y-2">
                {detail.stageEvents.map(({ event, actor }) => (
                  <li key={event.id} className="flex items-start gap-2.5">
                    <StageBadge stage={event.toStage as AcquisitionStage} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-ink-400">
                        {event.fromStage
                          ? `from ${STAGE_LABELS[event.fromStage as AcquisitionStage]}`
                          : "created"}
                        {actor ? ` by ${actor.name}` : ""}
                      </p>
                      {event.note && <p className="text-[11px] text-ink-500">{event.note}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] text-ink-600">{ago(event.createdAt)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="space-y-3">
          <Panel title="Stage">
            <Select
              value={opportunity.stage}
              onChange={(stage) => void update({ stage })}
              options={ACQUISITION_STAGES.map((stage) => ({
                value: stage,
                label: STAGE_LABELS[stage],
              }))}
              disabled={saving}
            />
          </Panel>

          <Panel title="Owner">
            {detail.owner ? (
              <dl className="space-y-1 text-[11px]">
                <Row label="Name" value={detail.owner.name} />
                <Row label="Email" value={detail.owner.email ?? "not on file"} />
                <Row label="Phone" value={detail.owner.phone ?? "not on file"} />
                <Row
                  label="Mailing"
                  value={
                    [
                      detail.owner.mailingAddress,
                      detail.owner.mailingCity,
                      detail.owner.mailingState,
                      detail.owner.mailingZip,
                    ]
                      .filter(Boolean)
                      .join(", ") || "not published"
                  }
                />
              </dl>
            ) : (
              <p className="text-[11px] text-ink-500">
                No owner record. The county publishes an owner of record only for some parcels.
              </p>
            )}
          </Panel>

          <Panel title="Deal">
            <div className="space-y-2.5">
              <Field label="Assignee">
                <Select
                  value={detail.assignee?.id ?? ""}
                  onChange={(value) => void update({ assigneeId: value || null })}
                  options={[
                    { value: "", label: "Unassigned" },
                    ...team.map((member) => ({ value: member.id, label: member.name })),
                  ]}
                />
              </Field>
              <Field label="Owner interest">
                <TextInput
                  value={opportunity.ownerInterest ?? ""}
                  onChange={(value) => void update({ ownerInterest: value || null })}
                  placeholder="Warm, wants to close after the school year"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Asking">
                  <TextInput
                    type="number"
                    value={opportunity.askingPrice?.toString() ?? ""}
                    onChange={(value) => void update({ askingPrice: value ? Number(value) : null })}
                  />
                </Field>
                <Field label="Our offer">
                  <TextInput
                    type="number"
                    value={opportunity.offerPrice?.toString() ?? ""}
                    onChange={(value) => void update({ offerPrice: value ? Number(value) : null })}
                  />
                </Field>
              </div>
              <Field label="Next step">
                <TextInput
                  value={opportunity.nextStep ?? ""}
                  onChange={(value) => void update({ nextStep: value || null })}
                  placeholder="Call back Thursday"
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Tasks">
            <div className="flex gap-2">
              <div className="flex-1">
                <TextInput value={taskTitle} onChange={setTaskTitle} placeholder="Assign a task" />
              </div>
              <Button
                disabled={!taskTitle.trim()}
                onClick={async () => {
                  await post(`/api/opportunities/${id}/activity`, {
                    kind: "task",
                    title: taskTitle.trim(),
                    assigneeId: detail.assignee?.id ?? null,
                  }).catch(() => undefined);
                  setTaskTitle("");
                  load();
                }}
              >
                Add
              </Button>
            </div>
            {detail.tasks.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {detail.tasks.map(({ task, assignee }) => (
                  <li key={task.id} className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={task.status === "done"}
                      onChange={async () => {
                        await post(`/api/opportunities/${id}/activity`, {
                          kind: "task_status",
                          taskId: task.id,
                          status: task.status === "done" ? "open" : "done",
                        }).catch(() => undefined);
                        load();
                      }}
                      className="size-3.5 accent-[var(--color-accent-500)]"
                    />
                    <span className={task.status === "done" ? "text-ink-600 line-through" : "text-ink-200"}>
                      {task.title}
                    </span>
                    {assignee && <Badge tone="neutral">{assignee.name.split(" ")[0]}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink-200">{value}</dd>
    </div>
  );
}
