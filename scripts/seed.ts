/**
 * Seed a working acquisitions team.
 *
 * A CRM a reviewer opens for the first time should not be empty. An empty board
 * proves nothing: it cannot show a funnel, a stage history, an outreach
 * lifecycle or a filter that does anything. So this creates a small team, three
 * real acquisition theses as saved searches, and then works a set of genuine
 * parcels - drawn from the loaded dataset, not invented - through the stages,
 * with notes, tasks, offers and mocked outreach behind them.
 *
 * Everything it writes is CRM state. No property record is fabricated: every
 * opportunity points at a parcel that exists in the published data, and every
 * value shown about that parcel is read from it.
 *
 * Three properties of the seeded board are load bearing, because a demo fixture
 * that contradicts the application is worse than no fixture at all:
 *
 * 1. **Every score is computed by the live scoring engine, here, now.** There is
 *    no score literal in this file and no carried-over number. A previous seed
 *    stored scores produced by an older model - threshold-step credit, and
 *    credit for signals the WHERE clause already guaranteed - so ten of eleven
 *    deals read exactly 100 long after the model had been replaced. Under the
 *    current model a ranked set tops out in the eighties and exactly 100 means
 *    "the criteria could not rank at all", so the board was advertising the
 *    defect that had been fixed. `unfitReason` below refuses to seed a row that
 *    scores 100 rather than storing one, and `reportBoard` fails the run if one
 *    somehow reaches the store.
 *
 * 2. **The deals are picked under the ordering the application uses today.** The
 *    old default tiebreak was `property_id`, which is plat order, so the board
 *    filled with Baldwin parcels at the far western county edge. Selection here
 *    goes through `source.search({ orderBy: "score" })` - the same call the map
 *    and the matcher make - and then spreads the picks across ZIPs, so no single
 *    postcode owns the board.
 *
 * 3. **Lineage is produced, not written.** Some seeded opportunities carry a
 *    real `alert_id`, and through it a real `matcher_run_id`, because the seed
 *    applies a genuine simulated pipeline update and runs an ordinary matcher
 *    pass over it. Nothing sets those fields directly.
 *
 *   PROPERTY_DATA_URL=... pnpm seed
 *   PROPERTY_DATA_URL=... pnpm seed --reset
 *   pnpm seed --memory --reset      # in-process store, for checking the shape
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CRITERIA_PRESETS, type CriteriaSet } from "@/lib/criteria/types";
import { DWELLING_MIN_SQFT } from "@/lib/criteria/sql";
import { getPropertyDataSource } from "@/lib/data/source";
import { displayAddress } from "@/lib/data/map";
import type { ScoredProperty } from "@/lib/data/types";
import { crmStore, setCrmStore, storeStatus } from "@/lib/crm/db";
import { memoryStore } from "@/lib/crm/store-memory";
import { COLLECTIONS } from "@/lib/crm/store";
import type { AlertDoc, OpportunityDoc, SavedSearchDoc } from "@/lib/crm/documents";
import { loadOverlay } from "@/lib/crm/overlay";
import { applySimulation } from "@/lib/crm/simulate";
import {
  addNote,
  addTask,
  createOpportunityFromSnapshot,
  createSavedSearch,
  createTeamMember,
  listOpportunities,
  updateOpportunity,
} from "@/lib/crm/repo";
import { alertSnapshot, runMatcher } from "@/lib/notify/matcher";
import { sendOutreach } from "@/lib/notify/outreach";
import type { AcquisitionStage } from "@/lib/notify/types";

function loadEnvFile(): void {
  for (const name of [".env.local", ".env"]) {
    try {
      const contents = readFileSync(resolve(process.cwd(), name), "utf8");
      for (const line of contents.split("\n")) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (!key || process.env[key]) continue;
        process.env[key] = (rawValue ?? "").replace(/^["']|["']$/g, "");
      }
    } catch {
      // Absent is fine.
    }
  }
}

const TEAM = [
  { name: "Dana Whitfield", email: "dana@riverbend.example", role: "principal" },
  { name: "Marcus Iyer", email: "marcus@riverbend.example", role: "acquisitions" },
  { name: "Priya Raman", email: "priya@riverbend.example", role: "acquisitions" },
  { name: "Tom Okafor", email: "tom@riverbend.example", role: "analyst" },
];

/** Which presets to save, and how each should be watched. */
const WATCHED = [
  { presetId: "tired-landlord", email: true, sms: false },
  { presetId: "aging-roof-value-band", email: true, sms: false },
  { presetId: "transit-infill", email: false, sms: false },
];

