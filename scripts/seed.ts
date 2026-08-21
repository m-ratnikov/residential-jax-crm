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
 *   DATABASE_URL=postgres://... pnpm db:seed
 *   DATABASE_URL=postgres://... pnpm db:seed -- --reset
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CRITERIA_PRESETS, type CriteriaSet } from "@/lib/criteria/types";
import { getPropertyDataSource } from "@/lib/data/source";
import { db } from "@/lib/crm/db";
import {
  alerts,
  courtRecords,
  matcherRuns,
  notes,
  notifications,
  opportunities,
  outreachCampaigns,
  outreachEvents,
  outreachMessages,
  owners,
  savedSearches,
  searchMatches,
  simulatedChanges,
  stageEvents,
  tasks,
  teamMembers,
} from "@/lib/crm/schema";
import { createOpportunityFromSnapshot, updateOpportunity } from "@/lib/crm/repo";
import { sendOutreach } from "@/lib/notify/outreach";
import { alertSnapshot, runMatcher } from "@/lib/notify/matcher";
import { displayAddress } from "@/lib/data/map";
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

/**
 * Where each seeded opportunity ends up, and the story behind it. Applied in
 * order to the highest scoring parcels the first saved search returns, so the
 * board reflects real matches rather than a random scatter.
 */
const JOURNEYS: {
  stage: AcquisitionStage;
  note: string;
  nextStep?: string;
  asking?: number;
  offer?: number;
  interest?: string;
  task?: string;
  outreach?: "email" | "sms" | "direct_mail";
}[] = [
  {
    stage: "identified",
    note: "Pulled from the tired landlord list. Roof is well past its life and the owner mails to another county.",
    nextStep: "Skip trace the mailing address",
    task: "Skip trace owner",
  },
  {
    stage: "identified",
    note: "Second in the same street as an existing deal. Worth a letter.",
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
    note: "Owner wants 235k. Comps in the neighbourhood do not support it with this roof.",
    interest: "Motivated, unrealistic on price",
    asking: 235_000,
    offer: 186_000,
    nextStep: "Send the roof quote and re-offer",
    outreach: "email",
    task: "Get a re-roof quote",
  },
  {
    stage: "negotiating",
    note: "Probate is the driver here. Two heirs, one out of state, both want it gone.",
    interest: "Motivated by an estate",
    asking: 168_000,
    offer: 152_000,
    nextStep: "Confirm both heirs will sign",
  },
  {
    stage: "under_contract",
    note: "Signed at 149k. Inspection window closes in nine days.",
    asking: 165_000,
    offer: 149_000,
    nextStep: "Inspection Tuesday",
    task: "Book inspection",
  },
  {
    stage: "closed",
    note: "Closed. Roof replaced before the tenant moved in.",
    asking: 142_000,
    offer: 131_500,
  },
  {
    stage: "dead",
    note: "Owner listed with an agent two days after our letter. Not our deal.",
    interest: "Went to market",
  },
];

async function reset(): Promise<void> {
  const database = db();
  // Order matters: children before parents, since some references are set null
  // rather than cascade.
  await database.delete(outreachEvents);
  await database.delete(outreachMessages);
  await database.delete(outreachCampaigns);
  await database.delete(notifications);
  await database.delete(alerts);
  await database.delete(searchMatches);
  await database.delete(matcherRuns);
  await database.delete(tasks);
  await database.delete(notes);
  await database.delete(stageEvents);
  await database.delete(opportunities);
  await database.delete(owners);
  await database.delete(savedSearches);
  await database.delete(simulatedChanges);
  await database.delete(courtRecords);
  await database.delete(teamMembers);
  console.log("cleared existing CRM state");
}

async function main(): Promise<void> {
  loadEnvFile();

  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is not set. See .env.example.");
    process.exit(2);
  }

  if (process.argv.includes("--reset")) await reset();

  const database = db();
  const { source } = getPropertyDataSource();
  const info = await source.info();
  console.log(`seeding against ${info.label}: ${info.rowCount.toLocaleString("en-US")} parcels`);

  // Team
  const members = await database.insert(teamMembers).values(TEAM).returning();
  console.log(`created ${members.length} team members`);

  // Saved searches
  const created: { id: string; criteria: CriteriaSet }[] = [];
  for (const [index, watched] of WATCHED.entries()) {
    const preset = CRITERIA_PRESETS.find((entry) => entry.id === watched.presetId);
    if (!preset) continue;
    const [row] = await database
      .insert(savedSearches)
      .values({
        name: preset.name,
        description: preset.description,
        criteria: preset.criteria,
        ownerId: members[index % members.length]?.id ?? null,
        notifyInApp: true,
        notifyEmail: watched.email,
        notifySms: watched.sms,
      })
      .returning();
    if (row) created.push({ id: row.id, criteria: preset.criteria });
  }
  console.log(`saved ${created.length} criteria sets`);

  // Baseline every saved search, so the board is populated but the alert feed
  // is not full of parcels that have simply always matched.
  const baseline = await runMatcher(source, { trigger: "manual" });
  console.log(
    `baselined ${baseline.searchesEvaluated} searches over ${baseline.propertiesEvaluated.toLocaleString("en-US")} parcels`,
  );

  // Opportunities, drawn from the top of the first saved search.
  const lead = created[0];
  if (!lead) {
    console.log("no saved searches to draw opportunities from");
    return;
  }

  const matches = await source.search({
    criteria: lead.criteria,
    limit: JOURNEYS.length,
    orderBy: "score",
  });
  if (!matches.rows.length) {
    console.log("the lead search matched nothing in this dataset; no opportunities seeded");
    return;
  }

  for (const [index, journey] of JOURNEYS.entries()) {
    const scored = matches.rows[index];
    if (!scored) break;

    const assignee = members[index % members.length];
    const property = scored.property;
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
      matchScore: scored.score,
      matchRationale: scored.rationale,
      savedSearchId: lead.id,
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
    const target = journey.stage === "dead" ? "dead" : journey.stage;
    const steps =
      target === "dead"
        ? (["contacted", "dead"] as AcquisitionStage[])
        : path.slice(1, path.indexOf(target) + 1);

    for (const step of steps) {
      await updateOpportunity(opportunity.id, {
        stage: step,
        actorId: assignee?.id ?? null,
        stageNote: step === target ? journey.note : null,
      });
    }

    await updateOpportunity(opportunity.id, {
      ownerInterest: journey.interest ?? null,
      askingPrice: journey.asking ?? null,
      offerPrice: journey.offer ?? null,
      nextStep: journey.nextStep ?? null,
      assigneeId: assignee?.id ?? null,
    });

    await database.insert(notes).values({
      opportunityId: opportunity.id,
      authorId: assignee?.id ?? null,
      body: journey.note,
    });

    if (journey.task) {
      await database.insert(tasks).values({
        opportunityId: opportunity.id,
        title: journey.task,
        assigneeId: assignee?.id ?? null,
        dueAt: new Date(Date.now() + (index + 2) * 86_400_000),
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

  console.log(
    `worked ${Math.min(JOURNEYS.length, matches.rows.length)} opportunities through the funnel`,
  );

  await source.close();
  console.log("done");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
