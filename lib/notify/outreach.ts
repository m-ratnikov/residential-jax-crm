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

import { displayAddress } from "@/lib/data/map";
import type { PropertyRecord } from "@/lib/data/types";
import { crmStore } from "@/lib/crm/db";
import {
  newId,
  nowIso,
  type OpportunityDoc,
  type OutreachMessageDoc,
  type OwnerDoc,
} from "@/lib/crm/documents";
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
  const store = crmStore();
  const template = templateById(input.templateId);
  if (!template) throw new Error(`unknown template: ${input.templateId}`);
  if (!template.channels.includes(input.channel)) {
    throw new Error(`template ${template.id} does not support ${input.channel}`);
  }
  if (!input.opportunityIds.length) {
    return { campaignId: null, sent: 0, skipped: [], messageIds: [] };
  }

  const ownerDocs = await store.list<OwnerDoc>("owners");
  const ownerById = new Map(ownerDocs.map((owner) => [owner.id, owner]));

  // Read every opportunity once, the way owners are read once above. Reads
  // revalidate against the branch now, and this loop's own writes move the
  // branch, so a per-iteration `get` would pay a real round trip on every
  // iteration after the first: a 500-message campaign costing about a thousand
  // requests instead of five hundred. The append itself still goes through
  // `store.update`, which re-reads the document it is changing, so nothing here
  // is written from this snapshot.
  const opportunityDocs = await store.list<OpportunityDoc>("opportunities");
  const opportunityById = new Map(opportunityDocs.map((doc) => [doc.id, doc]));

  const campaignId = newId();
  const campaignName = input.campaignName ?? `${template.name} - ${nowIso().slice(0, 10)}`;
  const provider = providerFor(input.channel);

  const skipped: { opportunityId: string; reason: string }[] = [];
  const messageIds: string[] = [];

  for (const opportunityId of input.opportunityIds) {
    const opportunity = opportunityById.get(opportunityId);
    if (!opportunity) {
      skipped.push({ opportunityId, reason: "no such opportunity" });
      continue;
    }

    const owner = opportunity.ownerId ? ownerById.get(opportunity.ownerId) : undefined;
    const snapshot = opportunity.propertySnapshot ?? {};

    const context = contextFor({
      ownerName: owner?.name ?? opportunity.ownerNameSnapshot,
      addressLine: opportunity.addressLine,
      city: opportunity.addressCity,
      assessedValue: opportunity.assessedValue,
      yearsHeld:
        typeof snapshot["yearsSinceLastSale"] === "number"
          ? (snapshot["yearsSinceLastSale"] as number)
          : null,
    });

    // Hand-entered detail first, then the mocked skip trace, then the generic
    // fallback. The drawer shows the skip-traced address for this owner, so
    // addressing the message anywhere else would make the two disagree on
    // screen; a real contact an analyst typed still outranks a simulated one.
    const to =
      input.channel === "email"
        ? (owner?.email ?? owner?.skipTrace?.email ?? fallbackAddress("email", opportunity.id))
        : input.channel === "sms"
          ? (owner?.phone ?? owner?.skipTrace?.phone ?? fallbackAddress("sms", opportunity.id))
          : (owner?.mailingAddress ?? fallbackAddress("direct_mail", opportunity.id));

    const subject = input.channel === "sms" ? null : template.subject(context);
    const body = template.body(context);
    const messageId = newId();

    try {
      const accepted = await provider.send({
        channel: input.channel,
        to,
        subject,
        body,
        idempotencyKey: messageId,
      });

      // The whole timeline is written up front with its scheduled time. Nothing
      // is applied until that time passes, which is what makes a direct mail
      // piece visibly slower than an SMS rather than pretending both land at
      // once.
      const lifecycle = provider.lifecycle(accepted, {
        channel: input.channel,
        to,
        subject,
        body,
        idempotencyKey: messageId,
      });

      const message: OutreachMessageDoc = {
        id: messageId,
        campaignId,
        campaignName,
        channel: input.channel,
        templateId: template.id,
        toAddress: to,
        subject,
        body,
        providerMessageId: accepted.providerMessageId,
        status: "queued",
        statusAt: accepted.acceptedAt.toISOString(),
        createdById: input.createdById ?? null,
        createdAt: accepted.acceptedAt.toISOString(),
        events: lifecycle.map((event) => ({
          providerEventId: event.providerEventId,
          status: event.status,
          detail: event.detail,
          occurredAt: new Date(
            accepted.acceptedAt.getTime() + event.afterSeconds * 1000,
          ).toISOString(),
        })),
      };

      const appendedAt = nowIso();
      await store.update<OpportunityDoc>("opportunities", opportunity.id, (current) =>
        current
          ? {
              ...current,
              outreach: [...current.outreach, message],
              updatedAt: appendedAt,
            }
          : null,
      );

      messageIds.push(messageId);
    } catch (error: unknown) {
      logError("outreach.send_failed", error, { opportunityId });
      skipped.push({
        opportunityId,
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
 * Apply every provider event whose scheduled time has passed.
 *
 * Called after a send, by the matcher pass, and when an opportunity is opened.
 * Idempotent: an event already applied cannot advance the status again, and a
 * status that would move backwards is ignored rather than written. That is what
 * `supersedes` enforces, and it is why a redelivered event is harmless.
 */
export async function advanceOutreach(now: Date = new Date()): Promise<AdvanceResult> {
  const store = crmStore();
  const opportunities = await store.list<OpportunityDoc>("opportunities");
  const cutoff = now.toISOString();

  let messagesAdvanced = 0;
  let eventsApplied = 0;

  for (const stale of opportunities) {
    if (!stale.outreach.length) continue;

    // `mutate` runs again when a write races, so these record the last attempt
    // instead of accumulating across attempts and double-counting a retry.
    let advancedHere = 0;
    let appliedHere = 0;

    await store.update<OpportunityDoc>("opportunities", stale.id, (current) => {
      advancedHere = 0;
      appliedHere = 0;
      if (!current) return null;

      let changed = false;
      const outreach = current.outreach.map((message) => {
        const due = message.events.filter((event) => event.occurredAt <= cutoff);
        appliedHere += due.length;

        let status = message.status;
        let statusAt = message.statusAt;

        for (const event of due) {
          if (!supersedes(event.status, status)) continue;
          status = event.status;
          statusAt = event.occurredAt;
        }

        if (status === message.status) return message;
        changed = true;
        advancedHere += 1;
        return { ...message, status, statusAt };
      });

      return changed ? { ...current, outreach } : null;
    });

    messagesAdvanced += advancedHere;
    eventsApplied += appliedHere;
  }

  return { messagesAdvanced, eventsApplied };
}

/**
 * Bring every pending event forward, so a demo does not wait days for a direct
 * mail piece to be scanned. Explicitly user-triggered and labelled; the events
 * themselves are unchanged, only their scheduled time is pulled in.
 */
export async function fastForwardOutreach(): Promise<AdvanceResult> {
  const store = crmStore();
  const opportunities = await store.list<OpportunityDoc>("opportunities");
  const at = nowIso();

  for (const stale of opportunities) {
    if (!stale.outreach.length) continue;
    await store.update<OpportunityDoc>("opportunities", stale.id, (current) => {
      if (!current) return null;
      return {
        ...current,
        outreach: current.outreach.map((message) => ({
          ...message,
          events: message.events.map((event) =>
            event.occurredAt > at ? { ...event, occurredAt: at } : event,
          ),
        })),
      };
    });
  }

  logEvent("outreach.fast_forward", {});
  return advanceOutreach();
}

/** Every message across the pipeline, newest first, for the campaign view. */
export async function listAllOutreach(): Promise<
  { opportunityId: string; addressLine: string; message: OutreachMessageDoc }[]
> {
  const opportunities = await crmStore().list<OpportunityDoc>("opportunities");
  return opportunities
    .flatMap((opportunity) =>
      opportunity.outreach.map((message) => ({
        opportunityId: opportunity.id,
        addressLine: opportunity.addressLine,
        message,
      })),
    )
    .sort((a, b) => (a.message.createdAt < b.message.createdAt ? 1 : -1));
}
