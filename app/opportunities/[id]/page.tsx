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
  OwnerKindBadge,
  Panel,
  ScoreBadge,
  Select,
  SimulatedContact,
  Spinner,
  StageBadge,
  StatusBadge,
  TextArea,
  TextInput,
  ago,
  money,
  when,
} from "@/components/ui";
import {
  ApiError,
  api,
  patch,
  post,
  type OpportunityRow,
  type OutreachMessageRow,
} from "@/lib/client";
import type { MockedOwnerContact } from "@/lib/crm/documents";
import {
  ACQUISITION_STAGES,
  CHANNEL_LABELS,
  STAGE_LABELS,
  type AcquisitionStage,
} from "@/lib/notify/types";

/**
 * The owner as this screen needs it.
 *
 * `OpportunityRow` describes the columns a board row needs and stops there; the
 * detail endpoint answers with the whole owner document, provenance and mocked
 * skip trace included. Narrowing the property here rather than widening the
 * shared row type keeps the board's contract as small as the board's needs.
 */
export type DetailOwner = NonNullable<OpportunityRow["owner"]> & {
  sourceSystem?: string | null;
  sourceUrl?: string | null;
  skipTrace?: MockedOwnerContact | null;
};

interface Detail extends OpportunityRow {
  owner: DetailOwner | null;
  stageEvents: {
    event: {
      id: string;
      fromStage: string | null;
      toStage: string;
      note: string | null;
      createdAt: string;
    };
    actor: { id: string; name: string } | null;
  }[];
  notes: {
    note: { id: string; body: string; createdAt: string };
    author: { name: string } | null;
  }[];
  tasks: {
    task: { id: string; title: string; status: string; dueAt: string | null };
    assignee: { id: string; name: string } | null;
  }[];
  outreach: OutreachMessageRow[];
}

/**
 * A parcel fact this deal's snapshot never captured, read back off the roll.
 *
 * There are two writers of `propertySnapshot`. The parcel drawer's "Track as
 * opportunity" sends `builtYear`, and `alertSnapshot` in lib/notify/snapshot.ts
 * - which is what the seed, the matcher API and the alerts page all convert
 * through - did not, so every deal that arrived through an alert had no
 * `builtYear` key at all and the page printed "unknown" for a year the roll
 * publishes and the drawer beside it shows.
 *
 * `alertSnapshot` now carries `builtYear`, which is the real fix and closes the
 * gap for everything written since. This stays because it is not retroactive:
 * an alert, and any deal opened from it, written before that change still has a
 * snapshot with no `builtYear` in it, and those documents are in the store on
 * the deployed runtime. The query engine lives in this tab, so rather than
 * assert the roll is silent, the page reads the parcel the same way the drawer
 * does.
 *
 * Loaded through a dynamic import and only when a field is actually missing, so
 * a deal whose snapshot is complete never pays for the engine, and one whose
 * snapshot is not renders immediately and fills the field in when the parcel
 * arrives. Nothing here blocks the deal.
 */
type RollLookup =
  | { status: "idle" | "reading" | "unavailable"; builtYear: null }
  | { status: "ready"; builtYear: number | null };

/** The parcel this answer is about, so a settled answer cannot outlive it. */
type RollState = RollLookup & { propertyId: string | null };

