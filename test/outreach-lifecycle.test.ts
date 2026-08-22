/**
 * The mocked outreach lifecycle, which had no test of its own.
 *
 * The gap was found while tracing the borrowed communication-activity pattern
 * into the code for KIT-USAGE.md: the pattern is cited, implemented and
 * documented, and nothing pinned it. That is the worst place for a gap, because
 * "simulated message lifecycle is visible" is an acceptance criterion and the
 * lifecycle is the half a reviewer cannot verify by looking at a screenshot.
 *
 * What the pattern promises, and what these pin:
 *   - a send is accepted by a provider and returns a provider message id
 *   - status events arrive later carrying that id, and are correlated back
 *   - each event is written idempotently on its own provider event id, so a
 *     redelivered event is a no-op
 *   - a terminal status cannot be superseded, and a status never moves backwards
 *   - nothing reaches a real owner
 *
 * These drive the real `sendOutreach` / `advanceOutreach` against the in-memory
 * store, so the thing under test is the lifecycle rather than a mock of it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { crmStore, setCrmStore } from "@/lib/crm/db";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { nowIso, type OpportunityDoc, type OwnerDoc } from "@/lib/crm/documents";
import { advanceOutreach, fastForwardOutreach, sendOutreach } from "@/lib/notify/outreach";
import { supersedes, type OutreachStatus } from "@/lib/notify/types";

const PARCEL = "1654190105R";

function opportunity(): OpportunityDoc {
  const at = nowIso();
  return {
    id: PARCEL,
    propertyId: PARCEL,
    parcelIdentifier: null,
    addressLine: "1 SOMEWHERE ST, JACKSONVILLE",
    addressCity: "JACKSONVILLE",
    addressZip: "32207",
    latitude: null,
    longitude: null,
    assessedValue: 180_000,
    ownerNameSnapshot: "SMITH JOHN",
    propertySnapshot: { yearsSinceLastSale: 21 },
    ownerId: "owner1",
    stage: "identified",
    savedSearchId: null,
    alertId: null,
    matchScore: 88,
    matchRationale: null,
    assigneeId: null,
    ownerInterest: null,
    askingPrice: null,
    offerPrice: null,
    nextStep: null,
    nextStepDueAt: null,
    stageEvents: [],
    notes: [],
    tasks: [],
    outreach: [],
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
}

function owner(): OwnerDoc {
  return {
    id: "owner1",
    name: "SMITH JOHN",
    mailingAddress: "PO BOX 1",
    mailingCity: "JACKSONVILLE",
    mailingState: "FL",
    mailingZip: "32207",
    email: null,
    phone: null,
    sourceSystem: "duval_appraiser",
    sourceUrl: "https://example.invalid/parcel",
    notes: null,
    createdAt: nowIso(),
  };
}

async function seed(): Promise<void> {
  setCrmStore(new MemoryCrmStore());
  const store = crmStore();
  await store.put<OpportunityDoc>("opportunities", opportunity());
  await store.put<OwnerDoc>("owners", owner());
}

async function outreachOf() {
  const store = crmStore();
  const doc = await store.get<OpportunityDoc>("opportunities", PARCEL);
  return doc?.outreach ?? [];
}

/** Far enough ahead that every scheduled event of every channel is due. */
const WELL_PAST = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

