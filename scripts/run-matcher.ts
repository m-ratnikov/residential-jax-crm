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

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { getPropertyDataSource } from "@/lib/data/source";
import { dataConfig } from "@/lib/data/config";
import { crmStore, storeStatus } from "@/lib/crm/db";
import type { MatcherRunDoc } from "@/lib/crm/documents";
import { runMatcher, type MatcherTrigger } from "@/lib/notify/matcher";
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

/**
 * What started this pass.
 *
 * It used to be the literal `"cron"`, which made the evidence record unable to
 * tell the truth about itself: a pass dispatched by hand, or run from a laptop,
 * was written into `matcher-runs` as a scheduled one. The record is the whole
 * point of this repository, so it has to name its own trigger.
 *
 * `MATCHER_TRIGGER` wins when it is set to something the type allows. Otherwise
 * the GitHub event name decides, and `schedule` is the ONLY thing that produces
 * "cron". Anything else - a `workflow_dispatch`, a `repository_dispatch`, a
 * local `pnpm matcher` with no event name at all - is a person choosing to run
 * it, which is "manual".
 */
export function resolveTrigger(env: NodeJS.ProcessEnv = process.env): MatcherTrigger {
  const explicit = env.MATCHER_TRIGGER?.trim();
  if (explicit === "cron" || explicit === "manual" || explicit === "simulation") return explicit;
  return env.GITHUB_EVENT_NAME?.trim() === "schedule" ? "cron" : "manual";
}

/**
 * Which code produced this record, and why it ran.
 *
 * Three rounds of pre-fix code ran on a schedule against the live store without
 * anyone noticing, because nothing written down could say which generation of
 * the code had produced a row. The parcel data has always carried a generation -
 * every alert is keyed on the pipeline run id - and the code that read it
 * carried none.
 *
 * The commit sha is read from the environment rather than baked in at build
 * time, most explicit first: `MATCHER_COMMIT_SHA`, which the workflow sets from
 * `git rev-parse HEAD` AFTER checkout, then `GITHUB_SHA`, then
 * `VERCEL_GIT_COMMIT_SHA`. The order matters. `GITHUB_SHA` names the commit that
 * TRIGGERED the run, and the workflow checks out `inputs.ref || vars.MATCHER_REF
 * || github.ref`, so when a pass is dispatched against another ref the two
 * differ - and the record has to name the code that ran, not the code that
 * started it. A local run falls back to asking git, so a pass from a laptop is
 * stamped too rather than being the one kind of pass with no provenance.
 */
export interface RunProvenance {
  trigger: MatcherTrigger;
  /** Full 40 character sha where one is knowable, else null. */
  codeCommitSha: string | null;
  /** Branch or tag the code was checked out from, when the environment names one. */
  codeRef: string | null;
  /** The dispatcher's own words, from the workflow input. Null on a schedule. */
  reason: string | null;
}

function gitHeadSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    // No git, no checkout, or a runner that fetched an archive. Not an error:
    // the record simply says it does not know.
    return null;
  }
}

export function resolveRunProvenance(
  env: NodeJS.ProcessEnv = process.env,
  headSha: () => string | null = gitHeadSha,
): RunProvenance {
  const fromEnv = [env.MATCHER_COMMIT_SHA, env.GITHUB_SHA, env.VERCEL_GIT_COMMIT_SHA]
    .map((value) => value?.trim())
    .find((value) => value && /^[0-9a-f]{7,40}$/.test(value));

  const ref = [env.MATCHER_COMMIT_REF, env.GITHUB_REF_NAME, env.VERCEL_GIT_COMMIT_REF]
    .map((value) => value?.trim())
    .find((value) => value);

  const reason = env.MATCHER_REASON?.trim();

  return {
    trigger: resolveTrigger(env),
    codeCommitSha: fromEnv ?? headSha(),
    codeRef: ref ?? null,
    // An empty input is not a reason, and neither is the workflow default
    // arriving on a pass nobody dispatched.
    reason: reason ? reason.slice(0, 200) : null,
  };
}

