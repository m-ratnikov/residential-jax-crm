/**
 * A hospital in a residential acquisition pipeline.
 *
 * ST VINCENTS HOSPITAL INC reached the Negotiating stage at $972,946 under the
 * task "Confirm both heirs will sign", and the agent returned CENTRAL CHURCH OF
 * THE NAZARENE and HOLY CROSS LUTHERAN CHURCH INC in its top 25. Nothing is
 * broken upstream: the parcels a church owns really are residential dwellings on
 * the roll - CHARISMATIC EPISCOPAL CHURCH O owns one at usage 001 with 1,702
 * livable square feet - so `dwellingsOnly` has nothing to object to, and there
 * is no owner-type column to filter on.
 *
 * So this is a labelling rule, not a filter, and it is tested as one: the rule
 * itself for what it claims and how often it is wrong, and each surface for
 * showing the label without dropping the row.
 *
 * The names below are real values from the published Duval extract.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OwnerKindBadge } from "@/components/ui";
import { OwnerContactPanel } from "@/app/opportunities/[id]/page";
import { isOrganisationOwner, ownerNameCharacter } from "@/lib/data/map";

const ORGANISATIONS = [
  // The three the reviewer named.
  "ST VINCENTS HOSPITAL INC",
  "CENTRAL CHURCH OF THE NAZARENE",
  "HOLY CROSS LUTHERAN CHURCH INC",
  // Legal forms, which is the high confidence half of the rule.
  "SP SD APARTMENTS LLC",
  "CATHEDRAL COURT INC",
  "WIT HOLDINGS GROUP LLC",
  "SEDA CONSTRUCTION CO",
  // Entities the roll's 30 character field truncated before the suffix, which
  // is why the vocabulary exists at all.
  "CHINESE CHRISTIAN CHURCH OF JA",
  "BEACH COMMUNITY DEVELOPMENT DI",
  "DUVAL COUNTY SCHOOL BOARD",
  // No suffix, and never had one.
  "EBENEZER BAPTIST CHURCH",
  "JACKSONVILLE PORT AUTHORITY",
  "JACKSONVILLE HUMANE SOCIETY",
  "CITY OF JACKSONVILLE",
  "REDHAWK HOMEOWNERS ASSOCIATION",
];

const PEOPLE = [
  "SAPP ILENE M ESTATE",
  "CHIU CHARMAINE T M",
  "CALLISON JEROME ET AL",
  "MORADIAN JAMES THOMAS",
  "BREWER JOHN R IV",
  "HUSH HERBERT JR",
  // An estate and a family trust are people, and heirs on a probate parcel are
  // the acquisition target rather than the thing to warn about. Trust and
  // estate are deliberately absent from the vocabulary.
  "KNIGHT ANN H LIFE ESTATE",
  "AARON J HOUSER TRUST",
  "LIN MING FANG TRUST",
  // Surnames that collide with the vocabulary. The roll writes people surname
  // first, so a vocabulary word in the leading position is somebody's name.
  "CO ERWIN V",
  "TEMPLE JONATHAN D",
  "PARISH WILLIAM",
  "CHURCH JOHN A",
  // And a trailing initial or generational suffix ends a person's name, which
  // is what keeps a Mr Church out when the surname is not leading.
  "SMAW CHURCH E III",
  "NWAEME TEMPLE C",
  // A Vietnamese given name that is a homeowners-association abbreviation in
  // English. "HOA" was in the first draft of the vocabulary and is not now.
  "LE HOA THI",
];

describe("the organisation-owner rule", () => {
  it("labels the owners that cost credibility on camera", () => {
    for (const name of ORGANISATIONS) {
      expect(ownerNameCharacter(name).kind, name).toBe("organisation");
    }
  });

  it("leaves people, estates and heirs alone", () => {
    for (const name of PEOPLE) {
      expect(ownerNameCharacter(name).kind, name).toBe("person");
    }
  });

  it("says which token made it decide", () => {
    expect(ownerNameCharacter("ST VINCENTS HOSPITAL INC").token).toBe("INC");
    expect(ownerNameCharacter("CENTRAL CHURCH OF THE NAZARENE").token).toBe("CHURCH");
    expect(ownerNameCharacter("CITY OF JACKSONVILLE").token).toBe("CITY OF");
    expect(ownerNameCharacter("CHIU CHARMAINE T M").token).toBeNull();
  });

  it("has an answer for an owner the roll does not publish", () => {
    expect(isOrganisationOwner(null)).toBe(false);
    expect(isOrganisationOwner("")).toBe(false);
    expect(isOrganisationOwner("   ")).toBe(false);
  });

  it("under-labels rather than guesses when the name carries no vocabulary", () => {
    // Both of these are companies and both stay "person" here. That is the
    // chosen failure direction: a missing badge costs a reviewer nothing, a
    // wrong one on a real homeowner costs the rule its credibility.
    expect(isOrganisationOwner("TKJ LLC")).toBe(true);
    expect(isOrganisationOwner("FECN")).toBe(false);
    expect(isOrganisationOwner("MILE HIGH TL BORROWER 1 CORE L")).toBe(false);
    // And the same when the only vocabulary word opens the name, because that
    // position belongs to surnames. DUVAL COUNTY SCHOOL BOARD is labelled; the
    // roll's other spelling of the same body is not.
    expect(isOrganisationOwner("SCHOOL BOARD OF DUVAL COUNTY F")).toBe(false);
  });
});

describe("the surfaces that show it", () => {
  it("renders a badge that names its own evidence", () => {
    const markup = renderToStaticMarkup(
      createElement(OwnerKindBadge, { name: "ST VINCENTS HOSPITAL INC" }),
    );
    expect(markup).toContain("organisation owner");
    expect(markup).toContain('data-testid="owner-organisation"');
    // The tooltip has to admit what it is, or a heuristic reads as a lookup.
    expect(markup).toMatch(/heuristic/i);
    expect(markup).toContain("INC");
  });

  it("renders nothing at all for a person", () => {
    expect(
      renderToStaticMarkup(createElement(OwnerKindBadge, { name: "SAPP ILENE M ESTATE" })),
    ).toBe("");
  });

  it("labels the owner on the deal page without hiding the deal", () => {
    const panel = (name: string) =>
      renderToStaticMarkup(
        createElement(OwnerContactPanel, {
          owner: {
            id: "owner-1",
            name,
            email: null,
            phone: null,
            mailingAddress: "1 SHIRCLIFF WAY",
            mailingCity: "JACKSONVILLE",
            mailingState: "FL",
            mailingZip: "32204",
            sourceSystem: "duval_appraiser",
            sourceUrl: null,
            skipTrace: null,
          },
        }),
      );

    const hospital = panel("ST VINCENTS HOSPITAL INC");
    expect(hospital).toContain('data-testid="owner-organisation"');
    // Still the whole panel: nothing is dropped on the strength of the label.
    expect(hospital).toContain("ST VINCENTS HOSPITAL INC");
    expect(hospital).toContain("1 SHIRCLIFF WAY");

    expect(panel("SAPP ILENE M ESTATE")).not.toContain('data-testid="owner-organisation"');
  });
});