function useRollFallback(propertyId: string, needed: boolean): RollLookup {
  const [settled, setSettled] = useState<RollState>({
    propertyId: null,
    status: "idle",
    builtYear: null,
  });

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;

    void (async () => {
      try {
        const { fetchOverlay, propertySource } = await import("@/lib/data/client-source");
        const overlay = await fetchOverlay();
        const property = await propertySource().getProperty(propertyId, overlay.overlay);
        if (cancelled) return;
        setSettled(
          property
            ? { propertyId, status: "ready", builtYear: property.builtYear }
            : { propertyId, status: "unavailable", builtYear: null },
        );
      } catch {
        if (!cancelled) setSettled({ propertyId, status: "unavailable", builtYear: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId, needed]);

  // "Reading" is derived rather than written, so the effect only ever reports
  // an answer and never sets state on its way to asking the question.
  if (!needed) return { status: "idle", builtYear: null };
  if (settled.propertyId !== propertyId) return { status: "reading", builtYear: null };
  return settled;
}

/** What the "Built" cell should say, and why. */
export function builtYearCell(
  snapshot: Readonly<Record<string, unknown>>,
  roll: RollLookup,
): { value: string; title?: string } {
  const captured = snapshot["builtYear"];
  if (typeof captured === "number") return { value: String(captured) };
  // Present and null is the roll's own answer, and is not the same thing as a
  // snapshot that predates the field. Only the second one is worth chasing.
  if (captured === null) return { value: "not published" };

  switch (roll.status) {
    case "ready":
      return roll.builtYear === null
        ? { value: "not published" }
        : {
            value: String(roll.builtYear),
            title:
              "Read from the county roll just now. The snapshot stored when this deal was created did not carry a year built.",
          };
    case "reading":
      return {
        value: "reading the roll",
        title: "Not in this deal's snapshot, so the parcel is being read from the published roll.",
      };
    default:
      return {
        value: "not in this deal's snapshot",
        title:
          "The snapshot stored when this deal was created did not carry a year built, and the published roll could not be read from this tab. Open the parcel from Show on map.",
      };
  }
}

export default function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  const [noteBody, setNoteBody] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api<Detail>(`/api/opportunities/${id}`)
        .then(setDetail)
        .catch((cause: ApiError) => setError(cause.message)),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ opportunities: OpportunityRow[] }>("/api/opportunities?limit=1")
      .then(() => undefined)
      .catch(() => undefined);
    fetch("/api/team", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { members?: { id: string; name: string }[] } | null) => {
        if (body?.members) setTeam(body.members);
      })
      .catch(() => undefined);
  }, []);

  /**
   * Write, then show what was written.
   *
   * The PATCH answers with the stored opportunity, so that is applied straight
   * away rather than waiting a round trip to find out what this tab just asked
   * for. The reload after it is what brings back the parts a stage change also
   * moves - the stage event appended to the history below - and it is awaited,
   * so `saving` is not cleared while the screen still shows the old value.
   */
  const update = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const written = await patch<{ opportunity: Detail["opportunity"] }>(
        `/api/opportunities/${id}`,
        body,
      ).catch(() => null);
      if (written?.opportunity) {
        setDetail((current) =>
          current ? { ...current, opportunity: written.opportunity } : current,
        );
      }
      await load();
    } finally {
      setSaving(false);
    }
  };

  // Read before the early returns below, because a hook cannot be. Nothing is
  // fetched until the deal has loaded and its snapshot is found to be short of
  // the field; see useRollFallback.
  const snapshot = (detail?.opportunity.propertySnapshot ?? {}) as Record<string, unknown>;
  const roll = useRollFallback(id, Boolean(detail) && snapshot["builtYear"] === undefined);

  if (error) {
    return (
      <div className="rounded-lg border border-bad-500/40 bg-bad-500/10 px-4 py-3 text-xs text-bad-500">
        {error}
      </div>
    );
  }

  if (!detail) return <Spinner label="Reading the opportunity" />;

  const opportunity = detail.opportunity;
  const built = builtYearCell(snapshot, roll);

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
                Surfaced by the saved search{" "}
                <span className="text-ink-300">{detail.searchName}</span>.
              </p>
            )}
            <dl className="tabular mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <Row label="Assessed" value={money(opportunity.assessedValue)} />
              <Row label="Built" value={built.value} title={built.title} testId="deal-built-year" />
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
                  snapshot["yearsSinceLastSale"] !== null &&
                  snapshot["yearsSinceLastSale"] !== undefined
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
                  await load();
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
                      <p className="mt-1.5 text-[12px] font-medium text-ink-200">
                        {message.subject}
                      </p>
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
                                {future
                                  ? `scheduled ${when(event.occurredAt)}`
                                  : ago(event.occurredAt)}
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
                <TextArea
                  value={noteBody}
                  onChange={setNoteBody}
                  rows={2}
                  placeholder="What happened"
                />
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
                  await load();
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
                    <span className="shrink-0 text-[11px] text-ink-600">
                      {ago(event.createdAt)}
                    </span>
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

          <OwnerContactPanel owner={detail.owner} />

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
                  await load();
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
                        await load();
                      }}
                      className="size-3.5 accent-[var(--color-accent-500)]"
                    />
                    <span
                      className={
                        task.status === "done" ? "text-ink-600 line-through" : "text-ink-200"
                      }
                    >
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

function Row({
  label,
  value,
  title,
  testId,
}: {
  label: string;
  value: string;
  title?: string;
  testId?: string;
}) {
  return (
    <div className="flex gap-2" title={title}>
      <dt className="w-24 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink-200" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Who owns this parcel, and how an acquisitions team would reach them.
 *
 * The same two blocks the parcel drawer renders, deliberately not one. The
 * first is the county roll - the owner of record and the mailing address, which
 * are real and which carry the source system they were read from. The second is
 * the MOCKED skip trace, because the roll publishes no telephone and no email.
 *
 * This panel used to render `owner.email ?? "not on file"` and never look at
 * `skipTrace`, so the one screen a converted alert actually lands on was the
 * one screen that still said the owner had no contact details, while the drawer
 * and the CSV both showed them. Exported so a test can render it directly: an
 * assertion that the API returns the contact is what let that survive.
 */
export function OwnerContactPanel({ owner }: { owner: DetailOwner | null }) {
  if (!owner) {
    return (
      <Panel title="Owner contact">
        <p className="text-[11px] text-ink-500">
          No owner record. The county publishes an owner of record only for some parcels.
        </p>
      </Panel>
    );
  }

  const mailing =
    [owner.mailingAddress, owner.mailingCity, owner.mailingState, owner.mailingZip]
      .filter(Boolean)
      .join(", ") || "not published";

  return (
    <Panel
      title="Owner contact"
      subtitle="The roll publishes an owner and a mailing address. It publishes no telephone and no email."
    >
      <dl className="space-y-1 text-[11px]">
        <Row label="Owner of record" value={owner.name} />
        <Row label="Mailing" value={mailing} />
        <Row label="Address source" value={owner.sourceSystem ?? "not published"} />
      </dl>

      {/*
        A hospital and two churches reached the board through a residential
        thesis, because on the roll they own residential parcels. The deal page
        is where somebody decides to call, so it is where the app has to say
        that the owner of record is not a person.
      */}
      <div className="mt-2 empty:hidden">
        <OwnerKindBadge name={owner.name} />
      </div>

      {owner.skipTrace ? (
        <SimulatedContact contact={owner.skipTrace} className="mt-3" />
      ) : (
        <p className="mt-3 rounded-md border border-[var(--line)] px-2.5 py-2 text-[11px] leading-relaxed text-ink-400">
          No simulated contact is attached to this owner, so there is no telephone or email to show.
          Nothing here calls a skip-trace vendor.
        </p>
      )}

      {(owner.email || owner.phone) && (
        <dl className="mt-3 space-y-1 border-t border-[var(--line)] pt-2.5 text-[11px]">
          {owner.phone && <Row label="Phone (entered)" value={owner.phone} />}
          {owner.email && <Row label="Email (entered)" value={owner.email} />}
        </dl>
      )}
    </Panel>
  );
}
