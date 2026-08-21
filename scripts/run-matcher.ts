/**
 * The scheduled matcher pass.
 *
 * Runs in GitHub Actions, on a cron, with native DuckDB reading the published
 * artifact over HTTP range requests - which is the better engine, and there is
 * no size limit on a workflow runner. It evaluates every active saved search
 * and hands the result to the same `evaluateAndAlert` the browser posts to, so
 * an alert raised here and an alert raised from the app are the same code.
 *
 * This is what makes "saved searches that run against the continuous Duval
 * pipeline on an ongoing basis" true when nobody has the app open. It also
 * keeps standing infrastructure at zero: a workflow runner exists for the
 * ninety seconds it takes and then does not.
 *
 *   DATABASE_URL=... PROPERTY_DATA_URL=... pnpm matcher
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getPropertyDataSource } from "@/lib/data/source";
import { dataConfig } from "@/lib/data/config";
import { storeStatus } from "@/lib/crm/db";
import { runMatcher } from "@/lib/notify/matcher";
import { advanceOutreach } from "@/lib/notify/outreach";

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

function summarise(lines: string[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // A summary that cannot be written must not fail the pass.
  }
}

async function main(): Promise<void> {
  loadEnvFile();

  const store = storeStatus();
  console.log(`crm store: ${store.kind} (${store.location})`);

  if (!store.writable) {
    console.error("The CRM store is read only, so a pass could not record anything.");
    process.exit(2);
  }
  if (store.ephemeral) {
    // A scheduled pass against an in-process store would evaluate an empty set
    // and record a pass that proves nothing.
    console.error(
      "The CRM store is in-process only, so a scheduled pass has no saved searches to evaluate. Set CRM_STORE_REPO or DATABASE_URL.",
    );
    process.exit(2);
  }

  const config = dataConfig();
  if (config.isSample) {
    // Worth saying loudly: a scheduled pass over the bundled sample would raise
    // alerts about a subset and look like the real thing in the evidence table.
    console.warn(
      "WARNING: no artifact URL is configured, so this pass is evaluating the bundled sample.",
    );
  }

  console.log(`reading ${config.queryTableSource}`);

  const { source } = getPropertyDataSource();
  const info = await source.info();
  console.log(
    `${info.label}: ${info.rowCount.toLocaleString("en-US")} parcels, run ${info.runId ?? "unknown"}`,
  );

  const result = await runMatcher(source, { trigger: "cron" });
  const advanced = await advanceOutreach().catch(() => ({ messagesAdvanced: 0, eventsApplied: 0 }));

  console.log(
    `evaluated ${result.searchesEvaluated} searches over ${result.propertiesEvaluated.toLocaleString("en-US")} parcels: ` +
      `${result.alertsCreated} alerts, ${result.alertsSuppressed} suppressed, ${result.notificationsSent} notifications`,
  );

  for (const outcome of result.outcomes) {
    const state = outcome.seeded
      ? "seeded"
      : `${outcome.newMatches} new, ${outcome.updatedMatches} changed`;
    console.log(`  ${outcome.name}: ${outcome.matched.toLocaleString("en-US")} matched, ${state}`);
    if (outcome.error) console.log(`    error: ${outcome.error}`);
  }

  summarise([
    "| field | value |",
    "| --- | --- |",
    `| dataset | ${info.label} |`,
    `| parcels | ${info.rowCount.toLocaleString("en-US")} |`,
    `| pipeline run | \`${result.pipelineRunId ?? "unknown"}\` |`,
    `| new to the CRM | ${result.pipelineRunIsNew ? "yes" : "no"} |`,
    `| searches evaluated | ${result.searchesEvaluated} |`,
    `| alerts created | ${result.alertsCreated} |`,
    `| alerts suppressed | ${result.alertsSuppressed} |`,
    `| notifications sent | ${result.notificationsSent} |`,
    `| outreach advanced | ${advanced.messagesAdvanced} |`,
  ]);

  await source.close();

  // A pass that failed internally has already recorded the error on its
  // matcher_runs row; exiting non-zero is what makes the schedule visibly red.
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
