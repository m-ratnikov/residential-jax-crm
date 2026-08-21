/**
 * Owner outreach: templates, sending, and advancing the simulated lifecycle.
 *
 * Nothing here contacts a property owner. What it does is model the lifecycle
 * honestly: a send is accepted by a provider and returns a provider message id,
 * status events arrive later carrying that id, and each event is correlated
 * back to the message and written idempotently on its own provider event id.
 * A redelivered event is a no-op, and a terminal status cannot be superseded.
 *
 * The events are produced up front by the provider simulator with a delay each,
 * and materialised by `advanceOutreach` when enough wall-clock time has passed.
 * That is what makes a demo show a message actually progressing - queued, sent,
 * delivered, replied - instead of jumping to a final state the moment a button
 * is pressed. Direct mail is slower than SMS on purpose.
 */

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { displayAddress } from "@/lib/data/map";
import type { PropertyRecord } from "@/lib/data/types";
import { db, type CrmDatabase } from "@/lib/crm/db";
import {
  opportunities,
  outreachCampaigns,
  outreachEvents,
  outreachMessages,
  owners,
} from "@/lib/crm/schema";
import { providerFor } from "./providers";
import { supersedes, type OutreachChannel, type OutreachStatus } from "./types";
import { logEvent, logError } from "./log";

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

export interface OutreachTemplate {
  id: string;
  name: string;
  channels: OutreachChannel[];
  description: string;
  subject: (context: TemplateContext) => string;
  body: (context: TemplateContext) => string;
}

export interface TemplateContext {
  ownerName: string;
  addressLine: string;
  city: string;
  assessedValue: number | null;
  yearsHeld: number | null;
  senderName: string;
  senderPhone: string;
}

function money(value: number | null): string {
  return value === null
    ? "the county's assessed value"
    : `$${Math.round(value).toLocaleString("en-US")}`;
}

export const OUTREACH_TEMPLATES: OutreachTemplate[] = [
  {
    id: "cash-offer-intro",
    name: "Cash offer introduction",
    channels: ["email", "sms", "direct_mail"],
    description:
      "First touch. States the interest plainly and asks for a conversation, not a price.",
    subject: (c) => `Interested in buying ${c.addressLine}`,
    body: (c) =>
      [
        `Hello ${c.ownerName},`,
        "",
        `I am reaching out about ${c.addressLine}. We buy homes in ${c.city} directly, as-is, and can close on your timeline.`,
        c.yearsHeld !== null && c.yearsHeld >= 10
          ? `Public records show you have owned it for around ${c.yearsHeld} years, so I appreciate this may be out of the blue.`
          : "",
        "",
        `If you have ever considered selling, I would like to talk about what that might look like. There is no cost and no obligation.`,
        "",
        `${c.senderName}`,
        c.senderPhone,
      ]
        .filter(Boolean)
        .join("\n"),
  },
  {
    id: "roof-condition",
    name: "Aging roof angle",
    channels: ["email", "direct_mail"],
    description:
      "For parcels where the roof is past its expected life. Leads with the repair burden.",
    subject: (c) => `About the roof at ${c.addressLine}`,
    body: (c) =>
      [
        `Hello ${c.ownerName},`,
        "",
        `County records suggest the roof at ${c.addressLine} may be near the end of its service life. A re-roof in ${c.city} is rarely a small number.`,
        "",
        `If you would rather not carry that, we buy as-is and handle the work ourselves. Happy to talk through what we could offer against ${money(c.assessedValue)}.`,
        "",
        `${c.senderName}`,
        c.senderPhone,
      ].join("\n"),
  },
  {
    id: "absentee-landlord",
    name: "Out of area owner",
    channels: ["email", "sms", "direct_mail"],
    description:
      "For owners whose mailing address is not the property. Leads with the management burden.",
    subject: (c) => `Managing ${c.addressLine} from out of town?`,
    body: (c) =>
      [
        `Hello ${c.ownerName},`,
        "",
        `Your mailing address on the ${c.city} roll is not the property, so I am guessing ${c.addressLine} is a rental.`,
        "",
        `If managing it from a distance has stopped being worth the return, we buy tenanted and vacant properties alike, with no repairs and no agent commission.`,
        "",
        `${c.senderName}`,
        c.senderPhone,
      ].join("\n"),
  },
  {
    id: "follow-up",
    name: "Follow up",
    channels: ["email", "sms"],
    description: "Second touch after no reply. Short, and gives an easy way out.",
    subject: (c) => `Following up on ${c.addressLine}`,
    body: (c) =>
      [
        `Hello ${c.ownerName},`,
        "",
        `Just following up on my note about ${c.addressLine}. If the timing is wrong, tell me and I will not write again.`,
        "",
        `${c.senderName}`,
        c.senderPhone,
      ].join("\n"),
  },
];

