/**
 * Reads and writes against the CRM store.
 *
 * Every access the application makes to CRM state is here, so the routes stay
 * thin and the invariants live in one place rather than being re-derived at each
 * call site.
 *
 * Filtering and sorting happen in TypeScript rather than in a query language,
 * because these collections are small and bounded by what a team creates:
 * hundreds of opportunities, not hundreds of thousands. The 404,023 parcels are
 * on the other side of the system entirely, queried with DuckDB, and never
 * copied here. That asymmetry is the whole design.
 */

import { criteriaSetSchema, type CriteriaSet } from "@/lib/criteria/types";
import type { AcquisitionStage } from "@/lib/notify/types";
import { crmStore } from "./db";
import {
  newId,
  nowIso,
  type AlertDoc,
  type CourtDoc,
  type MatcherRunDoc,
  type NoteDoc,
  type OpportunityDoc,
  type OutreachEventDoc,
  type OutreachMessageDoc,
  type OwnerDoc,
  type SavedSearchDoc,
  type SimulatedDoc,
  type StageEventDoc,
  type TaskDoc,
  type TeamMemberDoc,
} from "./documents";
import { documentId } from "./store";

/** Newest first, on an ISO timestamp field. */
function byNewest<T>(pick: (item: T) => string | null): (a: T, b: T) => number {
  return (a, b) => {
    const left = pick(a) ?? "";
    const right = pick(b) ?? "";
    return left < right ? 1 : left > right ? -1 : 0;
  };
}

/* ------------------------------------------------------------------ */
/* Team                                                                 */
/* ------------------------------------------------------------------ */

