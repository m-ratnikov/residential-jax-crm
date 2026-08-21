/**
 * One JSON line per event on stdout.
 *
 * The Golden Path asks for Powertools Logger, CloudWatch and X-Ray. None of
 * those exist here because there is no AWS in this deployment, so the part that
 * transfers - structured, machine readable, one event per line, never a secret
 * - is kept and the transport is whatever collects stdout.
 */

const ENABLED = process.env.CRM_LOG !== "off";

export type LogFields = Record<string, unknown>;

export function logEvent(event: string, fields: LogFields = {}): void {
  if (!ENABLED) return;
  const line = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  logEvent(event, {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
  });
}
