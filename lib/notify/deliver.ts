/**
 * Delivering an alert down the channels a saved search asked for.
 *
 * In-app is a row: the alerts feed reads it directly and it is delivered the
 * moment it is written. Email, SMS and push go through the same simulated
 * provider adapters as owner outreach, so a notification and a mailing share
 * one lifecycle model rather than two.
 */

import { newId, nowIso, type NotificationDoc } from "@/lib/crm/documents";
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
  kind: "new_match" | "updated_match";
  changed: string[];
  pipelineRunId: string | null;
  score: number;
  rationale: string;
  /**
   * The parcel as it looked when the alert fired. A plain record rather than a
   * PropertyRecord, because this runs after the match has crossed the wire from
   * whichever engine produced it.
   */
  propertySnapshot: Record<string, unknown>;
}

function snapshotText(input: DeliverInput, key: string, fallback: string): string {
  const value = input.propertySnapshot[key];
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

/** Where a simulated notification is addressed. Never a real inbox. */
const DEMO_RECIPIENT_EMAIL = process.env.ALERT_EMAIL?.trim() || "acquisitions@example.invalid";
const DEMO_RECIPIENT_SMS = process.env.ALERT_SMS?.trim() || "+1-904-555-0100";

export function alertSubject(input: DeliverInput): string {
  const address = snapshotText(input, "address", `Parcel ${snapshotText(input, "propertyId", "")}`);
  return input.kind === "new_match"
    ? `New match for "${input.search.name}": ${address}`
    : `Updated match for "${input.search.name}": ${address}`;
}

export function alertBody(input: DeliverInput): string {
  const snapshot = input.propertySnapshot;
  const address = snapshotText(input, "address", `Parcel ${snapshotText(input, "propertyId", "")}`);
  const lines: string[] = [];

  lines.push(
    input.kind === "new_match"
      ? `${address} now matches your saved search "${input.search.name}".`
      : `${address} already matched "${input.search.name}" and has changed.`,
  );
  lines.push("");
  lines.push(`Match score: ${input.score.toFixed(0)} / 100`);
  lines.push(`Why: ${input.rationale}`);

  if (input.changed.length) {
    lines.push("");
    lines.push(`Changed since the last pass: ${input.changed.map(humanField).join(", ")}.`);
  }

  const assessed = snapshot["assessedValue"];
  lines.push("");
  lines.push(`Owner of record: ${snapshotText(input, "ownerName", "not published")}`);
  lines.push(
    `Assessed value: ${
      typeof assessed === "number"
        ? `$${Math.round(assessed).toLocaleString("en-US")}`
        : "not published"
    }`,
  );
  lines.push(`Parcel: ${snapshotText(input, "propertyId", "unknown")}`);

  if (input.pipelineRunId) {
    lines.push("");
    lines.push(`Triggered by pipeline run ${input.pipelineRunId}.`);
  }

  const provenance = snapshot["provenance"] as { sourceUrl?: string | null } | undefined;
  if (provenance?.sourceUrl) lines.push(`Source: ${provenance.sourceUrl}`);

  return lines.join("\n");
}

async function record(
  input: DeliverInput,
  channel: NotifyChannel,
  recipient: string | null,
  subject: string | null,
  body: string,
): Promise<NotificationDoc | null> {
  try {
    if (channel === "in_app") {
      // Nothing to hand to a provider: the feed reads the alert document.
      return {
        id: newId(),
        channel,
        recipient: null,
        status: "delivered",
        providerMessageId: null,
        subject,
        body,
        sentAt: nowIso(),
        createdAt: nowIso(),
      };
    }

    const provider = providerFor(channel === "sms" ? "sms" : "email");
    const sent = await provider.send({
      channel: provider.channel,
      to: recipient ?? "",
      subject,
      body,
      idempotencyKey: `${input.alertId}:${channel}`,
    });

    return {
      id: newId(),
      channel,
      recipient,
      status: sent.status,
      providerMessageId: sent.providerMessageId,
      subject,
      body,
      sentAt: sent.acceptedAt.toISOString(),
      createdAt: nowIso(),
    };
  } catch (error: unknown) {
    // A notification that cannot be built must not lose the alert: the alert is
    // written either way and will still appear in the feed.
    logError("notify.deliver_failed", error, { alertId: input.alertId, channel });
    return null;
  }
}

/**
 * Build the notifications for one alert.
 *
 * Returned rather than written: they are embedded in the alert document, so the
 * caller writes alert and deliveries together and there is no window where an
 * alert exists without its channel record.
 */
export async function deliverAlert(input: DeliverInput): Promise<NotificationDoc[]> {
  const subject = alertSubject(input);
  const body = alertBody(input);
  const built: (NotificationDoc | null)[] = [];

  if (input.search.notifyInApp) {
    built.push(await record(input, "in_app", null, subject, body));
  }
  if (input.search.notifyEmail) {
    built.push(await record(input, "email", DEMO_RECIPIENT_EMAIL, subject, body));
  }
  if (input.search.notifySms) {
    // An SMS carries the first line only; the rest is what the app is for.
    built.push(
      await record(
        input,
        "sms",
        DEMO_RECIPIENT_SMS,
        null,
        `${subject} - score ${input.score.toFixed(0)}`,
      ),
    );
  }

  return built.filter((entry): entry is NotificationDoc => entry !== null);
}
