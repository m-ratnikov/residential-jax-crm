/**
 * The simulated messaging providers.
 *
 * Outreach to property owners is explicitly out of scope for this story, so
 * nothing here sends anything. What it does do is behave like a provider
 * adapter, because the shape is the part worth getting right: a send returns a
 * provider message id, status arrives later as discrete events carrying that
 * id, and the correlation from provider id back to the internal record is what
 * a real adapter would have to do.
 *
 * That shape is taken from the kit's communication-activity guidance - provider
 * status event -> provider message id -> correlation lookup -> internal id ->
 * normalised feedback event, persisted idempotently - with the provider
 * replaced by a deterministic simulator. Swapping in Twilio or SendGrid is a
 * new `OutreachProvider`, not a change to the CRM.
 */

import { createHash, randomUUID } from "node:crypto";

import type { OutreachChannel, OutreachStatus } from "./types";

export interface SendRequest {
  channel: OutreachChannel;
  to: string;
  subject?: string | null;
  body: string;
  /** Correlates the simulation deterministically. Usually the message row id. */
  idempotencyKey: string;
}

export interface SendResult {
  providerMessageId: string;
  /** The status the provider reports at accept time. */
  status: OutreachStatus;
  acceptedAt: Date;
}

export interface ProviderEvent {
  providerEventId: string;
  providerMessageId: string;
  status: OutreachStatus;
  detail: string;
  /** Offset from the send, in seconds. The simulator schedules by this. */
  afterSeconds: number;
}

export interface OutreachProvider {
  readonly id: string;
  readonly channel: OutreachChannel;
  send(request: SendRequest): Promise<SendResult>;
  /**
   * The lifecycle this send will follow. Returned up front rather than pushed,
   * because there is no webhook to receive: the CRM materialises these events
   * on a timeline so the UI can show a message progressing.
   */
  lifecycle(result: SendResult, request: SendRequest): ProviderEvent[];
}

/**
 * Deterministic pseudo-randomness. The same message always gets the same
 * outcome, so a demo can be re-run and a screenshot still matches, and a test
 * does not need to stub anything.
 */
function unitHash(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  // First four bytes as a fraction of the range.
  return digest.readUInt32BE(0) / 0xffffffff;
}

interface Outcome {
  status: OutreachStatus;
  detail: string;
  weight: number;
}

/**
 * Outcome mixes per channel. These are plausible rather than measured, and the
 * UI says the lifecycle is simulated wherever it shows one.
 */
const OUTCOMES: Record<OutreachChannel, Outcome[]> = {
  email: [
    { status: "opened", detail: "Recipient opened the message", weight: 0.42 },
    { status: "replied", detail: "Recipient replied", weight: 0.12 },
    { status: "delivered", detail: "Delivered, not opened", weight: 0.38 },
    { status: "bounced", detail: "Mailbox does not exist", weight: 0.08 },
  ],
  sms: [
    { status: "delivered", detail: "Handset acknowledged delivery", weight: 0.55 },
    { status: "replied", detail: "Recipient replied", weight: 0.18 },
    { status: "bounced", detail: "Carrier rejected: landline", weight: 0.15 },
    { status: "failed", detail: "Number not in service", weight: 0.12 },
  ],
  direct_mail: [
    { status: "delivered", detail: "Carrier scan: delivered", weight: 0.78 },
    { status: "replied", detail: "Response received via call-in number", weight: 0.09 },
    { status: "returned", detail: "Returned to sender: vacant", weight: 0.13 },
  ],
};

function pickOutcome(channel: OutreachChannel, seed: string): Outcome {
  const outcomes = OUTCOMES[channel];
  const roll = unitHash(`${seed}:outcome`);
  let cumulative = 0;
  for (const outcome of outcomes) {
    cumulative += outcome.weight;
    if (roll <= cumulative) return outcome;
  }
  return outcomes[outcomes.length - 1] as Outcome;
}

/** How long each channel plausibly takes to reach its terminal status, in seconds. */
const TERMINAL_DELAY: Record<OutreachChannel, [number, number]> = {
  email: [20, 240],
  sms: [10, 90],
  direct_mail: [3 * 86_400, 9 * 86_400],
};

function simulatedProvider(channel: OutreachChannel, id: string): OutreachProvider {
  return {
    id,
    channel,
    async send(request: SendRequest): Promise<SendResult> {
      return {
        // Prefixed so nothing can mistake a simulated id for a real one.
        providerMessageId: `sim_${channel}_${createHash("sha256")
          .update(request.idempotencyKey)
          .digest("hex")
          .slice(0, 20)}`,
        status: "sent",
        acceptedAt: new Date(),
      };
    },
    lifecycle(result: SendResult, request: SendRequest): ProviderEvent[] {
      const seed = result.providerMessageId;
      const outcome = pickOutcome(channel, seed);
      const [minDelay, maxDelay] = TERMINAL_DELAY[channel];
      const spread = unitHash(`${seed}:delay`);
      const terminalAfter = Math.round(minDelay + (maxDelay - minDelay) * spread);

      const events: ProviderEvent[] = [
        {
          providerEventId: `${result.providerMessageId}:sent`,
          providerMessageId: result.providerMessageId,
          status: "sent",
          detail: `Accepted by ${id} for ${request.to}`,
          afterSeconds: 0,
        },
      ];

      // A bounce or a failure never reaches delivered; everything else does,
      // and only then goes on to open or reply.
      const failsEarly =
        outcome.status === "bounced" ||
        outcome.status === "failed" ||
        outcome.status === "returned";

      if (!failsEarly) {
        events.push({
          providerEventId: `${result.providerMessageId}:delivered`,
          providerMessageId: result.providerMessageId,
          status: "delivered",
          detail: "Delivered",
          afterSeconds: Math.max(1, Math.round(terminalAfter * 0.4)),
        });
      }

      if (outcome.status === "replied") {
        events.push({
          providerEventId: `${result.providerMessageId}:opened`,
          providerMessageId: result.providerMessageId,
          status: "opened",
          detail: "Opened",
          afterSeconds: Math.max(2, Math.round(terminalAfter * 0.7)),
        });
      }

      if (outcome.status !== "delivered") {
        events.push({
          providerEventId: `${result.providerMessageId}:${outcome.status}`,
          providerMessageId: result.providerMessageId,
          status: outcome.status,
          detail: outcome.detail,
          afterSeconds: terminalAfter,
        });
      }

      return events;
    },
  };
}

const PROVIDERS: Record<OutreachChannel, OutreachProvider> = {
  email: simulatedProvider("email", "simulated-email"),
  sms: simulatedProvider("sms", "simulated-sms"),
  direct_mail: simulatedProvider("direct_mail", "simulated-print-and-mail"),
};

export function providerFor(channel: OutreachChannel): OutreachProvider {
  return PROVIDERS[channel];
}

/** A fresh id for a notification that has no message row to key from. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
