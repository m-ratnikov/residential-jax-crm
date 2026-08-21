/**
 * The stored shapes.
 *
 * One document per aggregate, and the document id carries the invariant that a
 * relational schema would have spent a unique index on:
 *
 * - `opportunities/<propertyId>` - one live opportunity per parcel, structurally.
 * - `alerts/<run>__<search>__<parcel>` - one alert per pass, so a retried
 *   matcher cannot double notify.
 * - `court/<propertyId>` and `simulated/<propertyId>` - one document per parcel.
 *
 * Aggregates are stored whole. An opportunity carries its stage history, notes,
 * tasks and outreach thread, so reading a deal is one read and there is no join
 * to get wrong. That is only reasonable because these are small and bounded: a
 * deal has tens of events, not thousands.
 *
 * The one document that can get large is a saved search, which holds the match
 * snapshot the matcher diffs against. It is capped, and the cap is recorded.
 */

import type { CriteriaSet } from "@/lib/criteria/types";
import type { AcquisitionStage, OutreachChannel, OutreachStatus } from "@/lib/notify/types";

export interface TeamMemberDoc {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

/** What the matcher saw for one parcel last pass. */
export interface MatchSnapshot {
  matchHash: string;
  snapshot: Record<string, unknown>;
  score: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRunId: string | null;
  /**
   * The published artifact these values were read from.
   *
   * Distinct from `lastRunId`, which is the pass. Two passes reading the same
   * artifact must agree, so this is what makes "nothing can have changed"
   * checkable rather than assumed. Optional because documents written before
   * this existed do not carry it; those fall back to comparing fingerprints.
   */
  artifactRunId?: string | null;
}

export interface SavedSearchDoc {
  id: string;
  name: string;
  description: string | null;
  criteria: CriteriaSet;
  ownerId: string | null;

  notifyInApp: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  active: boolean;

  /**
   * Most alerts one pass will raise for this search. A criteria set matching
   * forty thousand parcels is a legitimate thing to save and a terrible thing to
   * be notified about one row at a time.
   */
  alertLimitPerRun: number;

  lastEvaluatedAt: string | null;
  lastPipelineRunId: string | null;
  lastMatchCount: number | null;

  /** propertyId -> what was observed. The other half of the diff. */
  matches: Record<string, MatchSnapshot>;
  /** True when the tracked set was capped, so a reader knows the diff is partial. */
  matchesTruncated: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface NotificationDoc {
  id: string;
  channel: "in_app" | "email" | "sms" | "push";
  recipient: string | null;
  status: OutreachStatus;
  providerMessageId: string | null;
  subject: string | null;
  body: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface AlertDoc {
  id: string;
  savedSearchId: string;
  matcherRunId: string;
  kind: "new_match" | "updated_match" | "left_match";
  propertyId: string;
  propertySnapshot: Record<string, unknown>;
  score: number;
  rationale: string;
  changedFields: string[];
  pipelineRunId: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  opportunityId: string | null;
  createdAt: string;
  notifications: NotificationDoc[];
}

export interface MatcherRunDoc {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  pipelineRunId: string | null;
  pipelineRunStartedAt: string | null;
  pipelineRunIsNew: boolean;

  dataSourceKind: string | null;
  dataSourceLocation: string | null;
  dataSourceRowCount: number | null;
  dataSourceIsSample: boolean | null;

  searchesEvaluated: number;
  propertiesEvaluated: number;
  alertsCreated: number;
  alertsSuppressed: number;
  notificationsSent: number;

  detail: unknown;
  error: string | null;
}

export interface OwnerDoc {
  id: string;
  name: string;
  mailingAddress: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  /** Added by hand. Never from the county roll, and never overwritten by it. */
  email: string | null;
  phone: string | null;
  sourceSystem: string | null;
  sourceUrl: string | null;
  notes: string | null;
  createdAt: string;
}

export interface StageEventDoc {
  id: string;
  fromStage: AcquisitionStage | null;
  toStage: AcquisitionStage;
  actorId: string | null;
  note: string | null;
  createdAt: string;
}

export interface NoteDoc {
  id: string;
  authorId: string | null;
  body: string;
  createdAt: string;
}

export interface TaskDoc {
  id: string;
  title: string;
  assigneeId: string | null;
  status: "open" | "done" | "cancelled";
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface OutreachEventDoc {
  /** The provider's own event id. Applying the same event twice is a no-op. */
  providerEventId: string;
  status: OutreachStatus;
  detail: string | null;
  occurredAt: string;
}

export interface OutreachMessageDoc {
  id: string;
  campaignId: string | null;
  campaignName: string | null;
  channel: OutreachChannel;
  templateId: string;
  toAddress: string;
  subject: string | null;
  body: string;
  providerMessageId: string;
  status: OutreachStatus;
  statusAt: string;
  createdById: string | null;
  createdAt: string;
  events: OutreachEventDoc[];
}

export interface OpportunityDoc {
  /** Equal to propertyId: one live opportunity per parcel, by construction. */
  id: string;
  propertyId: string;
  parcelIdentifier: string | null;

  addressLine: string;
  addressCity: string | null;
  addressZip: string | null;
  latitude: number | null;
  longitude: number | null;
  assessedValue: number | null;
  ownerNameSnapshot: string | null;
  propertySnapshot: Record<string, unknown>;

  ownerId: string | null;
  stage: AcquisitionStage;

  savedSearchId: string | null;
  alertId: string | null;
  matchScore: number | null;
  matchRationale: string | null;

  assigneeId: string | null;
  ownerInterest: string | null;
  askingPrice: number | null;
  offerPrice: number | null;
  nextStep: string | null;
  nextStepDueAt: string | null;

  stageEvents: StageEventDoc[];
  notes: NoteDoc[];
  tasks: TaskDoc[];
  outreach: OutreachMessageDoc[];

  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CourtRecordDoc {
  caseNumber: string;
  caseType: string;
  filedDate: string | null;
  partyName: string | null;
  amount: number | null;
  status: string | null;
  sourceSystem: string;
  sourceUrl: string | null;
  fetchedAt: string;
}

export interface CourtDoc {
  /** Equal to propertyId. */
  id: string;
  propertyId: string;
  parcelIdentifier: string | null;
  records: CourtRecordDoc[];
}

export interface SimulatedDoc {
  /** Equal to propertyId. */
  id: string;
  propertyId: string;
  runId: string;
  label: string | null;
  /** Column name -> replacement value, applied by the query overlay. */
  values: Record<string, string | null>;
  createdAt: string;
}

/** A short, sortable, collision-resistant id. Time-prefixed so listings sort naturally. */
export function newId(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
