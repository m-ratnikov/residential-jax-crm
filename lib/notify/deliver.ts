/**
 * Delivering an alert down the channels a saved search asked for.
 *
 * In-app is a row: the alerts feed reads it directly and it is delivered the
 * moment it is written. Email, SMS and push go through the same simulated
 * provider adapters as owner outreach, so a notification and a mailing share
 * one lifecycle model rather than two.
 */

import { displayAddress } from "@/lib/data/map";
import type { ScoredProperty } from "@/lib/data/types";
import type { CrmDatabase } from "@/lib/crm/db";
import { notifications } from "@/lib/crm/schema";
import { humanField } from "@/lib/criteria/score";
import { providerFor } from "./providers";
import type { NotifyChannel } from "./types";
import { logError } from "./log";

export interface DeliverInput {
  alertId: string;
  search: {
    id: string;
    name: string;
    notifyInApp: boolean;
    notifyEmail: boolean;
    notifySms: boolean;
  };
  scored: ScoredProperty;
  kind: "new_match" | "updated_match";
  changed: string[];
  pipelineRunId: string | null;
}

/** Where a simulated notification is addressed. Never a real inbox. */
const DEMO_RECIPIENT_EMAIL = process.env.ALERT_EMAIL?.trim() || "acquisitions@example.invalid";
const DEMO_RECIPIENT_SMS = process.env.ALERT_SMS?.trim() || "+1-904-555-0100";

export function alertSubject(input: DeliverInput): string {
  const address = displayAddress(input.scored.property);
  return input.kind === "new_match"
    ? `New match for "${input.search.name}": ${address}`
    : `Updated match for "${input.search.name}": ${address}`;
}

export function alertBody(input: DeliverInput): string {
  const property = input.scored.property;
  const address = displayAddress(property);
  const lines: string[] = [];

  lines.push(
    input.kind === "new_match"
      ? `${address} now matches your saved search "${input.search.name}".`
      : `${address} already matched "${input.search.name}" and has changed.`,
  );
  lines.push("");
  lines.push(`Match score: ${input.scored.score.toFixed(0)} / 100`);
  lines.push(`Why: ${input.scored.rationale}`);

  if (input.changed.length) {
    lines.push("");
    lines.push(`Changed since the last pass: ${input.changed.map(humanField).join(", ")}.`);
  }

  lines.push("");
  lines.push(`Owner of record: ${property.ownerName ?? "not published"}`);
  lines.push(
    `Assessed value: ${
      property.assessedValue === null
        ? "not published"
        : `$${Math.round(property.assessedValue).toLocaleString("en-US")}`
    }`,
  );
  lines.push(`Parcel: ${property.propertyId}`);

  if (input.pipelineRunId) {
    lines.push("");
    lines.push(`Triggered by pipeline run ${input.pipelineRunId}.`);
  }
  if (property.provenance.sourceUrl) {
    lines.push(`Source: ${property.provenance.sourceUrl}`);
  }

  return lines.join("\n");
}

async function record(
  database: CrmDatabase,
  alertId: string,
  channel: NotifyChannel,
  recipient: string | null,
  subject: string | null,
  body: string,
): Promise<number> {
  try {
    if (channel === "in_app") {
      // Nothing to hand to a provider: the feed reads the row.
      await database.insert(notifications).values({
        alertId,
        channel,
        recipient: null,
        status: "delivered",
        subject,
        body,
        sentAt: new Date(),
      });
      return 1;
    }

    const provider = providerFor(channel === "sms" ? "sms" : "email");
    const sent = await provider.send({
      channel: provider.channel,
      to: recipient ?? "",
      subject,
      body,
      idempotencyKey: `${alertId}:${channel}`,
    });

    await database.insert(notifications).values({
      alertId,
      channel,
      recipient,
      status: sent.status,
      providerMessageId: sent.providerMessageId,
      subject,
      body,
      sentAt: sent.acceptedAt,
    });
    return 1;
  } catch (error: unknown) {
    // A notification that cannot be written must not lose the alert: the alert
    // row is already committed and will still appear in the feed.
    logError("notify.deliver_failed", error, { alertId, channel });
    return 0;
  }
}

/** Returns how many notifications were written. */
export async function deliverAlert(database: CrmDatabase, input: DeliverInput): Promise<number> {
  const subject = alertSubject(input);
  const body = alertBody(input);
  let sent = 0;

  if (input.search.notifyInApp) {
    sent += await record(database, input.alertId, "in_app", null, subject, body);
  }
  if (input.search.notifyEmail) {
    sent += await record(database, input.alertId, "email", DEMO_RECIPIENT_EMAIL, subject, body);
  }
  if (input.search.notifySms) {
    // An SMS carries the first line only; the rest is what the app is for.
    const short = `${subject} - score ${input.scored.score.toFixed(0)}`;
    sent += await record(database, input.alertId, "sms", DEMO_RECIPIENT_SMS, null, short);
  }

  return sent;
}