/* ------------------------------------------------------------------ */
/* Which parcels are allowed onto the board                            */
/* ------------------------------------------------------------------ */

/**
 * The oldest sale date this seed will believe.
 *
 * The county roll carries a placeholder where a parcel has no recorded sale,
 * and it is not null: it is 1899-01-01, 1899-12-30 or 1900-09-13, three
 * spreadsheet epoch artifacts. The pipeline turns those into a tenure of 125 to
 * 127 years, which is the single strongest thing a tenure-weighted thesis can
 * score on, so on the published roll they float straight to the top of every
 * long-hold ranking and the board fills with "held 127 years" on houses built
 * in 1986.
 *
 * The right fix is upstream, at the point the sentinel is read. This guard is
 * here anyway and deliberately does not depend on that fix landing: a demo board
 * has to be defensible parcel by parcel on its own, not on the assumption that
 * somebody else's change is in the build.
 */
const SALE_YEAR_FLOOR = 1950;

/** Longer than this is a data artifact, not an owner. */
const MAX_PLAUSIBLE_TENURE_YEARS = 75;

/**
 * Past this, "roof age" is describing the house rather than a roof.
 *
 * Most of the roll has no re-roof permit, so roof age is estimated from the year
 * built, and on a 1928 house that estimate reads "roof about 96 years old". It
 * is honestly labelled everywhere it is shown, and it is still not a sentence
 * anyone should have to defend on a demo board next to a photograph of a house
 * with a roof on it. Seventy five is comfortably past `ROOF_FULL_YEARS`, the
 * point at which the scoring model itself stops paying for more age, so
 * excluding these costs the ranking almost nothing.
 */
const MAX_PLAUSIBLE_ROOF_AGE_YEARS = 75;

/** How many deals one postcode may own. The board is a market, not a street. */
const MAX_DEALS_PER_ZIP = 2;

/**
 * How deep to look for board-worthy parcels before giving up. Ranked order is
 * preserved; this only bounds the read.
 */
const CANDIDATE_POOL = 400;

/** The sale year behind a parcel's tenure, whichever column carries it. */
function saleYearOf(property: ScoredProperty["property"]): number | null {
  const candidates = [
    property.lastSaleDate,
    property.raw["last_sale_date_any"],
    property.raw["coj_last_sale_date"],
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const year = Number(value.slice(0, 4));
    if (Number.isFinite(year) && year > 0) return year;
  }
  return null;
}

/**
 * Why a parcel is not fit to be a seeded deal, or null when it is.
 *
 * Every test here is about the parcel being *defensible on a screen* - a person
 * reading the row can check the number against the house - rather than about
 * making the board look tidy. A rejection reason is returned instead of a
 * boolean so the run log can say what it threw away and why.
 */
