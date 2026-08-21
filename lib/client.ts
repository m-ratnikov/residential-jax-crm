/**
 * Browser-side types and fetch helpers.
 *
 * One place that knows how the API reports a problem, so every page renders the
 * "no CRM store attached" case the same way instead of each one inventing its
 * own error banner.
 */

"use client";

import type { CriteriaSet } from "@/lib/criteria/types";
import type { Provenance, ScoreComponent } from "@/lib/data/types";
import type { AcquisitionStage, OutreachChannel, OutreachStatus } from "@/lib/notify/types";

export interface SearchRow {
  propertyId: string;
  address: string;
  city: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  ownerName: string | null;
  ownerOccupied: boolean | null;
  ownerRegionClass: string | null;
  assessedValue: number | null;
  marketValue: number | null;
  builtYear: number | null;
  livableFloorArea: number | null;
  roofAgeYears: number | null;
  roofAgeBasis: string | null;
  yearsSinceLastSale: number | null;
  lastSaleDate: string | null;
  tenureBasis: string | null;
  waterViewFlag: boolean | null;
  nearestTransitStopM: number | null;
  courtDistressScore: number | null;
  courtLienCount: number | null;
  courtForeclosureCount: number | null;
  simulated: boolean;
  score: number;
  rationale: string;
  components: ScoreComponent[];
  provenance: Provenance;
  opportunityId: string | null;
}

export interface SearchResponse {
  total: number;
  returned: number;
  offset: number;
  rows: SearchRow[];
  map: {
    points: { id: string; lat: number; lng: number; score: number }[];
    truncated: boolean;
    cap: number;
  };
  sql: string;
  tookMs: number;
  courtDataAvailable: boolean;
  crmStoreConfigured: boolean;
}

export interface SavedSearch {
  id: string;
  name: string;
  description: string | null;
  criteria: CriteriaSet;
  notifyInApp: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  active: boolean;
  alertLimitPerRun: number;
  lastEvaluatedAt: string | null;
  lastPipelineRunId: string | null;
  lastMatchCount: number | null;
  createdAt: string;
}

export interface AlertRow {
  id: string;
  kind: "new_match" | "updated_match" | "left_match";
  propertyId: string;
  propertySnapshot: Record<string, unknown>;
  score: number;
  rationale: string;
  changedFields: string[];
  pipelineRunId: string | null;
  readAt: string | null;
  opportunityId: string | null;
  createdAt: string;
  savedSearchId: string;
  searchName: string | null;
  matcherTrigger: string | null;
  matcherStartedAt: string | null;
  notifications: {
    id: string;
    channel: "in_app" | "email" | "sms" | "push";
    status: OutreachStatus;
    recipient: string | null;
    subject: string | null;
    body: string | null;
    sentAt: string | null;
  }[];
}

export interface OpportunityRow {
  opportunity: {
    id: string;
    propertyId: string;
    addressLine: string;
    addressCity: string | null;
    addressZip: string | null;
    latitude: number | null;
    longitude: number | null;
    assessedValue: number | null;
    ownerNameSnapshot: string | null;
    propertySnapshot: Record<string, unknown> | null;
    stage: AcquisitionStage;
    matchScore: number | null;
    matchRationale: string | null;
    askingPrice: number | null;
    offerPrice: number | null;
    ownerInterest: string | null;
    nextStep: string | null;
    nextStepDueAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  owner: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    mailingAddress: string | null;
    mailingCity: string | null;
    mailingState: string | null;
    mailingZip: string | null;
  } | null;
  assignee: { id: string; name: string; email: string } | null;
  searchName: string | null;
}

export interface OutreachMessageRow {
  message: {
    id: string;
    channel: OutreachChannel;
    templateId: string;
    toAddress: string;
    subject: string | null;
    body: string;
    providerMessageId: string;
    status: OutreachStatus;
    statusAt: string;
    createdAt: string;
  };
  events: {
    id: string;
    providerEventId: string;
    status: OutreachStatus;
    detail: string | null;
    occurredAt: string;
  }[];
}

export interface MatcherRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  pipelineRunId: string | null;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the store is attached but cannot be written, which pages render specially. */
  get isStoreReadOnly(): boolean {
    return this.code === "crm_store_not_writable";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let code = "http_error";
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      // A non JSON error body is still an error; keep the status line.
    }
    throw new ApiError(message, code, response.status);
  }

  return (await response.json()) as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