export async function listTeamMembers(): Promise<TeamMemberDoc[]> {
  const members = await crmStore().list<TeamMemberDoc>("team");
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createTeamMember(input: {
  name: string;
  email: string;
  role?: string;
}): Promise<TeamMemberDoc> {
  const member: TeamMemberDoc = {
    id: newId(),
    name: input.name,
    email: input.email,
    role: input.role ?? "acquisitions",
    createdAt: nowIso(),
  };
  return crmStore().put("team", member);
}

/* ------------------------------------------------------------------ */
/* Saved searches                                                       */
/* ------------------------------------------------------------------ */

export async function listSavedSearches(): Promise<SavedSearchDoc[]> {
  const searches = await crmStore().list<SavedSearchDoc>("searches");
  return searches.sort(byNewest((search) => search.createdAt));
}

/**
 * A saved search as a list needs it: everything except the tracked matches.
 *
 * `matches` holds a snapshot per watched parcel - up to 2,000 of them, sixteen
 * fields each - because that is what the next pass diffs against. It is state
 * the matcher needs and nothing on screen ever shows, and sending it made
 * `GET /api/searches` a 3.5 MB response that every page listing criteria paid
 * for, on every load, to display a handful of counts.
 *
 * `matchesTruncated` and `lastMatchCount` survive, because those two ARE shown:
 * they are how the cap is disclosed next to the number it applies to.
 */
export type SavedSearchListItem = Omit<SavedSearchDoc, "matches">;

export async function listSavedSearchesForDisplay(): Promise<SavedSearchListItem[]> {
  const searches = await listSavedSearches();
  return searches.map(({ matches: _matches, ...rest }) => rest);
}

export async function getSavedSearch(id: string): Promise<SavedSearchDoc | null> {
  return crmStore().get<SavedSearchDoc>("searches", id);
}

export interface SaveSearchInput {
  name: string;
  description?: string | null;
  criteria: CriteriaSet;
  ownerId?: string | null;
  notifyInApp?: boolean;
  notifyEmail?: boolean;
  notifySms?: boolean;
  alertLimitPerRun?: number;
}

export async function createSavedSearch(input: SaveSearchInput): Promise<SavedSearchDoc> {
  const criteria = criteriaSetSchema.parse(input.criteria);
  const now = nowIso();
  const search: SavedSearchDoc = {
    id: newId(),
    name: input.name,
    description: input.description ?? null,
    criteria,
    ownerId: input.ownerId ?? null,
    notifyInApp: input.notifyInApp ?? true,
    notifyEmail: input.notifyEmail ?? false,
    notifySms: input.notifySms ?? false,
    active: true,
    alertLimitPerRun: input.alertLimitPerRun ?? 25,
    lastEvaluatedAt: null,
    lastPipelineRunId: null,
    lastMatchCount: null,
    matches: {},
    matchesTruncated: false,
    createdAt: now,
    updatedAt: now,
  };
  return crmStore().put("searches", search);
}

export async function updateSavedSearch(
  id: string,
  patch: Partial<SaveSearchInput> & { active?: boolean },
): Promise<SavedSearchDoc | null> {
  const existing = await getSavedSearch(id);
  if (!existing) return null;

  const next: SavedSearchDoc = {
    ...existing,
    name: patch.name ?? existing.name,
    description:
      patch.description === undefined ? existing.description : (patch.description ?? null),
    criteria: patch.criteria ? criteriaSetSchema.parse(patch.criteria) : existing.criteria,
    notifyInApp: patch.notifyInApp ?? existing.notifyInApp,
    notifyEmail: patch.notifyEmail ?? existing.notifyEmail,
    notifySms: patch.notifySms ?? existing.notifySms,
    alertLimitPerRun: patch.alertLimitPerRun ?? existing.alertLimitPerRun,
    active: patch.active ?? existing.active,
    updatedAt: nowIso(),
  };
  return crmStore().put("searches", next);
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await crmStore().remove("searches", id);
}

/* ------------------------------------------------------------------ */
/* Alerts                                                               */
/* ------------------------------------------------------------------ */

/**
 * One alert per (search, parcel, pass). The key IS the constraint, so a matcher
 * retried after a timeout writes the same document rather than a second alert.
 */
export function alertId(matcherRunId: string, savedSearchId: string, propertyId: string): string {
  return documentId(matcherRunId, savedSearchId, propertyId);
}

export interface AlertFilter {
  savedSearchId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export async function listAlerts(filter: AlertFilter = {}): Promise<AlertDoc[]> {
  const alerts = await crmStore().list<AlertDoc>("alerts");
  return alerts
    .filter((alert) => !filter.savedSearchId || alert.savedSearchId === filter.savedSearchId)
    .filter((alert) => !filter.unreadOnly || alert.readAt === null)
    .filter((alert) => alert.dismissedAt === null)
    .sort(byNewest((alert) => alert.createdAt))
    .slice(0, Math.min(filter.limit ?? 100, 500));
}

export async function getAlert(id: string): Promise<AlertDoc | null> {
  return crmStore().get<AlertDoc>("alerts", id);
}

export async function markAlertRead(id: string, read = true): Promise<AlertDoc | null> {
  const alert = await getAlert(id);
  if (!alert) return null;
  return crmStore().put("alerts", { ...alert, readAt: read ? nowIso() : null });
}

export async function markAllAlertsRead(): Promise<number> {
  const alerts = await crmStore().list<AlertDoc>("alerts");
  const unread = alerts.filter((alert) => alert.readAt === null);
  const at = nowIso();
  for (const alert of unread) await crmStore().put("alerts", { ...alert, readAt: at });
  return unread.length;
}

export async function dismissAlert(id: string): Promise<AlertDoc | null> {
  const alert = await getAlert(id);
  if (!alert) return null;
  return crmStore().put("alerts", { ...alert, dismissedAt: nowIso() });
}

export async function unreadAlertCount(): Promise<number> {
  const alerts = await crmStore().list<AlertDoc>("alerts");
  return alerts.filter((alert) => alert.readAt === null && alert.dismissedAt === null).length;
}

/* ------------------------------------------------------------------ */
/* Matcher evidence                                                     */
/* ------------------------------------------------------------------ */

export async function listMatcherRuns(limit = 25): Promise<MatcherRunDoc[]> {
  const runs = await crmStore().list<MatcherRunDoc>("matcher-runs");
  return runs.sort(byNewest((run) => run.startedAt)).slice(0, limit);
}

export async function hasSeenPipelineRun(pipelineRunId: string): Promise<boolean> {
  const runs = await crmStore().list<MatcherRunDoc>("matcher-runs");
  return runs.some((run) => run.pipelineRunId === pipelineRunId);
}

/* ------------------------------------------------------------------ */
/* Owners                                                               */
/* ------------------------------------------------------------------ */

export async function getOwner(id: string): Promise<OwnerDoc | null> {
  return crmStore().get<OwnerDoc>("owners", id);
}

export async function updateOwner(
  id: string,
  patch: { email?: string | null; phone?: string | null; notes?: string | null },
): Promise<OwnerDoc | null> {
  const owner = await getOwner(id);
  if (!owner) return null;
  return crmStore().put("owners", {
    ...owner,
    email: patch.email === undefined ? owner.email : patch.email,
    phone: patch.phone === undefined ? owner.phone : patch.phone,
    notes: patch.notes === undefined ? owner.notes : patch.notes,
  });
}

/**
 * Owners of record are published on the roll, so this upserts on the name and
 * mailing address rather than inventing an identity. Contact details a team adds
 * by hand live on the same document and are never overwritten by a later roll
 * value.
 */
async function upsertOwner(input: CreateOpportunityInput): Promise<string | null> {
  if (!input.ownerName) return null;

  const owners = await crmStore().list<OwnerDoc>("owners");
  const existing = owners.find(
    (owner) =>
      owner.name === input.ownerName &&
      (owner.mailingAddress ?? null) === (input.ownerMailingAddress ?? null),
  );
  if (existing) return existing.id;

  const owner: OwnerDoc = {
    id: newId(),
    name: input.ownerName,
    mailingAddress: input.ownerMailingAddress ?? null,
    mailingCity: input.ownerMailingCity ?? null,
    mailingState: input.ownerMailingState ?? null,
    mailingZip: input.ownerMailingZip ?? null,
    email: null,
    phone: null,
    sourceSystem: input.sourceSystem ?? null,
    sourceUrl: input.sourceUrl ?? null,
    notes: null,
    createdAt: nowIso(),
  };
  await crmStore().put("owners", owner);
  return owner.id;
}

/* ------------------------------------------------------------------ */
/* Opportunities                                                        */
/* ------------------------------------------------------------------ */

/**
 * A parcel as the client read it, plus why it is being tracked.
 *
 * The browser holds the query engine, so it holds the authoritative record. The
 * owner of record and the provenance travel with it so the CRM can create the
 * owner document and keep the audit trail without a second read.
 */
export interface CreateOpportunityInput {
  propertyId: string;
  parcelIdentifier?: string | null;
  addressLine: string;
  addressCity?: string | null;
  addressZip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  assessedValue?: number | null;
  ownerName?: string | null;
  ownerMailingAddress?: string | null;
  ownerMailingCity?: string | null;
  ownerMailingState?: string | null;
  ownerMailingZip?: string | null;
  sourceSystem?: string | null;
  sourceUrl?: string | null;
  propertySnapshot?: Record<string, unknown>;

  matchScore?: number | null;
  matchRationale?: string | null;
  savedSearchId?: string | null;
  alertId?: string | null;
  assigneeId?: string | null;
  actorId?: string | null;
}

export async function getOpportunity(propertyId: string): Promise<OpportunityDoc | null> {
  return crmStore().get<OpportunityDoc>("opportunities", propertyId);
}

/**
 * Convert a matched parcel into a tracked opportunity.
 *
 * Idempotent on the parcel because the document key IS the parcel: two analysts
 * working the same alert feed cannot create two records for the same house. The
 * second call returns the existing opportunity and links the alert to it.
 */
export async function createOpportunityFromSnapshot(
  input: CreateOpportunityInput,
): Promise<{ opportunity: OpportunityDoc; created: boolean }> {
  const existing = await getOpportunity(input.propertyId);

  if (existing) {
    if (input.alertId) await linkAlertToOpportunity(input.alertId, existing.id);
    return { opportunity: existing, created: false };
  }

  const ownerId = await upsertOwner(input);
  const now = nowIso();

  const opportunity: OpportunityDoc = {
    id: input.propertyId,
    propertyId: input.propertyId,
    parcelIdentifier: input.parcelIdentifier ?? null,
    addressLine: input.addressLine,
    addressCity: input.addressCity ?? null,
    addressZip: input.addressZip ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    assessedValue: input.assessedValue ?? null,
    ownerNameSnapshot: input.ownerName ?? null,
    propertySnapshot: input.propertySnapshot ?? {},
    ownerId,
    stage: "identified",
    savedSearchId: input.savedSearchId ?? null,
    alertId: input.alertId ?? null,
    matchScore: input.matchScore ?? null,
    matchRationale: input.matchRationale ?? null,
    assigneeId: input.assigneeId ?? null,
    ownerInterest: null,
    askingPrice: null,
    offerPrice: null,
    nextStep: null,
    nextStepDueAt: null,
    stageEvents: [
      {
        id: newId(),
        fromStage: null,
        toStage: "identified",
        actorId: input.actorId ?? null,
        note: input.alertId ? "Created from an alert" : "Created from search",
        createdAt: now,
      },
    ],
    notes: [],
    tasks: [],
    outreach: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };

  await crmStore().put("opportunities", opportunity);
  if (input.alertId) await linkAlertToOpportunity(input.alertId, opportunity.id);

  return { opportunity, created: true };
}

async function linkAlertToOpportunity(id: string, opportunityId: string): Promise<void> {
  const alert = await getAlert(id);
  if (!alert || alert.opportunityId === opportunityId) return;
  await crmStore().put("alerts", { ...alert, opportunityId });
}

export interface OpportunityFilter {
  stages?: readonly AcquisitionStage[];
  assigneeId?: string;
  savedSearchId?: string;
  minScore?: number;
  city?: string;
  limit?: number;
}

export interface OpportunityView {
  opportunity: OpportunityDoc;
  owner: OwnerDoc | null;
  assignee: TeamMemberDoc | null;
  searchName: string | null;
}

/**
 * One opportunity with its activity resolved against the team.
 *
 * The store keeps stage events, notes, tasks and the outreach thread inside the
 * opportunity document, each referring to a person by id. The detail page wants
 * them beside the deal with the person attached, so the join happens once here
 * rather than in the component - and, more to the point, so the shape the page
 * reads is a shape something returns. It previously was not: the page read
 * `detail.notes` while the API answered with them nested inside `opportunity`,
 * and because `api<Detail>()` is an unchecked cast, `tsc` saw nothing and every
 * opportunity page crashed on `undefined.length` in production.
 */
export interface OpportunityDetail extends OpportunityView {
  stageEvents: {
    event: StageEventDoc;
    actor: TeamMemberDoc | null;
  }[];
  notes: { note: NoteDoc; author: TeamMemberDoc | null }[];
  tasks: { task: TaskDoc; assignee: TeamMemberDoc | null }[];
  outreach: { message: OutreachMessageDoc; events: OutreachEventDoc[] }[];
}

/** Joined in memory, which is what a document store trades a JOIN for. */
export async function listOpportunities(
  filter: OpportunityFilter = {},
): Promise<OpportunityView[]> {
  const store = crmStore();
  const [opportunities, owners, team, searches] = await Promise.all([
    store.list<OpportunityDoc>("opportunities"),
    store.list<OwnerDoc>("owners"),
    store.list<TeamMemberDoc>("team"),
    store.list<SavedSearchDoc>("searches"),
  ]);

  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const memberById = new Map(team.map((member) => [member.id, member]));
  const searchById = new Map(searches.map((search) => [search.id, search]));

  return opportunities
    .filter((row) => !filter.stages?.length || filter.stages.includes(row.stage))
    .filter((row) => !filter.assigneeId || row.assigneeId === filter.assigneeId)
    .filter((row) => !filter.savedSearchId || row.savedSearchId === filter.savedSearchId)
    .filter((row) => filter.minScore === undefined || (row.matchScore ?? 0) >= filter.minScore)
    .filter((row) => !filter.city || (row.addressCity ?? "") === filter.city)
    .sort((a, b) => {
      const score = (b.matchScore ?? 0) - (a.matchScore ?? 0);
      return score !== 0 ? score : b.updatedAt < a.updatedAt ? -1 : 1;
    })
    .slice(0, Math.min(filter.limit ?? 500, 2_000))
    .map((opportunity) => ({
      opportunity,
      owner: opportunity.ownerId ? (ownerById.get(opportunity.ownerId) ?? null) : null,
      assignee: opportunity.assigneeId ? (memberById.get(opportunity.assigneeId) ?? null) : null,
      searchName: opportunity.savedSearchId
        ? (searchById.get(opportunity.savedSearchId)?.name ?? null)
        : null,
    }));
}

export async function getOpportunityView(propertyId: string): Promise<OpportunityDetail | null> {
  const opportunity = await getOpportunity(propertyId);
  if (!opportunity) return null;

  const store = crmStore();
  const [owner, team, search] = await Promise.all([
    opportunity.ownerId ? store.get<OwnerDoc>("owners", opportunity.ownerId) : null,
    store.list<TeamMemberDoc>("team"),
    opportunity.savedSearchId
      ? store.get<SavedSearchDoc>("searches", opportunity.savedSearchId)
      : null,
  ]);

  const person = (id: string | null): TeamMemberDoc | null =>
    id ? (team.find((member) => member.id === id) ?? null) : null;

  return {
    opportunity,
    owner: owner ?? null,
    assignee: person(opportunity.assigneeId),
    searchName: search?.name ?? null,
    // Newest first for the things a reader scans, oldest first for the stage
    // history, which only makes sense read forwards.
    stageEvents: [...opportunity.stageEvents]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((event) => ({ event, actor: person(event.actorId) })),
    notes: [...opportunity.notes]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((note) => ({ note, author: person(note.authorId) })),
    tasks: [...opportunity.tasks]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((task) => ({ task, assignee: person(task.assigneeId) })),
    outreach: [...opportunity.outreach]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((message) => ({ message, events: message.events })),
  };
}

export interface UpdateOpportunityInput {
  stage?: AcquisitionStage;
  assigneeId?: string | null;
  ownerInterest?: string | null;
  askingPrice?: number | null;
  offerPrice?: number | null;
  nextStep?: string | null;
  nextStepDueAt?: string | null;
  actorId?: string | null;
  stageNote?: string | null;
}

/**
 * A stage change always appends a stage event. The history is what the story
 * asks to see, and reconstructing it from an updatedAt field is not possible.
 */
export async function updateOpportunity(
  propertyId: string,
  patch: UpdateOpportunityInput,
): Promise<OpportunityDoc | null> {
  const current = await getOpportunity(propertyId);
  if (!current) return null;

  const stageChanged = patch.stage !== undefined && patch.stage !== current.stage;
  const now = nowIso();

  const next: OpportunityDoc = {
    ...current,
    stage: patch.stage ?? current.stage,
    assigneeId: patch.assigneeId === undefined ? current.assigneeId : patch.assigneeId,
    ownerInterest: patch.ownerInterest === undefined ? current.ownerInterest : patch.ownerInterest,
    askingPrice: patch.askingPrice === undefined ? current.askingPrice : patch.askingPrice,
    offerPrice: patch.offerPrice === undefined ? current.offerPrice : patch.offerPrice,
    nextStep: patch.nextStep === undefined ? current.nextStep : patch.nextStep,
    nextStepDueAt: patch.nextStepDueAt === undefined ? current.nextStepDueAt : patch.nextStepDueAt,
    updatedAt: now,
    closedAt: stageChanged
      ? patch.stage === "closed" || patch.stage === "dead"
        ? now
        : null
      : current.closedAt,
    stageEvents: stageChanged
      ? [
          ...current.stageEvents,
          {
            id: newId(),
            fromStage: current.stage,
            toStage: patch.stage as AcquisitionStage,
            actorId: patch.actorId ?? null,
            note: patch.stageNote ?? null,
            createdAt: now,
          },
        ]
      : current.stageEvents,
  };

  return crmStore().put("opportunities", next);
}

/* ------------------------------------------------------------------ */
/* Notes and tasks                                                      */
/* ------------------------------------------------------------------ */

export async function addNote(
  propertyId: string,
  body: string,
  authorId: string | null,
): Promise<OpportunityDoc | null> {
  const current = await getOpportunity(propertyId);
  if (!current) return null;
  return crmStore().put("opportunities", {
    ...current,
    notes: [...current.notes, { id: newId(), authorId, body, createdAt: nowIso() }],
    updatedAt: nowIso(),
  });
}

export async function addTask(input: {
  propertyId: string;
  title: string;
  assigneeId?: string | null;
  dueAt?: string | null;
}): Promise<OpportunityDoc | null> {
  const current = await getOpportunity(input.propertyId);
  if (!current) return null;
  return crmStore().put("opportunities", {
    ...current,
    tasks: [
      ...current.tasks,
      {
        id: newId(),
        title: input.title,
        assigneeId: input.assigneeId ?? null,
        status: "open" as const,
        dueAt: input.dueAt ?? null,
        completedAt: null,
        createdAt: nowIso(),
      },
    ],
    updatedAt: nowIso(),
  });
}

export async function setTaskStatus(
  propertyId: string,
  taskId: string,
  status: "open" | "done" | "cancelled",
): Promise<OpportunityDoc | null> {
  const current = await getOpportunity(propertyId);
  if (!current) return null;
  return crmStore().put("opportunities", {
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId
        ? { ...task, status, completedAt: status === "done" ? nowIso() : null }
        : task,
    ),
    updatedAt: nowIso(),
  });
}

/* ------------------------------------------------------------------ */
/* Court records and simulation                                         */
/* ------------------------------------------------------------------ */

export async function listCourtRecords(propertyId: string): Promise<CourtDoc | null> {
  return crmStore().get<CourtDoc>("court", propertyId);
}

export async function listSimulatedChanges(): Promise<SimulatedDoc[]> {
  const changes = await crmStore().list<SimulatedDoc>("simulated");
  return changes.sort(byNewest((change) => change.createdAt));
}

/* ------------------------------------------------------------------ */
/* Dashboard aggregates                                                 */
/* ------------------------------------------------------------------ */

export interface StageFunnelRow {
  stage: AcquisitionStage;
  count: number;
  value: number;
}

export async function stageFunnel(): Promise<StageFunnelRow[]> {
  const opportunities = await crmStore().list<OpportunityDoc>("opportunities");
  const byStage = new Map<AcquisitionStage, StageFunnelRow>();

  for (const opportunity of opportunities) {
    const row = byStage.get(opportunity.stage) ?? {
      stage: opportunity.stage,
      count: 0,
      value: 0,
    };
    row.count += 1;
    row.value += opportunity.assessedValue ?? 0;
    byStage.set(opportunity.stage, row);
  }

  return [...byStage.values()];
}