export function templateById(id: string): OutreachTemplate | null {
  return OUTREACH_TEMPLATES.find((template) => template.id === id) ?? null;
}

const SENDER_NAME =
  process.env.OUTREACH_SENDER_NAME?.trim() || "Dana Whitfield, Riverbend Acquisitions";
const SENDER_PHONE = process.env.OUTREACH_SENDER_PHONE?.trim() || "(904) 555-0142";

export function contextFor(input: {
  ownerName: string | null;
  addressLine: string;
  city: string | null;
  assessedValue: number | null;
  yearsHeld: number | null;
}): TemplateContext {
  return {
    ownerName: input.ownerName ?? "Property owner",
    addressLine: input.addressLine,
    city: input.city ?? "Jacksonville",
    assessedValue: input.assessedValue,
    yearsHeld: input.yearsHeld,
    senderName: SENDER_NAME,
    senderPhone: SENDER_PHONE,
  };
}

export function contextForProperty(
  property: PropertyRecord,
  ownerName?: string | null,
): TemplateContext {
  return contextFor({
    ownerName: ownerName ?? property.ownerName,
    addressLine: displayAddress(property),
    city: property.addressCity,
    assessedValue: property.assessedValue,
    yearsHeld: property.yearsSinceLastSale,
  });
}

/* ------------------------------------------------------------------ */
/* Sending                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where a simulated message is addressed when the owner has no contact detail.
 * `.invalid` is reserved by RFC 2606 precisely so it can never resolve.
 */
function fallbackAddress(channel: OutreachChannel, opportunityId: string): string {
  switch (channel) {
    case "email":
      return `owner-${opportunityId.slice(0, 8)}@example.invalid`;
    case "sms":
      return "+1-904-555-0000";
    case "direct_mail":
      return "mailing address on the county roll";
  }
}

export interface SendOutreachInput {
  opportunityIds: readonly string[];
  channel: OutreachChannel;
  templateId: string;
  campaignName?: string;
  createdById?: string | null;
}

export interface SendOutreachResult {
  campaignId: string | null;
  sent: number;
  skipped: { opportunityId: string; reason: string }[];
  messageIds: string[];
}

export async function sendOutreach(input: SendOutreachInput): Promise<SendOutreachResult> {
  const database = db();
  const template = templateById(input.templateId);
  if (!template) throw new Error(`unknown template: ${input.templateId}`);
  if (!template.channels.includes(input.channel)) {
    throw new Error(`template ${template.id} does not support ${input.channel}`);
  }
  if (!input.opportunityIds.length) {
    return { campaignId: null, sent: 0, skipped: [], messageIds: [] };
  }

  const rows = await database
    .select({ opportunity: opportunities, owner: owners })
    .from(opportunities)
    .leftJoin(owners, eq(opportunities.ownerId, owners.id))
    .where(inArray(opportunities.id, [...input.opportunityIds]));

  const [campaign] = await database
    .insert(outreachCampaigns)
    .values({
      name: input.campaignName ?? `${template.name} - ${new Date().toISOString().slice(0, 10)}`,
      channel: input.channel,
      templateId: template.id,
      createdById: input.createdById ?? null,
    })
    .returning({ id: outreachCampaigns.id });

  const campaignId = campaign?.id ?? null;
  const provider = providerFor(input.channel);
  const skipped: { opportunityId: string; reason: string }[] = [];
  const messageIds: string[] = [];

  for (const row of rows) {
    const opportunity = row.opportunity;
    const snapshot = (opportunity.propertySnapshot ?? {}) as Record<string, unknown>;

    const context = contextFor({
      ownerName: row.owner?.name ?? opportunity.ownerNameSnapshot,
      addressLine: opportunity.addressLine,
      city: opportunity.addressCity,
      assessedValue: opportunity.assessedValue,
      yearsHeld:
        typeof snapshot["yearsSinceLastSale"] === "number"
          ? (snapshot["yearsSinceLastSale"] as number)
          : null,
    });

    const to =
      input.channel === "email"
        ? (row.owner?.email ?? fallbackAddress("email", opportunity.id))
        : input.channel === "sms"
          ? (row.owner?.phone ?? fallbackAddress("sms", opportunity.id))
          : (row.owner?.mailingAddress ?? fallbackAddress("direct_mail", opportunity.id));

    const subject = input.channel === "sms" ? null : template.subject(context);
    const body = template.body(context);

    try {
      const [message] = await database
        .insert(outreachMessages)
        .values({
          campaignId,
          opportunityId: opportunity.id,
          channel: input.channel,
          templateId: template.id,
          toAddress: to,
          subject,
          body,
          // Replaced immediately below with the provider's own id; a message row
          // must never exist without one, so it is written in the same insert.
          providerMessageId: `pending:${opportunity.id}:${campaignId ?? "none"}:${input.channel}`,
          status: "queued",
          createdById: input.createdById ?? null,
        })
        .returning({ id: outreachMessages.id });

      if (!message) {
        skipped.push({ opportunityId: opportunity.id, reason: "could not create the message" });
        continue;
      }

      const accepted = await provider.send({
        channel: input.channel,
        to,
        subject,
        body,
        idempotencyKey: message.id,
      });

      await database
        .update(outreachMessages)
        .set({ providerMessageId: accepted.providerMessageId, status: "queued" })
        .where(eq(outreachMessages.id, message.id));

      // The whole timeline is written up front with its scheduled time. Nothing
      // is applied to the message until that time passes.
      const lifecycle = provider.lifecycle(accepted, {
        channel: input.channel,
        to,
        subject,
        body,
        idempotencyKey: message.id,
      });

      for (const event of lifecycle) {
        await database
          .insert(outreachEvents)
          .values({
            messageId: message.id,
            providerEventId: event.providerEventId,
            status: event.status,
            detail: event.detail,
            occurredAt: new Date(accepted.acceptedAt.getTime() + event.afterSeconds * 1000),
          })
          .onConflictDoNothing();
      }

      messageIds.push(message.id);
    } catch (error: unknown) {
      logError("outreach.send_failed", error, { opportunityId: opportunity.id });
      skipped.push({
        opportunityId: opportunity.id,
        reason: error instanceof Error ? error.message : "send failed",
      });
    }
  }

  // Apply anything already due, so the first status is visible immediately.
  await advanceOutreach();

  logEvent("outreach.campaign_sent", {
    campaignId,
    channel: input.channel,
    templateId: template.id,
    sent: messageIds.length,
    skipped: skipped.length,
  });

  return { campaignId, sent: messageIds.length, skipped, messageIds };
}

