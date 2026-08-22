/**
 * The owner contact, and the line between what is real and what is not.
 *
 * The assignment says owner contact details are attached when an opportunity is
 * created. The Duval roll publishes an owner of record and a mailing address
 * and nothing else, so the CRM used to say "not on file" for the telephone and
 * the email on every record it held - which is the one detail an acquisitions
 * team opens a deal for.
 *
 * What is attached instead is a MOCKED skip trace, and the whole risk in doing
 * that is somebody taking a generated number for a real one. So these tests are
 * as much about the labelling as about the values: the reserved ranges, the
 * `simulated` flag in the stored document, the CSV columns that say so in their
 * names, and the mailing address staying in its own fields with its own
 * provenance.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GET as exportCsv } from "@/app/api/export/route";
import { GET as getProperty } from "@/app/api/property/[id]/route";
import { POST as createOpportunityRoute } from "@/app/api/opportunities/route";
import { GET as getOpportunityRoute } from "@/app/api/opportunities/[id]/route";

import { crmStore, setCrmStore } from "@/lib/crm/db";
import type { OwnerDoc } from "@/lib/crm/documents";
import { createOpportunityFromSnapshot, type OpportunityDetail } from "@/lib/crm/repo";
import { isMockedContact, mockedOwnerContact, SKIP_TRACE_PROVIDER } from "@/lib/crm/skip-trace";
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

function request(path: string, body?: unknown, method = "GET"): Request {
  return new Request(`https://${HOST}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: `https://${HOST}`,
      host: HOST,
      "sec-fetch-site": "same-origin",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * A real RFC 4180 reader, not a split on commas: the situs address is a quoted
 * cell containing a comma, so a naive split shifts every column after it.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else cell += character;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function ownerOfRecord(): Promise<OwnerDoc> {
  const owners = await crmStore().list<OwnerDoc>("owners");
  const owner = owners[0];
  if (!owner) throw new Error("no owner document was written");
  return owner;
}

beforeEach(() => {
  setCrmStore(new MemoryCrmStore());
});

describe("the mocked skip trace", () => {
  it("is stable across runs, because it is derived from the parcel and the owner", () => {
    const once = mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" });
    const again = mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" });

    expect(again).toEqual(once);
  });

  it("gives two owners at two parcels two different contacts", () => {
    const first = mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" });
    const sameNameElsewhere = mockedOwnerContact({
      propertyId: "0421-00-0010",
      ownerName: "SMITH JOHN",
    });
    const otherName = mockedOwnerContact({ propertyId: PARCEL, ownerName: "DOE JANE" });

    expect(sameNameElsewhere.email).not.toBe(first.email);
    expect(otherName.email).not.toBe(first.email);
  });

  it("can never be delivered to or dialled", () => {
    for (const owner of ["SMITH JOHN", "DOE JANE", "RIVERBEND HOLDINGS LLC", null]) {
      const contact = mockedOwnerContact({ propertyId: PARCEL, ownerName: owner });

      // RFC 2606 reserves `.invalid` so it can never resolve, and the domain
      // says what produced it in words.
      expect(contact.email.endsWith("@mocked-skip-trace.invalid")).toBe(true);
      // NANP reserves 555-0100 to 555-0199 for fiction.
      expect(contact.phone).toMatch(/^\(904\) 555-01\d{2}$/);
    }
  });

  it("says it is simulated in the value itself, not only in a comment", () => {
    const contact = mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" });

    expect(contact.simulated).toBe(true);
    expect(contact.provider).toBe(SKIP_TRACE_PROVIDER);
    expect(contact.label.toLowerCase()).toContain("simulated");
    expect(isMockedContact(contact)).toBe(true);
    expect(isMockedContact({ email: "someone@example.com" })).toBe(false);
  });
});

describe("attaching it to an opportunity", () => {
  it("attaches a contact when the opportunity is created", async () => {
    const response = await createOpportunityRoute(
      request("/api/opportunities", PARCEL_INPUT, "POST"),
    );
    expect(response.status).toBe(201);

    const owner = await ownerOfRecord();
    expect(owner.skipTrace).toEqual(
      mockedOwnerContact({ propertyId: PARCEL, ownerName: "SMITH JOHN" }),
    );
  });

  it("keeps the roll's mailing address real, in its own fields, with its provenance", async () => {
    await createOpportunityFromSnapshot(PARCEL_INPUT);
    const owner = await ownerOfRecord();

    expect(owner.mailingAddress).toBe("PO BOX 1");
    expect(owner.mailingCity).toBe("ATLANTA");
    expect(owner.sourceSystem).toBe("Duval County Property Appraiser");
    expect(owner.sourceUrl).toBe("https://paopropodata.coj.net/");

    // The simulated values never reach the fields a team enters by hand, and
    // never reach the mailing address.
    expect(owner.email).toBeNull();
    expect(owner.phone).toBeNull();
    expect(JSON.stringify(owner.mailingAddress)).not.toContain("invalid");
  });

  it("backfills an owner document written before the skip trace existed", async () => {
    // Exactly the shape the store held before this feature.
    await crmStore().put<OwnerDoc>("owners", {
      id: "0mt3kjly274lvwt7f",
      name: "SMITH JOHN",
      mailingAddress: "PO BOX 1",
      mailingCity: "ATLANTA",
      mailingState: "GA",
      mailingZip: "30301",
      email: null,
      phone: null,
      sourceSystem: "Duval County Property Appraiser",
      sourceUrl: null,
      notes: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    await createOpportunityFromSnapshot(PARCEL_INPUT);

    const owner = await ownerOfRecord();
    expect(owner.id).toBe("0mt3kjly274lvwt7f");
    expect(owner.skipTrace?.simulated).toBe(true);
  });

  it("never overwrites a contact a team entered by hand", async () => {
    await createOpportunityFromSnapshot(PARCEL_INPUT);
    const owner = await ownerOfRecord();

    await crmStore().put<OwnerDoc>("owners", {
      ...owner,
      email: "john.smith@example.com",
      phone: "+1 904 000 0000",
    });

    // A second parcel for the same owner runs the upsert again.
    await createOpportunityFromSnapshot({ ...PARCEL_INPUT, propertyId: "0421-00-0010" });

    const after = await ownerOfRecord();
    expect(after.email).toBe("john.smith@example.com");
    expect(after.phone).toBe("+1 904 000 0000");
  });
});

describe("surfacing it", () => {
  beforeEach(async () => {
    await createOpportunityFromSnapshot(PARCEL_INPUT);
  });

  it("reaches the drawer through GET /api/property/[id]", async () => {
    const response = await getProperty(request(`/api/property/${PARCEL}`), params(PARCEL));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { owner: OwnerDoc | null };
    expect(body.owner?.skipTrace?.simulated).toBe(true);
    expect(body.owner?.skipTrace?.phone).toMatch(/^\(904\) 555-01\d{2}$/);
    // The real half arrives on the same document, in different fields.
    expect(body.owner?.mailingAddress).toBe("PO BOX 1");
  });

  it("reaches the opportunity detail through GET /api/opportunities/[id]", async () => {
    const response = await getOpportunityRoute(
      request(`/api/opportunities/${PARCEL}`),
      params(PARCEL),
    );
    expect(response.status).toBe(200);

    const detail = (await response.json()) as OpportunityDetail;
    expect(detail.owner?.skipTrace?.provider).toBe(SKIP_TRACE_PROVIDER);
    expect(detail.owner?.skipTrace?.label.toLowerCase()).toContain("simulated");
  });

  it("labels the columns in the CSV, where there is no tooltip to explain them", async () => {
    const response = await exportCsv(request("/api/export?kind=opportunities"));
    const rows = parseCsv(await response.text());
    const headers = rows[0] ?? [];
    const cells = rows[1] ?? [];

    const cell = (name: string): string => cells[headers.indexOf(name)] ?? "";

    expect(headers).toContain("owner_email_simulated");
    expect(headers).toContain("owner_phone_simulated");
    expect(cell("owner_email_simulated")).toContain("@mocked-skip-trace.invalid");
    expect(cell("owner_phone_simulated")).toContain("555-01");

    // The two columns reserved for hand-entered detail stay empty rather than
    // being quietly filled with a number nobody can call.
    expect(cell("owner_email")).toBe("");
    expect(cell("owner_phone")).toBe("");
    // And the mailing address is still the real one.
    expect(cell("owner_mailing_address")).toBe("PO BOX 1");
  });
});