describe("mocked outreach lifecycle", () => {
  beforeEach(seed);

  it("accepts a send and returns a provider message id that cannot pass for real", async () => {
    const result = await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "email",
      templateId: "cash-offer-intro",
    });

    expect(result.sent).toBe(1);
    expect(result.skipped).toEqual([]);

    const [message] = await outreachOf();
    expect(message).toBeDefined();
    // The `sim_` prefix is the guarantee that nothing downstream, and nobody
    // reading a log, can mistake this for a real provider's id.
    expect(message?.providerMessageId).toMatch(/^sim_email_[0-9a-f]{20}$/);
  });

  it("addresses only reserved destinations, never a real owner", async () => {
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "email",
      templateId: "cash-offer-intro",
    });
    const [email] = await outreachOf();
    // RFC 2606 reserves .invalid precisely so it can never resolve.
    expect(email?.toAddress).toMatch(/\.invalid$/);

    await seed();
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "sms",
      templateId: "cash-offer-intro",
    });
    const [sms] = await outreachOf();
    // NANP fiction range, or the documented fallback.
    expect(sms?.toAddress).toMatch(/555-01\d\d$|\+1-904-555-0000/);
  });

  it("correlates later events back to the message by provider id", async () => {
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "email",
      templateId: "cash-offer-intro",
    });
    const [message] = await outreachOf();
    const id = message?.providerMessageId;
    expect(message?.events.length).toBeGreaterThan(0);

    // Correlation here is by containment plus the event id, not by a repeated
    // field: the event is stored inside the message it belongs to, and its
    // `providerEventId` is `<providerMessageId>:<status>`, so the join a real
    // webhook would arrive with is recoverable from the id alone. That is what
    // makes the write idempotent on the event rather than on the message.
    const eventIds = (message?.events ?? []).map((event) => event.providerEventId);
    for (const eventId of eventIds) {
      expect(eventId.startsWith(`${id}:`)).toBe(true);
    }
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("walks the status forward as scheduled time passes, never backwards", async () => {
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "email",
      templateId: "cash-offer-intro",
    });

    const [initial] = await outreachOf();
    expect(initial?.status).toBe("sent");

    await advanceOutreach(WELL_PAST);
    const [advanced] = await outreachOf();

    // Which terminal status a message reaches is seeded from its own id, so
    // this asserts the invariant rather than one particular outcome.
    expect(advanced?.status).not.toBe("sent");
    expect(supersedes(advanced?.status as OutreachStatus, "sent")).toBe(true);
  });

  it("is idempotent: replaying the same events changes nothing", async () => {
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "email",
      templateId: "cash-offer-intro",
    });

    const first = await advanceOutreach(WELL_PAST);
    expect(first.messagesAdvanced).toBe(1);
    const [settled] = await outreachOf();

    // A redelivered event is the normal case for a real provider, not an edge
    // case: the same events are re-applied and must move nothing.
    const second = await advanceOutreach(WELL_PAST);
    expect(second.messagesAdvanced).toBe(0);

    const [again] = await outreachOf();
    expect(again?.status).toBe(settled?.status);
    expect(again?.statusAt).toBe(settled?.statusAt);
    expect(again?.events.length).toBe(settled?.events.length);
  });

  it("cannot supersede a terminal status", async () => {
    // The rule the advance loop enforces, stated directly: once a message has
    // bounced or replied, nothing later moves it, and no status moves back.
    expect(supersedes("delivered", "bounced")).toBe(false);
    expect(supersedes("opened", "replied")).toBe(false);
    expect(supersedes("sent", "delivered")).toBe(false);
    expect(supersedes("delivered", "sent")).toBe(true);
  });

  it("fast forward applies the schedule rather than inventing an outcome", async () => {
    await sendOutreach({
      opportunityIds: [PARCEL],
      channel: "direct_mail",
      templateId: "cash-offer-intro",
    });

    const [scheduled] = await outreachOf();
    const planned = (scheduled?.events ?? []).map((event) => event.status);
    expect(scheduled?.status).toBe("sent");

    // Direct mail is deliberately the slowest channel, so this is the case a
    // demo cannot sit through. Fast forward may only pull the scheduled times
    // in - the events themselves, and so the outcome, must be untouched. Two
    // separate sends cannot be compared here: each mints its own idempotency
    // key, and the terminal status is seeded from the id that produces, so
    // different outcomes between two sends are correct rather than a defect.
    await fastForwardOutreach();
    const [fast] = await outreachOf();

    expect(fast?.events.map((event) => event.status)).toEqual(planned);
    expect(fast?.status).toBe(planned.at(-1));
    // Nothing is left scheduled in the future, which is what "fast" means.
    const now = new Date().toISOString();
    for (const event of fast?.events ?? []) expect(event.occurredAt <= now).toBe(true);
  });

  it("skips an opportunity that does not exist rather than failing the campaign", async () => {
    const result = await sendOutreach({
      opportunityIds: [PARCEL, "no-such-parcel"],
      channel: "email",
      templateId: "cash-offer-intro",
    });

    expect(result.sent).toBe(1);
    expect(result.skipped).toEqual([
      { opportunityId: "no-such-parcel", reason: "no such opportunity" },
    ]);
  });
});
