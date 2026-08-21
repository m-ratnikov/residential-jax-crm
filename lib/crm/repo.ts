/**
 * Reads and writes against the CRM store.
 *
 * Every query the application makes against Postgres is here, so the API routes
 * stay thin and the invariants - one live opportunity per parcel, a stage change
 * always writes a stage event, an outreach status never walks backwards - live
 * in one place rather than being re-derived at each call site.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { criteriaSetSchema, type CriteriaSet } from "@/lib/criteria/types";
import { displayAddress } from "@/lib/data/map";
import type { PropertyRecord, ScoredProperty } from "@/lib/data/types";
import type { AcquisitionStage, OutreachChannel } from "@/lib/notify/types";
import { db, type CrmDatabase } from "./db";
import {
  alerts,
  matcherRuns,
  notes,
  notifications,
  opportunities,
  outreachCampaigns,
  outreachEvents,
  outreachMessages,
  owners,
  savedSearches,
  simulatedChanges,
  stageEvents,
  tasks,
  teamMembers,
} from "./schema";

/* ------------------------------------------------------------------ */
/* Team                                                                 */
/* ------------------------------------------------------------------ */

export async function listTeamMembers() {
  return db().select().from(teamMembers).orderBy(teamMembers.name);
}

/* ------------------------------------------------------------------ */
/* Saved searches                                                       */
/* ------------------------------------------------------------------ */

export async function listSavedSearches() {
  return db().select().from(savedSearches).orderBy(desc(savedSearches.createdAt));
}

export async function getSavedSearch(id: string) {
  const [row] = await db().select().from(savedSearches).where(eq(savedSearches.id, id)).limit(1);
  return row ?? null;
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

export async function createSavedSearch(input: SaveSearchInput) {
  const criteria = criteriaSetSchema.parse(input.criteria);
  const [row] = await db()
    .insert(savedSearches)
    .values({
      name: input.name,
      description: input.description ?? null,
      criteria,
      ownerId: input.ownerId ?? null,
      notifyInApp: input.notifyInApp ?? true,
      notifyEmail: input.notifyEmail ?? false,
      notifySms: input.notifySms ?? false,
      alertLimitPerRun: input.alertLimitPerRun ?? 25,
    })
    .returning();
  return row ?? null;
}

export async function updateSavedSearch(id: string, patch: Partial<SaveSearchInput> & { active?: boolean }) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.criteria !== undefined) values.criteria = criteriaSetSchema.parse(patch.criteria);
  if (patch.notifyInApp !== undefined) values.notifyInApp = patch.notifyInApp;
  if (patch.notifyEmail !== undefined) values.notifyEmail = patch.notifyEmail;
  if (patch.notifySms !== undefined) values.notifySms = patch.notifySms;
  if (patch.alertLimitPerRun !== undefined) values.alertLimitPerRun = patch.alertLimitPerRun;
  if (patch.active !== undefined) values.active = patch.active;

  const [row] = await db().update(savedSearches).set(values).where(eq(savedSearches.id, id)).returning();
  return row ?? null;
}

export async function deleteSavedSearch(id: string) {
  await db().delete(savedSearches).where(eq(savedSearches.id, id));
}

/* ------------------------------------------------------------------ */
/* Alerts                                                               */
/* ------------------------------------------------------------------ */