/**
 * The evidence record, extended with the provenance the shared evaluator does
 * not know about.
 *
 * `evaluateAndAlert` writes `matcher-runs/<id>` and owns the fields it declares;
 * this adds the three that belong to the RUNNER rather than to the evaluation,
 * through `update` so the write cannot discard anything the pass recorded. It is
 * best effort on purpose: a stamp that failed to attach must not turn a
 * successful pass red, and a record with no stamp is exactly as informative as
 * every record written before this existed.
 */
type StampedMatcherRunDoc = MatcherRunDoc & {
  codeCommitSha: string | null;
  codeRef: string | null;
  reason: string | null;
};

export async function stampRunProvenance(
  matcherRunId: string,
  provenance: RunProvenance,
): Promise<boolean> {
  try {
    const stamped = await crmStore().update<StampedMatcherRunDoc>(
      "matcher-runs",
      matcherRunId,
      (current) =>
        current
          ? {
              ...current,
              codeCommitSha: provenance.codeCommitSha,
              codeRef: provenance.codeRef,
              reason: provenance.reason,
            }
          : null,
    );
    return stamped !== null;
  } catch (error: unknown) {
    console.warn(
      `could not stamp the run record with its code generation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
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

  const provenance = resolveRunProvenance();
  console.log(
    `trigger: ${provenance.trigger}` +
      (provenance.reason ? ` (${provenance.reason})` : "") +
      `, code: ${provenance.codeCommitSha ?? "unknown"}` +
      (provenance.codeRef ? ` on ${provenance.codeRef}` : ""),
  );

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

  const result = await runMatcher(source, { trigger: provenance.trigger });
  const stamped = await stampRunProvenance(result.matcherRunId, provenance);
  const advanced = await advanceOutreach().catch(() => ({ messagesAdvanced: 0, eventsApplied: 0 }));

  console.log(
    `evaluated ${result.searchesEvaluated} searches over ${result.propertiesEvaluated.toLocaleString("en-US")} parcels: ` +
      `${result.alertsCreated} alerts, ${result.alertsSuppressed} suppressed, ${result.notificationsSent} notifications`,
  );

  for (const outcome of result.outcomes) {
    const state = outcome.seeded
      ? "seeded"
      : `${outcome.newMatches} new, ${outcome.updatedMatches} changed` +
        // Worth its own words rather than a silent skip: a non-zero count means
        // one artifact name resolved to two different generations, which is an
        // upstream fact somebody should know about.
        (outcome.unstableReads
          ? `, ${outcome.unstableReads} suppressed as unstable reads of the same artifact`
          : "");
    console.log(`  ${outcome.name}: ${outcome.matched.toLocaleString("en-US")} matched, ${state}`);
    if (outcome.error) console.log(`    error: ${outcome.error}`);
  }

  summarise([
    "| field | value |",
    "| --- | --- |",
    // First two rows on purpose: a reader of the summary should be able to say
    // what started the pass and which code ran before reading a single number.
    `| trigger | ${provenance.trigger}${provenance.reason ? ` - ${provenance.reason}` : ""} |`,
    `| code | \`${provenance.codeCommitSha ?? "unknown"}\`${provenance.codeRef ? ` on \`${provenance.codeRef}\`` : ""}${stamped ? "" : " (not recorded on the run document)"} |`,
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
  // matcher-runs document; exiting non-zero is what makes the schedule visibly
  // red.
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  // And a pass where every search failed to evaluate is a failed pass, even
  // though nothing threw. This is not hypothetical: a run against the public
  // IPFS gateway answered "Timeout was reached" for all three searches after
  // thirteen minutes of range reads, reported zero matched, and finished green.
  // Nothing was corrupted - an evaluation that errors is not written, so the
  // baselines survived - but a schedule that goes green while alerting nobody
  // is the failure mode this whole thing exists to avoid.
  const failed = result.outcomes.filter((outcome) => outcome.error);
  if (failed.length > 0 && failed.length === result.outcomes.length) {
    console.error(
      `every search failed to evaluate (${failed.length}): ${failed[0]?.error ?? "unknown"}`,
    );
    process.exit(1);
  }
}

/**
 * Run only when this file IS the command, not when it is imported.
 *
 * `resolveTrigger` and `resolveRunProvenance` decide what the evidence record
 * says about itself, so they are worth testing directly, and a top level
 * `main()` would make importing them start a matcher pass.
 */
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