function unfitReason(scored: ScoredProperty, thisYear: number): string | null {
  const property = scored.property;

  // A score of exactly 100 is the current model saying "these criteria cannot
  // rank", and an empty component list is the same fact from the other side.
  // Seeding either one would put the pre-fix symptom back on the board.
  if (!scored.components.length) return "the criteria produced no ranking components";
  if (scored.score >= 100) return `unrankable score ${scored.score}`;

  if (property.latitude === null || property.longitude === null) return "no coordinates to map";
  if (!property.addressStreet) return "no street address";
  if (!property.addressZip) return "no ZIP";

  // The same judgement `dwellingsOnly` makes, plus the per-square-foot test the
  // ordering uses: a condominium garage unit assessed at a dollar is residential,
  // absentee owned and never homesteaded, and it is not an acquisition.
  const area = property.livableFloorArea;
  const assessed = property.assessedValue;
  if (area === null || area < DWELLING_MIN_SQFT) return "not a dwelling the roll has measured";
  if (assessed === null || assessed <= 0) return "no assessed value";
  if (assessed < area) return "assessed below a dollar per livable foot, a placeholder value";

  const tenure = property.yearsSinceLastSale;
  if (tenure === null) return "no ownership tenure published";
  if (tenure > MAX_PLAUSIBLE_TENURE_YEARS) return `implausible tenure of ${tenure} years`;

  const saleYear = saleYearOf(property);
  if (saleYear !== null && saleYear < SALE_YEAR_FLOOR) {
    return `sale year ${saleYear} is a no-sale sentinel`;
  }

  // Held longer than the house has stood. Catches the sentinel even where the
  // date column has already been nulled out and only the derived tenure is left.
  if (property.builtYear === null) return "no year built to check the tenure against";
  if (tenure > thisYear - property.builtYear + 1) {
    return `held ${tenure} years on a house built in ${property.builtYear}`;
  }

  if (property.roofAgeYears !== null && property.roofAgeYears > MAX_PLAUSIBLE_ROOF_AGE_YEARS) {
    return `implausible roof age of ${property.roofAgeYears} years`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* The board                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where each seeded opportunity ends up, and the story behind it.
 *
 * Prices are factors of the parcel's own assessed value rather than literals.
 * They used to be literals, and a literal asking price is a contradiction
 * waiting to happen: "owner wants 235k" printed beside a parcel the roll
 * assesses at 74,000 is the sort of thing a reviewer notices in four seconds.
 * `{asking}` and `{offer}` in a note are filled with the numbers actually
 * stored on the deal.
 */
const JOURNEYS: {
  stage: AcquisitionStage;
  note: string;
  nextStep?: string;
  /** Asking price as a multiple of the parcel's assessed value. */
  askingFactor?: number;
  /** Offer as a multiple of the asking price. */
  offerFactor?: number;
  interest?: string;
  task?: string;
  outreach?: "email" | "sms" | "direct_mail";
}[] = [
  {
    stage: "identified",
    note: "Pulled from the tired landlord list. Roof is well past its life and the owner mails somewhere else.",
    nextStep: "Skip trace the mailing address",
    task: "Skip trace owner",
  },
  {
    stage: "identified",
    note: "Different submarket to the rest of the list, and the numbers still work. Worth a letter.",
    outreach: "direct_mail",
  },
  {
    stage: "contacted",
    note: "Letter went out last week. No reply yet.",
    nextStep: "Follow up if nothing by Friday",
    outreach: "email",
    task: "Follow up call",
  },
  {
    stage: "contacted",
    note: "Owner answered the SMS asking who we are. Warm enough to keep going.",
    interest: "Curious, not committed",
    outreach: "sms",
  },
  {
    stage: "negotiating",
    note: "Owner wants {asking}. Comps in the neighbourhood do not support it with this roof, so we are at {offer}.",
    interest: "Motivated, unrealistic on price",
    askingFactor: 1.35,
    offerFactor: 0.78,
    nextStep: "Send the roof quote and re-offer",
    outreach: "email",
    task: "Get a re-roof quote",
  },
  {
    stage: "negotiating",
    note: "Probate is the driver here. Two heirs, one out of state, both want it gone. Asking {asking}, we are at {offer}.",
    interest: "Motivated by an estate",
    askingFactor: 1.05,
    offerFactor: 0.9,
    nextStep: "Confirm both heirs will sign",
  },
  {
    stage: "under_contract",
    note: "Signed at {offer} against an asking of {asking}. Inspection window closes in nine days.",
    askingFactor: 1.1,
    offerFactor: 0.88,
    nextStep: "Inspection Tuesday",
    task: "Book inspection",
  },
  {
    stage: "closed",
    note: "Closed at {offer}. Roof replaced before the tenant moved in.",
    askingFactor: 1.0,
    offerFactor: 0.86,
  },
  {
    stage: "dead",
    note: "Owner listed with an agent two days after our letter. Not our deal.",
    interest: "Went to market",
  },
];

/** Prices are quoted to the nearest five hundred, the way an offer letter is. */
function roundMoney(value: number): number {
  return Math.max(500, Math.round(value / 500) * 500);
}

/** One selected deal: the parcel, the thesis it came from, and its story. */
interface SelectedDeal {
  scored: ScoredProperty;
  searchId: string;
  searchName: string;
  journey: (typeof JOURNEYS)[number];
}

/**
 * Pick the board.
 *
 * Ranked order inside each saved search is the application's own ordering, taken
 * straight from `orderBy: "score"`. What this adds on top is a round robin
 * across the theses and a cap per ZIP, which is the difference between a board
 * and a printout of one query: an acquisitions team working three theses has
 * deals from all three, spread over the submarkets it actually farms.
 */
function chooseDeals(
  pools: { searchId: string; searchName: string; rows: readonly ScoredProperty[] }[],
  wanted: number,
): SelectedDeal[] {
  const chosen: SelectedDeal[] = [];
  const takenParcels = new Set<string>();
  const perZip = new Map<string, number>();
  const cursors = pools.map(() => 0);

  // Two sweeps. The first honours the ZIP cap; the second fills any shortfall
  // without it, so a thin dataset still produces a full board rather than a
  // half empty one - and says so, because the summary prints every ZIP.
  for (const capped of [true, false]) {
    let progress = true;
    while (chosen.length < wanted && progress) {
      progress = false;
      for (const [poolIndex, pool] of pools.entries()) {
        if (chosen.length >= wanted) break;
        let cursor = cursors[poolIndex] ?? 0;
        while (cursor < pool.rows.length) {
          const scored = pool.rows[cursor];
          cursor += 1;
          if (!scored) continue;
          const parcelId = scored.property.propertyId;
          if (takenParcels.has(parcelId)) continue;
          const zip = scored.property.addressZip ?? "";
          if (capped && (perZip.get(zip) ?? 0) >= MAX_DEALS_PER_ZIP) continue;

          takenParcels.add(parcelId);
          perZip.set(zip, (perZip.get(zip) ?? 0) + 1);
          chosen.push({
            scored,
            searchId: pool.searchId,
            searchName: pool.searchName,
            journey: JOURNEYS[chosen.length] as (typeof JOURNEYS)[number],
          });
          progress = true;
          break;
        }
        cursors[poolIndex] = cursor;
      }
    }
    if (chosen.length >= wanted) break;
    // Rewind for the uncapped sweep.
    cursors.fill(0);
  }

  return chosen;
}

/* ------------------------------------------------------------------ */
/* Store                                                                */
/* ------------------------------------------------------------------ */

async function reset(): Promise<void> {
  const store = crmStore();
  for (const collection of COLLECTIONS) await store.clear(collection);
  console.log("cleared existing CRM state");
}

/** What is already in the store, so a re-seed cannot quietly half-replace it. */
async function existingState(): Promise<{ opportunities: number; alerts: number }> {
  const store = crmStore();
  const [opportunities, alerts] = await Promise.all([
    store.list<OpportunityDoc>("opportunities"),
    store.list<AlertDoc>("alerts"),
  ]);
  return { opportunities: opportunities.length, alerts: alerts.length };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  loadEnvFile();

  const args = new Set(process.argv.slice(2));
  // An explicit in-process store, so the seed can be exercised end to end
  // without a token and without touching a shared backend. It has to be
  // installed before anything calls crmStore(), which caches its choice.
  if (args.has("--memory")) {
    setCrmStore(memoryStore());
    console.log("using an in-process store: nothing written here survives this script");
  }

  const status = storeStatus();
  console.log(`crm store: ${status.kind} (${status.location})`);

  if (!status.writable) {
    console.error("The store is read only. Set CRM_STORE_TOKEN, or DATABASE_URL for Postgres.");
    process.exit(2);
  }
  if (status.ephemeral) {
    console.warn(
      "WARNING: the store is in-process only, so anything seeded here disappears when this script exits.",
    );
  }

  const before = await existingState();
  if (args.has("--reset")) {
    await reset();
  } else if ((before.opportunities > 0 || before.alerts > 0) && !args.has("--keep-existing")) {
    // Seeding on top of an existing board is how a stale fixture survives a
    // fix: the old opportunities keep their old scores and their old rationales,
    // and the two generations sit side by side looking equally current. Refusing
    // is the honest option, and the flag that says otherwise is one word.
    console.error(
      `This store already holds ${before.opportunities} opportunities and ${before.alerts} alerts.\n` +
        "Seeding on top of them would leave two generations of CRM state on one board:\n" +
        "the older rows keep the scores and rationales the model that produced them gave.\n" +
        "Re-run with --reset to replace it, or --keep-existing to add to it deliberately.",
    );
    process.exit(3);
  }

  const { source } = getPropertyDataSource();
  const info = await source.info();
  console.log(`seeding against ${info.label}: ${info.rowCount.toLocaleString("en-US")} parcels`);
  if (info.isSample) {
    console.warn(
      "WARNING: no artifact URL is configured, so this board is being seeded from the bundled sample.",
    );
  }

  const members = [];
  for (const member of TEAM) members.push(await createTeamMember(member));
  console.log(`created ${members.length} team members`);

  const created: { id: string; name: string; criteria: CriteriaSet }[] = [];
  for (const [index, watched] of WATCHED.entries()) {
    const preset = CRITERIA_PRESETS.find((entry) => entry.id === watched.presetId);
    if (!preset) continue;
    const search = await createSavedSearch({
      name: preset.name,
      description: preset.description,
      criteria: preset.criteria,
      ownerId: members[index % members.length]?.id ?? null,
      notifyInApp: true,
      notifyEmail: watched.email,
      notifySms: watched.sms,
    });
    created.push({ id: search.id, name: search.name, criteria: preset.criteria });
  }
  console.log(`saved ${created.length} criteria sets`);

  if (!created.length) {
    console.log("no saved searches to draw opportunities from");
    await source.close();
    return;
  }

  // Baseline every saved search, so the board is populated but the alert feed is
  // not full of parcels that have simply always matched.
  //
  // The result is inspected rather than assumed. A search that fails to baseline
  // - a gateway timing out mid-scan is the common one - is not an error the pass
  // throws, it is an outcome carrying an error, and the consequence lands much
  // later and looks like something else: the next pass finds an empty snapshot,
  // treats the search as new, seeds it silently and raises no alert, so the
  // board ends up with no lineage and nothing says why. It is retried once here,
  // and said out loud if it still will not evaluate.
  const baseline = await runMatcher(source, { trigger: "manual" });
  const baselined = new Map(baseline.outcomes.map((outcome) => [outcome.savedSearchId, outcome]));
  const unbaselined = baseline.outcomes.filter(
    (outcome) => outcome.error || outcome.evaluated === 0,
  );
  if (unbaselined.length) {
    console.warn(
      `retrying ${unbaselined.length} searches that did not baseline: ` +
        unbaselined.map((outcome) => `${outcome.name} (${outcome.error ?? "no rows"})`).join("; "),
    );
    const retry = await runMatcher(source, {
      trigger: "manual",
      savedSearchIds: unbaselined.map((outcome) => outcome.savedSearchId),
    });
    for (const outcome of retry.outcomes) baselined.set(outcome.savedSearchId, outcome);
  }
  for (const outcome of baselined.values()) {
    console.log(
      `  baselined ${outcome.name}: ${outcome.matched.toLocaleString("en-US")} matched, ` +
        `${outcome.trackedMatches.toLocaleString("en-US")} watched` +
        (outcome.error ? ` - FAILED: ${outcome.error}` : ""),
    );
  }

  /* ---------------- select the deals ---------------- */

  const thisYear = new Date().getFullYear();
  const overlayBefore = await loadOverlay();
  const pools: { searchId: string; searchName: string; rows: ScoredProperty[] }[] = [];
  const rejected = new Map<string, number>();

  for (const search of created) {
    const found = await source.search({
      criteria: search.criteria,
      limit: CANDIDATE_POOL,
      orderBy: "score",
      overlay: overlayBefore.overlay,
    });

    const fit: ScoredProperty[] = [];
    for (const scored of found.rows) {
      const reason = unfitReason(scored, thisYear);
      if (reason) {
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
        continue;
      }
      fit.push(scored);
    }

    console.log(
      `  ${search.name}: ${found.total.toLocaleString("en-US")} matched, ` +
        `${fit.length} of the top ${found.rows.length} are board-worthy`,
    );
    if (fit.length) pools.push({ searchId: search.id, searchName: search.name, rows: fit });
  }

  if (rejected.size) {
    const summary = [...rejected.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([reason, count]) => `${count} ${reason}`)
      .join("; ");
    console.log(`  set aside as not defensible: ${summary}`);
  }

  const deals = chooseDeals(pools, JOURNEYS.length);
  if (!deals.length) {
    console.log("no parcel in this dataset was fit to seed as a deal; no opportunities created");
    await source.close();
    return;
  }
  console.log(`selected ${deals.length} deals across ${pools.length} theses`);

  /* ---------------- produce real lineage ---------------- */

  // Some of the board has to have arrived the way the application says deals
  // arrive: an alert raised by a matcher pass, converted into an opportunity.
  // Writing `alertId` directly would prove nothing, so the seed makes a real
  // change to the data and lets the ordinary matcher find it by diffing - the
  // same path a county refresh takes.
  //
  // Only parcels in a thesis with no assessed-value ceiling are used, because
  // the change applied is a reassessment: bumping a parcel out of the band its
  // own saved search filters on would drop it from the match set, and a parcel
  // that has left a search cannot raise an updated-match alert for it.
  const lineageTargets = deals
    .filter((deal) => {
      const criteria = created.find((entry) => entry.id === deal.searchId)?.criteria;
      return criteria?.filters.maxAssessedValue === undefined;
    })
    .slice(0, 3);

  const simulationRunIds: string[] = [];
  for (const deal of lineageTargets) {
    const property = deal.scored.property;
    // One call per parcel on purpose: `applySimulation` picks the kind of change
    // by position, and a reassessment is the only one of the three that leaves
    // the parcel inside a tenure-and-roof thesis afterwards. A re-roof resets
    // roof age to zero and a transfer resets tenure to zero, and either one
    // drops the parcel out of the search it is supposed to alert on.
    const applied = await applySimulation("roll_movement", [
      {
        propertyId: property.propertyId,
        parcelIdentifier: property.parcelIdentifier,
        addressLine: displayAddress(property),
        ownerName: property.ownerName,
        assessedValue: property.assessedValue,
        roofPermitCount: property.roofPermitCount,
      },
    ]);
    simulationRunIds.push(applied.runId);
    for (const change of applied.changes) console.log(`  ${change.addressLine}: ${change.detail}`);
  }

  const alertPass = simulationRunIds.length
    ? await runMatcher(source, { trigger: "simulation" })
    : null;
  if (alertPass) {
    console.log(
      `matcher pass ${alertPass.matcherRunId} raised ${alertPass.alertsCreated} alerts over ` +
        `${simulationRunIds.length} simulated pipeline changes`,
    );
  }

  // Which alert, if any, opened each deal.
  //
  // Indexed both ways on purpose. A parcel that clears two theses is alerted on
  // by both, and the one that fires is not always the one the deal was picked
  // from - a search that has only just been baselined raises nothing on the pass
  // after it, so its parcels can be alerted on by a sibling thesis instead. The
  // pair is preferred; the parcel is the fallback, and a deal that takes the
  // fallback is re-attributed to the thesis that actually alerted so the row
  // does not name one search and cite the other's alert.
  const alerts = await crmStore().list<AlertDoc>("alerts");
  const alertByPair = new Map<string, AlertDoc>();
  const alertByParcel = new Map<string, AlertDoc>();
  for (const alert of alerts) {
    for (const [index, key] of [
      `${alert.savedSearchId}::${alert.propertyId}`,
      alert.propertyId,
    ].entries()) {
      const into = index === 0 ? alertByPair : alertByParcel;
      const held = into.get(key);
      if (!held || held.createdAt < alert.createdAt) into.set(key, alert);
    }
  }

  /* ---------------- re-read the parcels, then work them ---------------- */

  // Read the changed parcels again with the overlay applied, so the snapshot
  // stored on an opportunity is the parcel as it stands after the change its own
  // alert describes. Scores come from this read: the engine computes them, this
  // script never writes one.
  //
  // Only the simulated parcels are re-read. Nothing touched the other seven, so
  // asking the engine about them again would be a second full scan of the
  // artifact for an answer already in hand - and over a gateway that is minutes,
  // not milliseconds.
  const overlayAfter = await loadOverlay();
  const fresh = new Map<string, ScoredProperty>();
  const changedBySearch = new Map<string, string[]>();
  for (const deal of lineageTargets) {
    const held = changedBySearch.get(deal.searchId) ?? [];
    held.push(deal.scored.property.propertyId);
    changedBySearch.set(deal.searchId, held);
  }
  for (const [searchId, propertyIds] of changedBySearch) {
    const search = created.find((entry) => entry.id === searchId);
    if (!search) continue;
    const reread = await source.search({
      criteria: search.criteria,
      propertyIds,
      limit: propertyIds.length,
      orderBy: "score",
      overlay: overlayAfter.overlay,
    });
    for (const scored of reread.rows) {
      fresh.set(`${searchId}::${scored.property.propertyId}`, scored);
    }
  }

  const now = Date.now();

  for (const [index, deal] of deals.entries()) {
    const key = `${deal.searchId}::${deal.scored.property.propertyId}`;
    // The re-read is authoritative when it is available; the selection read is
    // the fallback for a parcel the overlay has moved out of its own search.
    const scored = fresh.get(key) ?? deal.scored;
    const property = scored.property;
    const journey = deal.journey;
    const assignee = members[index % members.length];
    const alert = alertByPair.get(key) ?? alertByParcel.get(property.propertyId) ?? null;
    // See the index above: a deal that took the fallback records the thesis
    // whose alert it cites, not the one it was drawn from.
    const savedSearchId = alert?.savedSearchId ?? deal.searchId;

    const asking = journey.askingFactor
      ? roundMoney((property.assessedValue ?? 0) * journey.askingFactor)
      : null;
    const offer = asking && journey.offerFactor ? roundMoney(asking * journey.offerFactor) : null;
    const note = journey.note
      .replace("{asking}", asking ? `$${asking.toLocaleString("en-US")}` : "the asking price")
      .replace("{offer}", offer ? `$${offer.toLocaleString("en-US")}` : "our number");

    const { opportunity } = await createOpportunityFromSnapshot({
      propertyId: property.propertyId,
      parcelIdentifier: property.parcelIdentifier,
      addressLine: displayAddress(property),
      addressCity: property.addressCity,
      addressZip: property.addressZip,
      latitude: property.latitude,
      longitude: property.longitude,
      assessedValue: property.assessedValue,
      ownerName: property.ownerName,
      ownerMailingAddress: property.ownerMailingAddress,
      ownerMailingCity: property.ownerMailingCity,
      ownerMailingState: property.ownerMailingState,
      ownerMailingZip: property.ownerMailingZip,
      sourceSystem: property.provenance.sourceSystem,
      sourceUrl: property.provenance.sourceUrl,
      propertySnapshot: alertSnapshot(scored),
      // Computed by the scoring engine on the line above, not by this file.
      matchScore: scored.score,
      matchRationale: scored.rationale,
      savedSearchId,
      // Present only when a matcher pass actually raised one. The export reads
      // the matcher run id through this, so an invented value here would be an
      // invented provenance column.
      alertId: alert?.id ?? null,
      assigneeId: assignee?.id ?? null,
      actorId: members[0]?.id ?? null,
    });

    // Walk the stages rather than jumping, so the stage history reads like a
    // deal rather than a single assignment.
    const path: AcquisitionStage[] = [
      "identified",
      "contacted",
      "negotiating",
      "under_contract",
      "closed",
    ];
    const steps =
      journey.stage === "dead"
        ? (["contacted", "dead"] as AcquisitionStage[])
        : path.slice(1, path.indexOf(journey.stage) + 1);

    for (const step of steps) {
      await updateOpportunity(opportunity.id, {
        stage: step,
        actorId: assignee?.id ?? null,
        stageNote: step === journey.stage ? note : null,
      });
    }

    await updateOpportunity(opportunity.id, {
      ownerInterest: journey.interest ?? null,
      askingPrice: asking,
      offerPrice: offer,
      nextStep: journey.nextStep ?? null,
      assigneeId: assignee?.id ?? null,
    });

    await addNote(opportunity.id, note, assignee?.id ?? null);

    if (journey.task) {
      await addTask({
        propertyId: opportunity.id,
        title: journey.task,
        assigneeId: assignee?.id ?? null,
        dueAt: new Date(now + (index + 2) * 86_400_000).toISOString(),
      });
    }

    if (journey.outreach) {
      await sendOutreach({
        opportunityIds: [opportunity.id],
        channel: journey.outreach,
        templateId: journey.outreach === "sms" ? "cash-offer-intro" : "roof-condition",
        campaignName: `Seed - ${journey.stage}`,
        createdById: assignee?.id ?? null,
      });
    }
  }

  console.log(`worked ${deals.length} opportunities through the funnel`);

  await reportBoard();

  await source.close();
  console.log("done");
}

/**
 * Print the board the seed just produced.
 *
 * Read back out of the store rather than assembled from what was written, so
 * this describes what a reviewer will actually see. The three columns that
 * previously lied - score, ZIP and lineage - are the three this prints first.
 */
async function reportBoard(): Promise<void> {
  const store = crmStore();
  const [views, searches, alerts] = await Promise.all([
    listOpportunities({ limit: 200 }),
    store.list<SavedSearchDoc>("searches"),
    store.list<AlertDoc>("alerts"),
  ]);
  const searchName = new Map(searches.map((search) => [search.id, search.name]));
  const alertById = new Map(alerts.map((alert) => [alert.id, alert]));

  console.log("\nboard");
  console.log("stage           zip     score  lineage  thesis                     address");
  for (const view of views) {
    const opportunity = view.opportunity;
    console.log(
      [
        opportunity.stage.padEnd(15),
        (opportunity.addressZip ?? "-").padEnd(7),
        (opportunity.matchScore === null ? "-" : opportunity.matchScore.toFixed(1)).padStart(5),
        (opportunity.alertId ? "alert" : "-").padStart(8),
        `  ${(searchName.get(opportunity.savedSearchId ?? "") ?? "-").slice(0, 24).padEnd(25)}`,
        opportunity.addressLine,
      ].join(" "),
    );
  }

  const scores = views
    .map((view) => view.opportunity.matchScore)
    .filter((score): score is number => score !== null);
  const zips = new Set(views.map((view) => view.opportunity.addressZip ?? "-"));
  const withLineage = views.filter((view) => view.opportunity.alertId).length;
  const range = scores.length
    ? `scores ${Math.min(...scores).toFixed(1)} to ${Math.max(...scores).toFixed(1)}`
    : "no scores";

  console.log(
    `\n${views.length} opportunities, ${zips.size} ZIPs, ${range}, ` +
      `${withLineage} carrying alert lineage`,
  );

  // The provenance columns the CSV export carries, printed from the same two
  // documents the export reads them from. Anyone can check the claim against
  // /api/export?kind=opportunities without taking this script's word for it.
  if (withLineage) {
    console.log("\nlineage the export will carry");
    for (const view of views) {
      const alert = view.opportunity.alertId ? alertById.get(view.opportunity.alertId) : null;
      if (!alert) continue;
      console.log(
        `  ${view.opportunity.addressLine}\n` +
          `    alert_id=${alert.id}\n` +
          `    matcher_run_id=${alert.matcherRunId}\n` +
          `    pipeline_run_id=${alert.pipelineRunId ?? ""} (${alert.kind}: ${alert.changedFields.join(", ") || "no named field"})`,
      );
    }
  }

  // The three assertions the previous fixture would have failed. A seed that
  // cannot say these are true has not finished its job.
  const saturated = scores.filter((score) => score >= 100).length;
  if (saturated) {
    console.error(
      `\n${saturated} opportunities scored 100, which under the current model means the criteria could not rank them.`,
    );
    process.exitCode = 1;
  }
  if (!withLineage) {
    console.error(
      "\nNo opportunity carries an alert id, so the board cannot show where a deal came from.",
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