export interface AlertFilter {
  savedSearchId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export async function listAlerts(filter: AlertFilter = {}) {
  const conditions = [];
  if (filter.savedSearchId) conditions.push(eq(alerts.savedSearchId, filter.savedSearchId));
  if (filter.unreadOnly) conditions.push(isNull(alerts.readAt));

  return db()
    .select({
      alert: alerts,
      searchName: savedSearches.name,
      matcherTrigger: matcherRuns.trigger,
      matcherStartedAt: matcherRuns.startedAt,
    })
    .from(alerts)
    .leftJoin(savedSearches, eq(alerts.savedSearchId, savedSearches.id))
    .leftJoin(matcherRuns, eq(alerts.matcherRunId, matcherRuns.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(alerts.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
}

export async function getAlert(id: string) {
  const [row] = await db().select().from(alerts).where(eq(alerts.id, id)).limit(1);
  return row ?? null;
}

export async function listAlertNotifications(alertIds: readonly string[]) {
  if (!alertIds.length) return [];
  return db()
    .select()
    .from(notifications)
    .where(inArray(notifications.alertId, [...alertIds]))
    .orderBy(notifications.createdAt);
}

export async function markAlertRead(id: string, read = true) {
  const [row] = await db()
    .update(alerts)
    .set({ readAt: read ? new Date() : null })
    .where(eq(alerts.id, id))
    .returning();
  return row ?? null;
}

export async function markAllAlertsRead() {
  await db().update(alerts).set({ readAt: new Date() }).where(isNull(alerts.readAt));
}

export async function dismissAlert(id: string) {
  const [row] = await db()
    .update(alerts)
    .set({ dismissedAt: new Date() })
    .where(eq(alerts.id, id))
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Matcher evidence                                                     */
/* ------------------------------------------------------------------ */

export async function listMatcherRuns(limit = 25) {
  return db().select().from(matcherRuns).orderBy(desc(matcherRuns.startedAt)).limit(limit);
}

/* ------------------------------------------------------------------ */
/* Owners                                                               */
/* ------------------------------------------------------------------ */

/**
 * Owners of record are published on the roll, so the CRM upserts on the name
 * and mailing address rather than inventing an identity. Contact details a team
 * adds by hand are kept on the same row and never overwritten by a later roll
 * value.
 */
export async function upsertOwnerFromProperty(
  database: CrmDatabase,
  property: PropertyRecord,
): Promise<string | null> {
  if (!property.ownerName) return null;

  const [existing] = await database
    .select({ id: owners.id })
    .from(owners)
    .where(
      and(
        eq(owners.name, property.ownerName),
        property.ownerMailingAddress
          ? eq(owners.mailingAddress, property.ownerMailingAddress)
          : isNull(owners.mailingAddress),
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await database
    .insert(owners)
    .values({
      name: property.ownerName,
      mailingAddress: property.ownerMailingAddress,
      mailingCity: property.ownerMailingCity,
      mailingState: property.ownerMailingState,
      mailingZip: property.ownerMailingZip,
      sourceSystem: property.provenance.sourceSystem,
      sourceUrl: property.provenance.sourceUrl,
    })
    .returning({ id: owners.id });

  return created?.id ?? null;
}

export async function updateOwner(
  id: string,
  patch: { email?: string | null; phone?: string | null; notes?: string | null },
) {
  const [row] = await db().update(owners).set(patch).where(eq(owners.id, id)).returning();
  return row ?? null;
}

export async function getOwner(id: string) {
  const [row] = await db().select().from(owners).where(eq(owners.id, id)).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Opportunities                                                        */
/* ------------------------------------------------------------------ */

export interface CreateOpportunityInput {
  scored: ScoredProperty;
  savedSearchId?: string | null;
  alertId?: string | null;
  assigneeId?: string | null;
  actorId?: string | null;
}

/**
 * Convert a matched parcel into a tracked opportunity.
 *
 * Idempotent on the parcel: two analysts working the same alert feed must not
 * create two records for the same house. The second call returns the existing
 * opportunity and links the alert to it.
 */
export async function createOpportunity(input: CreateOpportunityInput) {
  const database = db();
  const property = input.scored.property;

  const [existing] = await database
    .select()
    .from(opportunities)
    .where(eq(opportunities.propertyId, property.propertyId))
    .limit(1);

  if (existing) {
    if (input.alertId) {
      await database
        .update(alerts)
        .set({ opportunityId: existing.id })
        .where(eq(alerts.id, input.alertId));
    }
    return { opportunity: existing, created: false };
  }

  const ownerId = await upsertOwnerFromProperty(database, property);

  const [created] = await database
    .insert(opportunities)
    .values({
      propertyId: property.propertyId,
      parcelIdentifier: property.parcelIdentifier,
      addressLine: displayAddress(property),
      addressCity: property.addressCity,
      addressZip: property.addressZip,
      latitude: property.latitude,
      longitude: property.longitude,
      assessedValue: property.assessedValue,
      ownerNameSnapshot: property.ownerName,
      propertySnapshot: {
        builtYear: property.builtYear,
        livableFloorArea: property.livableFloorArea,
        roofAgeYears: property.roofAgeYears,
        roofAgeBasis: property.roofAgeBasis,
        yearsSinceLastSale: property.yearsSinceLastSale,
        lastSaleDate: property.lastSaleDate,
        lastSalePrice: property.lastSalePrice,
        ownerOccupied: property.ownerOccupied,
        homesteadFlag: property.homesteadFlag,
        waterViewFlag: property.waterViewFlag,
        nearestTransitStopM: property.nearestTransitStopM,
        courtDistressScore: property.raw["court_distress_score"] ?? null,
        provenance: property.provenance,
      },
      ownerId,
      savedSearchId: input.savedSearchId ?? null,
      alertId: input.alertId ?? null,
      matchScore: input.scored.score,
      matchRationale: input.scored.rationale,
      assigneeId: input.assigneeId ?? null,
      stage: "identified",
    })
    .returning();

  if (!created) throw new Error("could not create the opportunity");

  await database.insert(stageEvents).values({
    opportunityId: created.id,
    fromStage: null,
    toStage: "identified",
    actorId: input.actorId ?? null,
    note: input.alertId ? "Created from an alert" : "Created from search",
  });

  if (input.alertId) {
    await database.update(alerts).set({ opportunityId: created.id }).where(eq(alerts.id, input.alertId));
  }

  return { opportunity: created, created: true };
}

export interface OpportunityFilter {
  stages?: readonly AcquisitionStage[];
  assigneeId?: string;
  savedSearchId?: string;
  minScore?: number;
  city?: string;
  limit?: number;
}

export async function listOpportunities(filter: OpportunityFilter = {}) {
  const conditions = [];
  if (filter.stages?.length) conditions.push(inArray(opportunities.stage, [...filter.stages]));
  if (filter.assigneeId) conditions.push(eq(opportunities.assigneeId, filter.assigneeId));
  if (filter.savedSearchId) conditions.push(eq(opportunities.savedSearchId, filter.savedSearchId));
  if (filter.minScore !== undefined)
    conditions.push(sql`${opportunities.matchScore} >= ${filter.minScore}`);
  if (filter.city) conditions.push(eq(opportunities.addressCity, filter.city));

  return db()
    .select({
      opportunity: opportunities,
      owner: owners,
      assignee: teamMembers,
      searchName: savedSearches.name,
    })
    .from(opportunities)
    .leftJoin(owners, eq(opportunities.ownerId, owners.id))
    .leftJoin(teamMembers, eq(opportunities.assigneeId, teamMembers.id))
    .leftJoin(savedSearches, eq(opportunities.savedSearchId, savedSearches.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(opportunities.matchScore), desc(opportunities.updatedAt))
    .limit(Math.min(filter.limit ?? 500, 2_000));
}

export async function getOpportunity(id: string) {
  const [row] = await db()
    .select({
      opportunity: opportunities,
      owner: owners,
      assignee: teamMembers,
      searchName: savedSearches.name,
    })
    .from(opportunities)
    .leftJoin(owners, eq(opportunities.ownerId, owners.id))
    .leftJoin(teamMembers, eq(opportunities.assigneeId, teamMembers.id))
    .leftJoin(savedSearches, eq(opportunities.savedSearchId, savedSearches.id))
    .where(eq(opportunities.id, id))
    .limit(1);
  return row ?? null;
}

export async function getOpportunityByProperty(propertyId: string) {
  const [row] = await db()
    .select()
    .from(opportunities)
    .where(eq(opportunities.propertyId, propertyId))
    .limit(1);
  return row ?? null;
}

export interface UpdateOpportunityInput {
  stage?: AcquisitionStage;
  assigneeId?: string | null;
  ownerInterest?: string | null;
  askingPrice?: number | null;
  offerPrice?: number | null;
  nextStep?: string | null;
  nextStepDueAt?: Date | null;
  actorId?: string | null;
  stageNote?: string | null;
}

/**
 * A stage change always writes a stage event. The history is what the story
 * asks to see, and reconstructing it from an updated_at column is not possible.
 */
export async function updateOpportunity(id: string, patch: UpdateOpportunityInput) {
  const database = db();
  const [current] = await database.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  if (!current) return null;

  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.assigneeId !== undefined) values.assigneeId = patch.assigneeId;
  if (patch.ownerInterest !== undefined) values.ownerInterest = patch.ownerInterest;
  if (patch.askingPrice !== undefined) values.askingPrice = patch.askingPrice;
  if (patch.offerPrice !== undefined) values.offerPrice = patch.offerPrice;
  if (patch.nextStep !== undefined) values.nextStep = patch.nextStep;
  if (patch.nextStepDueAt !== undefined) values.nextStepDueAt = patch.nextStepDueAt;

  const stageChanged = patch.stage !== undefined && patch.stage !== current.stage;
  if (patch.stage !== undefined) values.stage = patch.stage;
  if (stageChanged && (patch.stage === "closed" || patch.stage === "dead")) {
    values.closedAt = new Date();
  }
  if (stageChanged && patch.stage !== "closed" && patch.stage !== "dead") {
    values.closedAt = null;
  }

  const [updated] = await database
    .update(opportunities)
    .set(values)
    .where(eq(opportunities.id, id))
    .returning();

  if (stageChanged && patch.stage) {
    await database.insert(stageEvents).values({
      opportunityId: id,
      fromStage: current.stage,
      toStage: patch.stage,
      actorId: patch.actorId ?? null,
      note: patch.stageNote ?? null,
    });
  }

  return updated ?? null;
}

export async function listStageEvents(opportunityId: string) {
  return db()
    .select({ event: stageEvents, actor: teamMembers })
    .from(stageEvents)
    .leftJoin(teamMembers, eq(stageEvents.actorId, teamMembers.id))
    .where(eq(stageEvents.opportunityId, opportunityId))
    .orderBy(desc(stageEvents.createdAt));
}

/* ------------------------------------------------------------------ */
/* Notes and tasks                                                      */
/* ------------------------------------------------------------------ */

export async function addNote(opportunityId: string, body: string, authorId: string | null) {
  const [row] = await db().insert(notes).values({ opportunityId, body, authorId }).returning();
  return row ?? null;
}

export async function listNotes(opportunityId: string) {
  return db()
    .select({ note: notes, author: teamMembers })
    .from(notes)
    .leftJoin(teamMembers, eq(notes.authorId, teamMembers.id))
    .where(eq(notes.opportunityId, opportunityId))
    .orderBy(desc(notes.createdAt));
}

export async function addTask(input: {
  opportunityId: string;
  title: string;
  assigneeId?: string | null;
  dueAt?: Date | null;
}) {
  const [row] = await db()
    .insert(tasks)
    .values({
      opportunityId: input.opportunityId,
      title: input.title,
      assigneeId: input.assigneeId ?? null,
      dueAt: input.dueAt ?? null,
    })
    .returning();
  return row ?? null;
}

export async function setTaskStatus(id: string, status: "open" | "done" | "cancelled") {
  const [row] = await db()
    .update(tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(eq(tasks.id, id))
    .returning();
  return row ?? null;
}

export async function listTasks(opportunityId: string) {
  return db()
    .select({ task: tasks, assignee: teamMembers })
    .from(tasks)
    .leftJoin(teamMembers, eq(tasks.assigneeId, teamMembers.id))
    .where(eq(tasks.opportunityId, opportunityId))
    .orderBy(tasks.status, tasks.dueAt);
}

export async function listOpenTasks(limit = 50) {
  return db()
    .select({ task: tasks, assignee: teamMembers, opportunity: opportunities })
    .from(tasks)
    .leftJoin(teamMembers, eq(tasks.assigneeId, teamMembers.id))
    .leftJoin(opportunities, eq(tasks.opportunityId, opportunities.id))
    .where(eq(tasks.status, "open"))
    .orderBy(tasks.dueAt)
    .limit(limit);
}

/* ------------------------------------------------------------------ */
/* Outreach                                                             */
/* ------------------------------------------------------------------ */

export async function listOutreach(opportunityId: string) {
  const messages = await db()
    .select()
    .from(outreachMessages)
    .where(eq(outreachMessages.opportunityId, opportunityId))
    .orderBy(desc(outreachMessages.createdAt));

  if (!messages.length) return [];

  const events = await db()
    .select()
    .from(outreachEvents)
    .where(
      inArray(
        outreachEvents.messageId,
        messages.map((message) => message.id),
      ),
    )
    .orderBy(outreachEvents.occurredAt);

  return messages.map((message) => ({
    message,
    events: events.filter((event) => event.messageId === message.id),
  }));
}

export async function listCampaigns(limit = 50) {
  return db()
    .select({
      campaign: outreachCampaigns,
      messageCount: sql<number>`count(${outreachMessages.id})::int`,
    })
    .from(outreachCampaigns)
    .leftJoin(outreachMessages, eq(outreachMessages.campaignId, outreachCampaigns.id))
    .groupBy(outreachCampaigns.id)
    .orderBy(desc(outreachCampaigns.createdAt))
    .limit(limit);
}

/* ------------------------------------------------------------------ */
/* Dashboard aggregates                                                 */
/* ------------------------------------------------------------------ */

export interface PipelineFunnel {
  stage: AcquisitionStage;
  count: number;
  value: number;
}

export async function stageFunnel(): Promise<PipelineFunnel[]> {
  const rows = await db()
    .select({
      stage: opportunities.stage,
      count: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${opportunities.assessedValue}), 0)::float8`,
    })
    .from(opportunities)
    .groupBy(opportunities.stage);

  return rows.map((row) => ({
    stage: row.stage as AcquisitionStage,
    count: row.count,
    value: row.value,
  }));
}

export async function outreachStatusBreakdown() {
  return db()
    .select({
      channel: outreachMessages.channel,
      status: outreachMessages.status,
      count: sql<number>`count(*)::int`,
    })
    .from(outreachMessages)
    .groupBy(outreachMessages.channel, outreachMessages.status);
}

/* ------------------------------------------------------------------ */
/* Simulated changes                                                    */
/* ------------------------------------------------------------------ */

export async function listSimulatedChanges() {
  return db().select().from(simulatedChanges).orderBy(desc(simulatedChanges.createdAt));
}

export async function clearSimulatedChanges() {
  await db().delete(simulatedChanges);
}

export type { OutreachChannel };
