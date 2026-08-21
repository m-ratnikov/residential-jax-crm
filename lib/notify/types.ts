/** Shared enumerations, kept in one place so the schema and the simulator agree. */

export const OUTREACH_CHANNELS = ["email", "sms", "direct_mail"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const OUTREACH_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "returned",
  "failed",
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const NOTIFY_CHANNELS = ["in_app", "email", "sms", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const ACQUISITION_STAGES = [
  "identified",
  "contacted",
  "negotiating",
  "under_contract",
  "closed",
  "dead",
] as const;
export type AcquisitionStage = (typeof ACQUISITION_STAGES)[number];

export const STAGE_LABELS: Record<AcquisitionStage, string> = {
  identified: "Identified",
  contacted: "Contacted",
  negotiating: "Negotiating",
  under_contract: "Under contract",
  closed: "Closed",
  dead: "Dead",
};

/**
 * Terminal statuses cannot be superseded. A delivered message that later
 * reports queued is a redelivered event, not a regression, and the ledger
 * must not walk backwards.
 */
export const STATUS_RANK: Record<OutreachStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  replied: 4,
  bounced: 5,
  returned: 5,
  failed: 5,
};

export function isTerminal(status: OutreachStatus): boolean {
  return status === "replied" || status === "bounced" || status === "returned" || status === "failed";
}

export function supersedes(next: OutreachStatus, current: OutreachStatus): boolean {
  if (isTerminal(current)) return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

export const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  email: "Email",
  sms: "SMS",
  direct_mail: "Direct mail",
};
