/**
 * The evidence record has to be able to name its own trigger and its own code.
 *
 * `scripts/run-matcher.ts` passed the literal `{ trigger: "cron" }`, so a pass
 * dispatched by hand was written into `matcher-runs` as a scheduled one. The
 * workflow declared a `reason` input that nothing read. And nothing anywhere
 * stamped a commit sha, so no row could say which generation of the code
 * produced it - which is how three rounds of pre-fix code ran on the schedule
 * against the live store without anyone noticing.
 *
 * In a repository whose thesis is evidence integrity, and which already keys
 * every alert on the generation of the DATA, the generation of the CODE is the
 * other half of the same claim.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { memoryStore } from "@/lib/crm/store-memory";
import type { MatcherRunDoc } from "@/lib/crm/documents";
import { resolveRunProvenance, resolveTrigger, stampRunProvenance } from "@/scripts/run-matcher";

const ROOT = resolve(__dirname, "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/matcher.yml"), "utf8");

/** A fixture environment. NODE_ENV is required on ProcessEnv and irrelevant here. */
const makeEnv = (values: Record<string, string>): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...values }) as NodeJS.ProcessEnv;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

afterEach(() => {
  setCrmStore(null);
});

describe("resolveTrigger", () => {
  it("says cron only when the schedule fired", () => {
    expect(resolveTrigger(makeEnv({ GITHUB_EVENT_NAME: "schedule" }))).toBe("cron");
  });

  it("does not call a hand dispatched pass a scheduled one", () => {
    expect(resolveTrigger(makeEnv({ GITHUB_EVENT_NAME: "workflow_dispatch" }))).toBe("manual");
    expect(resolveTrigger(makeEnv({ GITHUB_EVENT_NAME: "repository_dispatch" }))).toBe("manual");
  });

  it("treats a run from a laptop as manual, because that is what it is", () => {
    expect(resolveTrigger(makeEnv({}))).toBe("manual");
  });

  it("lets an operator state it outright, within the type", () => {
    expect(resolveTrigger(makeEnv({ MATCHER_TRIGGER: "simulation" }))).toBe("simulation");
    // Anything the document model does not allow falls back rather than being
    // written through into the record.
    expect(resolveTrigger(makeEnv({ MATCHER_TRIGGER: "nonsense" }))).toBe("manual");
  });
});

describe("resolveRunProvenance", () => {
  const noGit = () => null;

  it("names the code that ran, not the code that triggered the run", () => {
    // The workflow checks out `inputs.ref || vars.MATCHER_REF || github.ref`, so
    // GITHUB_SHA can name a different commit from the one on disk. The resolved
    // sha, exported after checkout, wins.
    const provenance = resolveRunProvenance(
      makeEnv({ GITHUB_SHA: OTHER_SHA, MATCHER_COMMIT_SHA: SHA, MATCHER_COMMIT_REF: "fix/branch" }),
      noGit,
    );

    expect(provenance.codeCommitSha).toBe(SHA);
    expect(provenance.codeRef).toBe("fix/branch");
  });

  it("falls back to the triggering sha, then to the checkout on disk", () => {
    expect(resolveRunProvenance(makeEnv({ GITHUB_SHA: SHA }), noGit).codeCommitSha).toBe(SHA);
    expect(resolveRunProvenance(makeEnv({ VERCEL_GIT_COMMIT_SHA: SHA }), noGit).codeCommitSha).toBe(
      SHA,
    );
    expect(resolveRunProvenance(makeEnv({}), () => SHA).codeCommitSha).toBe(SHA);
  });

  it("says it does not know rather than inventing a generation", () => {
    expect(resolveRunProvenance(makeEnv({}), noGit).codeCommitSha).toBeNull();
    expect(
      resolveRunProvenance(makeEnv({ GITHUB_SHA: "not-a-sha" }), noGit).codeCommitSha,
    ).toBeNull();
  });

  it("carries the dispatcher's reason, and nothing when there was none", () => {
    expect(
      resolveRunProvenance(makeEnv({ MATCHER_REASON: "checking the roof fix" }), noGit).reason,
    ).toBe("checking the roof fix");
    expect(resolveRunProvenance(makeEnv({ MATCHER_REASON: "   " }), noGit).reason).toBeNull();
    expect(resolveRunProvenance(makeEnv({}), noGit).reason).toBeNull();
  });
});

describe("stampRunProvenance", () => {
  it("writes the generation onto the run document the pass produced", async () => {
    setCrmStore(memoryStore());
    const store = crmStore();
    await store.put<MatcherRunDoc>("matcher-runs", {
      id: "run-1",
      startedAt: "2026-08-22T00:00:00.000Z",
      finishedAt: "2026-08-22T00:01:00.000Z",
      trigger: "manual",
      pipelineRunId: "01M0K3B6",
      pipelineRunStartedAt: null,
      pipelineRunIsNew: false,
      dataSourceKind: "duckdb",
      dataSourceLocation: "ipfs",
      dataSourceRowCount: 404_023,
      dataSourceIsSample: false,
      searchesEvaluated: 3,
      propertiesEvaluated: 1_000,
      alertsCreated: 0,
      alertsSuppressed: 0,
      notificationsSent: 0,
      detail: null,
      error: null,
    });

    const stamped = await stampRunProvenance("run-1", {
      trigger: "manual",
      codeCommitSha: SHA,
      codeRef: "main",
      reason: "checking the roof fix",
    });

    expect(stamped).toBe(true);
    const written = await store.get<MatcherRunDoc & Record<string, unknown>>(
      "matcher-runs",
      "run-1",
    );
    expect(written?.codeCommitSha).toBe(SHA);
    expect(written?.codeRef).toBe("main");
    expect(written?.reason).toBe("checking the roof fix");
    // Nothing the evaluator recorded is discarded by the stamp.
    expect(written?.pipelineRunId).toBe("01M0K3B6");
    expect(written?.searchesEvaluated).toBe(3);
  });

  it("does not fail a pass because the stamp could not be attached", async () => {
    setCrmStore(memoryStore());
    await expect(
      stampRunProvenance("no-such-run", {
        trigger: "cron",
        codeCommitSha: SHA,
        codeRef: null,
        reason: null,
      }),
    ).resolves.toBe(false);
  });
});

describe("the scheduled workflow", () => {
  it("checks out an explicit ref rather than the implicit default", () => {
    expect(WORKFLOW).toContain("ref: ${{ inputs.ref || vars.MATCHER_REF || github.ref }}");
  });

  it("consumes the reason input it declares", () => {
    expect(WORKFLOW).toMatch(/inputs:[\s\S]*reason:/);
    expect(WORKFLOW).toContain("MATCHER_REASON: ${{ inputs.reason }}");
  });

  it("resolves the checked-out commit and echoes it into the step summary", () => {
    expect(WORKFLOW).toContain("git rev-parse HEAD");
    expect(WORKFLOW).toContain('echo "MATCHER_COMMIT_SHA=$SHA" >> "$GITHUB_ENV"');
    expect(WORKFLOW).toContain("GITHUB_STEP_SUMMARY");
    expect(WORKFLOW).toContain("resolved commit");
  });

  it("no longer hardcodes the trigger in the runner", () => {
    const runner = readFileSync(resolve(ROOT, "scripts/run-matcher.ts"), "utf8");
    expect(runner).not.toContain('trigger: "cron"');
    expect(runner).toContain("trigger: provenance.trigger");
  });
});
