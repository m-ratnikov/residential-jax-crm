/**
 * Drive the notification loop end to end, against whatever store is configured.
 *
 * This is the acceptance criterion the whole application exists for: define
 * criteria, have the pipeline change underneath them, and be told about it
 * without asking. It is worth a script rather than a click-through, because the
 * interesting part is that nothing about the alert is special-cased for the
 * demo - the simulation writes real data and the ordinary matcher finds it by
 * diffing.
 *
 *   PROPERTY_DATA_URL=... CRM_STORE_REPO=... pnpm verify
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { criteriaSetSchema, CRITERIA_PRESETS } from "@/lib/criteria/types";
import { needsCourtData } from "@/lib/criteria/sql";
import { displayAddress } from "@/lib/data/map";
import { getPropertyDataSource } from "@/lib/data/source";
import { crmStore, storeStatus } from "@/lib/crm/db";
import { createSavedSearch, listAlerts, listSavedSearches } from "@/lib/crm/repo";
import type { SavedSearchDoc } from "@/lib/crm/documents";
import { loadOverlay } from "@/lib/crm/overlay";
import { applySimulation, clearSimulation } from "@/lib/crm/simulate";
import { runMatcher } from "@/lib/notify/matcher";

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

const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  loadEnvFile();

  const status = storeStatus();
  console.log(`store: ${status.kind} (${status.location})\n`);

  const { source } = getPropertyDataSource();
  const info = await source.info();
  // The sample is a supported configuration, not a failure: a clone with no
  // artifact URL is meant to get it. What must never pass silently is a
  // deployment that believes it has the county and has the sample, so the
  // distinction is stated rather than scored.
  if (info.isSample) {
    console.log(
      `NOTE  running against the bundled sample - ${info.rowCount.toLocaleString("en-US")} parcels, not the full county. Set PROPERTY_DATA_URL to verify the deliverable.`,
    );
  } else {
    check(
      "dataset is county scale",
      info.rowCount > 100_000,
      `${info.rowCount.toLocaleString("en-US")} parcels`,
    );
  }

  // Seed what is missing rather than demanding somebody ran another script
  // first. This matters for more than convenience: with the in-process backend
  // the store lives and dies with the process, so `pnpm seed && pnpm verify`
  // can never work there - the seed exits and takes the data with it. A
  // verification that only runs against two of the three backends is not the
  // claim this project makes about them.
  let searches = await listSavedSearches();
  if (!searches.length) {
    const preset = CRITERIA_PRESETS.find((entry) => entry.id === "transit-infill");
    if (preset) {
      await createSavedSearch({
        name: preset.name,
        description: preset.description,
        criteria: preset.criteria,
        ownerId: null,
        notifyInApp: true,
        notifyEmail: false,
        notifySms: false,
      });
      console.log(`seeded a saved search to watch: "${preset.name}"
`);
      searches = await listSavedSearches();
    }
  }

  const target = searches[0];
  if (!target) {
    check("a saved search exists to watch", false, "no criteria presets to seed from");
    process.exit(1);
  }

  // Start from a known state, so this script says the same thing every time it
  // is run rather than only the first time. A previous run leaves alerts and a
  // simulated snapshot behind, and a verification that passes once is not one.
  await clearSimulation();
  const store = crmStore();
  for (const alert of await listAlerts({ savedSearchId: target.id, limit: 500 })) {
    await store.remove("alerts", alert.id);
  }
  await store.put<SavedSearchDoc>("searches", { ...target, matches: {}, matchesTruncated: false });

  const criteria = criteriaSetSchema.parse(target.criteria);

  // Which kind of change will this search actually notice?
  //
  // A court filing only moves a search that asks about court signals. The
  // seeded theses use roll-derived distress - absentee owner, no homestead - so
  // a filing against them changes nothing and raises nothing, which is correct
  // and would make a useless test. A roll movement changes material fields, so
  // any search that already matched the parcel sees it.
  const usesCourt = needsCourtData(criteria.filters);
  const kind = usesCourt ? "court_filing" : "roll_movement";

  console.log(`
watching "${target.name}", simulating a ${kind.replace("_", " ")}
`);
  // The baseline pass. This is the one that must NOT alert: it records what
  // already matches so that everything afterwards is a genuine change.
  const baseline = await runMatcher(source, { trigger: "manual", savedSearchIds: [target.id] });
  check(
    "the baseline pass seeded rather than shouted",
    baseline.alertsCreated === 0 && (baseline.outcomes[0]?.seeded ?? false),
    `${baseline.alertsCreated} alerts over ${baseline.outcomes[0]?.matched.toLocaleString("en-US") ?? 0} matches`,
  );

  const overlay = await loadOverlay();
  const flagged = new Set(overlay.overlay.court.map((entry) => entry.propertyId));

  // For a court filing, drop the court predicates when picking targets: the
  // point is to find parcels that fit everything else and then give them the
  // signal they lack, so the next pass sees them arrive.
  const forTargets = usesCourt
    ? {
        ...criteria,
        filters: {
          ...criteria.filters,
          distress: criteria.filters.distress
            ? {
                absenteeOwner: criteria.filters.distress.absenteeOwner,
                noHomestead: criteria.filters.distress.noHomestead,
              }
            : undefined,
        },
      }
    : criteria;

  const found = await source.search({
    criteria: forTargets,
    limit: 60,
    orderBy: "score",
    overlay: overlay.overlay,
  });

  const targets = found.rows
    .filter((row) => (usesCourt ? !flagged.has(row.property.propertyId) : true))
    .slice(0, 3)
    .map((row) => ({
      propertyId: row.property.propertyId,
      parcelIdentifier: row.property.parcelIdentifier,
      addressLine: displayAddress(row.property),
      ownerName: row.property.ownerName,
      assessedValue: row.property.assessedValue,
      roofPermitCount: row.property.roofPermitCount,
    }));

  check("found parcels to change", targets.length > 0, `${targets.length} targets`);
  if (!targets.length) process.exit(1);

  // 2. Write the change. Real rows, stamped with a synthetic run id.
  const simulation = await applySimulation(kind, targets);
  check(
    "the simulated pipeline update was applied",
    simulation.changes.length > 0,
    `run ${simulation.runId}: ${simulation.changes.map((change) => change.label).join(", ")}`,
  );

  // 3. Run the ordinary matcher. Nothing here knows the change was simulated.
  const pass = await runMatcher(source, { trigger: "simulation", savedSearchIds: [target.id] });
  const outcome = pass.outcomes[0];

  check(
    "the matcher raised alerts for the change",
    pass.alertsCreated > 0,
    `${pass.alertsCreated} alerts`,
  );
  check(
    "the alerts describe the right kind of change",
    usesCourt ? (outcome?.newMatches ?? 0) > 0 : (outcome?.updatedMatches ?? 0) > 0,
    `${outcome?.newMatches ?? 0} new, ${outcome?.updatedMatches ?? 0} changed`,
  );

  // 4. Every alert has to carry its evidence.
  const raised = await listAlerts({ savedSearchId: target.id, limit: 500 });
  const sample = raised[0];

  if (!usesCourt) {
    const changedAlert = raised.find((alert) => alert.changedFields.length);
    check(
      "an updated match names the fields that moved",
      Boolean(changedAlert),
      changedAlert?.changedFields.join(", ") ?? "no alert named a changed field",
    );
  }

  check(
    "the alert cites the pipeline run that triggered it",
    Boolean(sample?.pipelineRunId),
    sample?.pipelineRunId ?? "none",
  );
  check(
    "the alert carries a score rationale",
    (sample?.rationale.length ?? 0) > 20,
    sample?.rationale.slice(0, 70),
  );
  check(
    "the alert carries the parcel as it looked",
    Boolean(sample?.propertySnapshot?.["address"]),
    String(sample?.propertySnapshot?.["address"] ?? ""),
  );
  check(
    "the alert recorded its deliveries",
    (sample?.notifications.length ?? 0) > 0,
    `${sample?.notifications.length ?? 0} channels`,
  );

  // Only assert a channel the search actually asked for. A search with email
  // switched off producing no email is correct behaviour, not a defect.
  if (target.notifyEmail) {
    const emailed = sample?.notifications.find((entry) => entry.channel === "email");
    check(
      "the mocked email has a body a person could read",
      (emailed?.body?.length ?? 0) > 80,
      emailed?.subject ?? "no email was built",
    );
  }

  const inApp = sample?.notifications.find((entry) => entry.channel === "in_app");
  check(
    "the in-app notification carries the whole story",
    (inApp?.body?.length ?? 0) > 80 && Boolean(inApp?.subject),
    inApp?.subject ?? "no in-app notification",
  );

  // 5. Re-running must not double notify.
  const repeat = await runMatcher(source, { trigger: "simulation", savedSearchIds: [target.id] });
  check(
    "re-running raises nothing new",
    repeat.alertsCreated === 0,
    `${repeat.alertsCreated} alerts on the second pass`,
  );

  // 6. Clean up, so the demo starts from a known state next time.
  const cleared = await clearSimulation();
  console.log(
    `\ncleared ${cleared.changes} simulated changes and ${cleared.courtRecords} simulated filings`,
  );

  await source.close();

  if (failures.length) {
    console.log(`\n${failures.length} checks failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nthe whole loop works");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
