/**
 * What the DEAL PAGE shows about the owner.
 *
 * test/owner-contact.test.ts already proved the mocked skip trace is attached
 * on creation, reaches `GET /api/opportunities/[id]`, and is labelled in the
 * CSV. All of that passed while the deal page - the screen converting an alert
 * actually lands you on - rendered `owner.email ?? "not on file"` and never
 * looked at `skipTrace`. The assertion stopped at the API boundary, so the one
 * surface the story is about was the one surface nothing covered.
 *
 * These tests cross that boundary: the panel is rendered to markup, and the
 * last one feeds it the real API response so a regression in either half fails
 * here. The other half of the job is the labelling, so the assertions are as
 * much about what the markup must NOT say - a simulated number presented as a
 * real one, or a real mailing address absorbed into the simulated block - as
 * about what it must.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getOpportunityRoute } from "@/app/api/opportunities/[id]/route";
import { OwnerContactPanel, type DetailOwner } from "@/app/opportunities/[id]/page";
import { crmStore, setCrmStore } from "@/lib/crm/db";
import type { OwnerDoc } from "@/lib/crm/documents";
import type { OpportunityDetail } from "@/lib/crm/repo";
import { createOpportunityFromSnapshot } from "@/lib/crm/repo";
import { mockedOwnerContact, SKIP_TRACE_PROVIDER } from "@/lib/crm/skip-trace";
import { MemoryCrmStore } from "@/lib/crm/store-memory";

const HOST = "jax-crm.example.com";
const PARCEL = "1654190105R";

const PARCEL_INPUT = {
  propertyId: PARCEL,
  addressLine: "1 SOMEWHERE ST, JACKSONVILLE",
  addressCity: "JACKSONVILLE",
  ownerName: "SMITH JOHN",
  ownerMailingAddress: "PO BOX 1",
  ownerMailingCity: "ATLANTA",
  ownerMailingState: "GA",
  ownerMailingZip: "30301",
  sourceSystem: "Duval County Property Appraiser",
  sourceUrl: "https://paopropodata.coj.net/",
  propertySnapshot: {},
};

const CONTACT = mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" });

const TRACED_OWNER: DetailOwner = {
  id: "0mt3kjly274lvwt7f",
  name: "SMITH JOHN",
  email: null,
  phone: null,
  mailingAddress: "PO BOX 1",
  mailingCity: "ATLANTA",
  mailingState: "GA",
  mailingZip: "30301",
  sourceSystem: "Duval County Property Appraiser",
  sourceUrl: "https://paopropodata.coj.net/",
  skipTrace: CONTACT,
};

function render(owner: DetailOwner | null): string {
  return renderToStaticMarkup(createElement(OwnerContactPanel, { owner }));
}

/**
 * Everything inside the tinted, badged simulated block, and nothing else.
 *
 * The block ends with the `basis` paragraph, so its closing tags are the
 * boundary. Both ends are asserted rather than assumed: a component that stops
 * rendering the fence should fail this helper loudly, not quietly widen it into
 * the rest of the panel.
 */
function simulatedBlock(markup: string): string {
  const start = markup.indexOf("border-warn-500/50");
  expect(start).toBeGreaterThan(-1);
  const end = markup.indexOf("</p></div>", start);
  expect(end).toBeGreaterThan(start);
  return markup.slice(start, end);
}

beforeEach(() => {
  setCrmStore(new MemoryCrmStore());
});

describe("the owner panel on the deal page", () => {
  it("shows the simulated telephone and email instead of 'not on file'", () => {
    const markup = render(TRACED_OWNER);

    expect(markup).toContain(CONTACT.phone);
    expect(markup).toContain(CONTACT.email);
    // The exact string this panel used to render for every owner it held.
    expect(markup).not.toContain("not on file");
  });

  it("cannot show either value without saying it is simulated", () => {
    const markup = render(TRACED_OWNER);
    const block = simulatedBlock(markup);

    expect(block).toContain("simulated contact");
    expect(block).toContain("not a real phone number or email address");
    expect(block).toContain(SKIP_TRACE_PROVIDER);
    expect(block).toContain(CONTACT.basis);
    // Both values are inside the fenced block, not loose in the panel above it.
    expect(block).toContain(CONTACT.phone);
    expect(block).toContain(CONTACT.email);
    // The label reads "(mock)", not "Phone" - a bare label is what a reader
    // takes for a real number.
    expect(block).toContain("Phone (mock)");
    expect(block).toContain("Email (mock)");
  });

  it("keeps the roll's mailing address real, outside the simulated block, with its source", () => {
    const markup = render(TRACED_OWNER);

    expect(markup).toContain("PO BOX 1, ATLANTA, GA, 30301");
    expect(markup).toContain("Duval County Property Appraiser");
    // The one thing that would make the real address untrustworthy too.
    expect(simulatedBlock(markup)).not.toContain("PO BOX 1");
  });

  it("does not invent a hand-entered contact out of the simulated one", () => {
    const markup = render(TRACED_OWNER);

    expect(markup).not.toContain("Phone (entered)");
    expect(markup).not.toContain("Email (entered)");
  });

  it("shows a hand-entered contact separately when a team has entered one", () => {
    const markup = render({
      ...TRACED_OWNER,
      email: "john.smith@example.com",
      phone: "+1 904 000 0000",
    });

    expect(markup).toContain("Phone (entered)");
    expect(markup).toContain("john.smith@example.com");
    // And the simulated pair is still there, still fenced.
    expect(simulatedBlock(markup)).toContain(CONTACT.phone);
    expect(simulatedBlock(markup)).not.toContain("john.smith@example.com");
  });

  it("says so plainly when no contact is attached, rather than showing an empty field", () => {
    const markup = render({ ...TRACED_OWNER, skipTrace: null });

    expect(markup).toContain("No simulated contact is attached");
    expect(markup).not.toContain("555-01");
    expect(markup).not.toContain("border-warn-500/50");
  });

  it("says the county published no owner, rather than rendering a blank panel", () => {
    const markup = render(null);

    expect(markup).toContain("No owner record");
  });
});

describe("the deal page and the API agreeing", () => {
  /**
   * The regression this whole file exists for: the API answer and the render
   * asserted together, in one test, so neither can drift from the other again.
   */
  it("renders the contact the opportunity endpoint actually returns", async () => {
    await createOpportunityFromSnapshot(PARCEL_INPUT);

    const response = await getOpportunityRoute(
      new Request(`https://${HOST}/api/opportunities/${PARCEL}`, {
        headers: { origin: `https://${HOST}`, host: HOST, "sec-fetch-site": "same-origin" },
      }),
      { params: Promise.resolve({ id: PARCEL }) },
    );
    expect(response.status).toBe(200);

    const detail = (await response.json()) as OpportunityDetail;
    const markup = render(detail.owner as DetailOwner | null);

    expect(detail.owner?.skipTrace?.phone).toBeTruthy();
    expect(markup).toContain(detail.owner?.skipTrace?.phone as string);
    expect(markup).toContain(detail.owner?.skipTrace?.email as string);
    expect(markup).toContain("simulated contact");
    expect(markup).not.toContain("not on file");

    // And the store really did hold it, so the endpoint is not the only witness.
    const owners = await crmStore().list<OwnerDoc>("owners");
    expect(owners[0]?.skipTrace?.simulated).toBe(true);
  });
});
