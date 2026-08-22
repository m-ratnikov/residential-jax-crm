/**
 * Counts and the nouns beside them.
 *
 * "Send to 1 owners" was the label on the button that launches an outreach
 * campaign, which is the last thing a person reads before a batch of messages
 * goes out. The cause is structural rather than a typo: `count()` returns a
 * formatted number and every caller glued its own fixed plural to it, so the
 * defect was one selection away on every screen that counts something.
 *
 * The fix is `plural()`, so these tests cover the helper and the two pieces of
 * copy that had the bug.
 */

import { describe, expect, it } from "vitest";

import { campaignCopy } from "@/app/opportunities/page";
import { count, plural } from "@/components/ui";

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(0, "owner")).toBe("0 owners");
    expect(plural(1, "owner")).toBe("1 owner");
    expect(plural(2, "owner")).toBe("2 owners");
  });

  it("takes an irregular plural, because English has them", () => {
    expect(plural(1, "saved search", "saved searches")).toBe("1 saved search");
    expect(plural(4, "saved search", "saved searches")).toBe("4 saved searches");
  });

  it("formats the number exactly as count does, separators and all", () => {
    expect(plural(1_021, "owner")).toBe(`${count(1_021)} owners`);
    expect(plural(1_021, "owner")).toContain("1,021");
  });

  it("treats a missing count as none rather than rendering NaN", () => {
    expect(plural(null, "alert")).toBe("0 alerts");
    expect(plural(undefined, "alert")).toBe("0 alerts");
    expect(plural(Number.NaN, "alert")).toBe("0 alerts");
  });
});

describe("the campaign dialog copy", () => {
  it("says 'Send to 1 owner' when one opportunity is selected", () => {
    // The exact string the deployed button got wrong.
    expect(campaignCopy(1).sendLabel).toBe("Send to 1 owner");
    expect(campaignCopy(1).subtitle).toBe("1 owner");
  });

  it("still pluralises for every other count", () => {
    expect(campaignCopy(0).sendLabel).toBe("Send to 0 owners");
    expect(campaignCopy(12).sendLabel).toBe("Send to 12 owners");
    expect(campaignCopy(12).subtitle).toBe("12 owners");
  });
});
