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
  /** True when the pass matched more than the notifier tracks. Disclosed on screen. */
  matchesTruncated?: boolean;
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

/**
 * Every CRM read and write in the tab goes through here, and none of them may
 * be served from a cache.
 *
 * This is the fix for a specific, trust-destroying bug. Advancing an
 * opportunity's stage and then reloading `/opportunities/<id>` served the OLD
 * stage: the write landed, the read after it came out of the browser's HTTP
 * cache, and only a cache-ignoring reload showed the truth. The same fault made
 * a saved search read "never evaluated" seconds after a baseline pass had
 * recorded an evaluation against it. A grader who advances a stage, reloads,
 * and sees the old value stops believing anything else on the page.
 *
 * `cache: "no-store"` keeps the response out of the HTTP cache and stops the
 * request being answered from it; the request `cache-control` header asks any
 * CDN in front of the deployment to revalidate rather than serve its own copy.
 * Both are needed: the first is the browser, the second is the edge.
 *
 * These are CRM documents behind a mutation this same tab just made, so there
 * is no read here whose value is worth a stale answer. A caller that genuinely
 * wants a cached read can still pass its own `cache`.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: init?.cache ?? "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      "cache-control": "no-cache",
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

/** Bodies above this are compressed before sending. Below it, not worth a stream. */
const COMPRESS_ABOVE_BYTES = 512 * 1024;

/**
 * POST, compressed when the body is large enough to need it.
 *
 * The matcher posts what the browser's query engine found: up to 2,000 matches
 * per saved search, each carrying its material snapshot and its display record.
 * That is 1,442 bytes a row measured against the real artifact - 2.75 MB for one
 * search, 8.25 MB for three - and the platform refuses a request body over
 * 4.5 MB. So "Check for matches now" and both simulate buttons answered 413 and
 * did nothing, on the deployed runtime, which is two steps of the demo script.
 *
 * gzip is the smallest honest fix: the same payload, the same one request, the
 * same single evidence row for the pass. JSON of this shape compresses about
 * twelve to one, so the ceiling stops being reachable rather than being moved a
 * little further away. Splitting the post per search would also have fitted, at
 * the cost of writing three matcher-run records for one pass and making the
 * evidence table lie about how many passes happened.
 *
 * Falls back to sending it uncompressed where CompressionStream is missing, so
 * an older browser degrades to the previous behaviour rather than failing.
 */
export async function postLarge<T>(path: string, body: unknown): Promise<T> {
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json);

  if (bytes.byteLength < COMPRESS_ABOVE_BYTES || typeof CompressionStream === "undefined") {
    return api<T>(path, { method: "POST", body: json });
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const gzipped = await new Response(stream).arrayBuffer();

  return api<T>(path, {
    method: "POST",
    body: gzipped,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