/* ------------------------------------------------------------------ */
/* Lifecycle advance                                                    */
/* ------------------------------------------------------------------ */

export interface AdvanceResult {
  messagesAdvanced: number;
  eventsApplied: number;
}

/**
 * Apply every provider event whose scheduled time has passed to its message.
 *
 * Called after a send, by the matcher pass, and by the UI when the outreach
 * view is opened. It is idempotent: an event that has already been applied
 * cannot advance the status again, and a status that would move backwards is
 * ignored rather than written.
 */
export async function advanceOutreach(now: Date = new Date()): Promise<AdvanceResult> {
  const database = db();

  const due = await database
    .select({
      messageId: outreachEvents.messageId,
      status: outreachEvents.status,
      occurredAt: outreachEvents.occurredAt,
      currentStatus: outreachMessages.status,
    })
    .from(outreachEvents)
    .innerJoin(outreachMessages, eq(outreachEvents.messageId, outreachMessages.id))
    .where(lte(outreachEvents.occurredAt, now))
    .orderBy(outreachEvents.occurredAt);

  const latest = new Map<string, { status: OutreachStatus; at: Date; current: OutreachStatus }>();
  for (const event of due) {
    const existing = latest.get(event.messageId);
    const candidate = event.status as OutreachStatus;
    const current = (existing?.status ?? event.currentStatus) as OutreachStatus;
    if (!existing || supersedes(candidate, current)) {
      latest.set(event.messageId, {
        status: candidate,
        at: event.occurredAt,
        current: event.currentStatus as OutreachStatus,
      });
    }
  }

  let advanced = 0;
  for (const [messageId, entry] of latest) {
    if (!supersedes(entry.status, entry.current)) continue;
    await database
      .update(outreachMessages)
      .set({ status: entry.status, statusAt: entry.at })
      .where(eq(outreachMessages.id, messageId));
    advanced += 1;
  }

  return { messagesAdvanced: advanced, eventsApplied: due.length };
}

/**
 * Bring every pending event forward so a demo does not have to wait days for a
 * direct mail piece to be scanned. Explicitly user-triggered and labelled; the
 * events themselves are unchanged, only their scheduled time is pulled in.
 */
export async function fastForwardOutreach(): Promise<AdvanceResult> {
  const database = db();
  await database
    .update(outreachEvents)
    .set({ occurredAt: sql`now()` })
    .where(sql`${outreachEvents.occurredAt} > now()`);
  logEvent("outreach.fast_forward", {});
  return advanceOutreach();
}

/** Messages whose lifecycle has not reached a terminal status yet. */
export async function pendingOutreachCount(database: CrmDatabase): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(outreachMessages)
    .where(
      and(
        sql`${outreachMessages.status} NOT IN ('replied', 'bounced', 'returned', 'failed')`,
        sql`true`,
      ),
    );
  return row?.count ?? 0;
}
