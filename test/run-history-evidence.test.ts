/**
 * The run history as evidence, which means the numbers on /pipeline have to
 * survive a reviewer opening the published artifact and counting.
 *
 * Two defects, both about a page describing its own plumbing as if it were the
 * pipeline's:
 *
 *  - "PIPELINE RUNS SEEN 25" came from `runs.length` after a `?limit=25`
 *    request, while the published document held 40. A display cap read as a
 *    history, and nothing on the page distinguished them.
 *  - An unset RUN_HISTORY_URL silently served the bundled 8-run sample with no
 *    SAMPLE badge - the exact pre-fix symptom, one missing variable away, on a
 *    page whose whole job is provenance.
 *
 * So: the parser reports the document's own total separately from the page it
 * returns, the configuration reports the fallback as a fact rather than
 * swallowing it, and the stat is a pure function that can be driven through
 * every one of those states.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runHistoryStat } from "@/app/pipeline/page";
import { dataConfig, SAMPLE_RUN_HISTORY } from "@/lib/data/config";
import { resolveRunHistorySource, SAMPLE_RUN_HISTORY_URL } from "@/lib/data/public-config";
import { loadRunHistoryFrom, parseRunHistory } from "@/lib/data/runs-parse";

/**
 * A deployment's environment, built from nothing rather than from this process.
 *
 * `dataConfig` reads whatever it is handed, so inheriting `process.env` would
 * make the answer depend on whether the machine running the tests happens to
 * have RUN_HISTORY_URL exported.
 */
function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides } as NodeJS.ProcessEnv;
}

/** A published envelope of `size` runs, newest last, exactly as the pipeline shapes it. */
function published(size: number, runCount = size): unknown {
  return {
    county: "duval",
    generatedAt: "2026-08-22T06:00:00.000Z",
    runCount,
    runs: Array.from({ length: size }, (_, index) => ({
      run_id: `run-${String(index).padStart(3, "0")}`,
      county: "duval",
      started_at: new Date(Date.UTC(2026, 6, 1) + index * 3_600_000).toISOString(),
      finished_at: null,
      status: "completed",
      trigger: "schedule",
      tracks: ["appraisal"],
      sources: [],
      limitations: [],
      totals: {},
    })),
  };
}

describe("parsing the published run history", () => {
  it("reports the document's own total, not the size of the page it returns", () => {
    const document = parseRunHistory(published(40), 25);

    expect(document.runs).toHaveLength(25);
    // The number the page prints. It is the artifact's, not the request's.
    expect(document.publishedCount).toBe(40);
    expect(document.generatedAt).toBe("2026-08-22T06:00:00.000Z");
    expect(document.county).toBe("duval");
  });

  it("still returns newest first under the cap", () => {
    const document = parseRunHistory(published(40), 3);

    expect(document.runs.map((run) => run.runId)).toEqual(["run-039", "run-038", "run-037"]);
  });

  it("counts the runs itself when the envelope declares nothing", () => {
    const bare = (published(6) as { runs: unknown[] }).runs;

    expect(parseRunHistory(bare, 2).publishedCount).toBe(6);
    expect(parseRunHistory(bare, 2).runs).toHaveLength(2);
  });

  it("never claims fewer runs than it is listing, whatever runCount says", () => {
    // A stale or truncated `runCount` must not make the page understate itself.
    const document = parseRunHistory(published(12, 3), 25);

    expect(document.runs).toHaveLength(12);
    expect(document.publishedCount).toBe(12);
    expect(parseRunHistory(published(12, Number.NaN), 25).publishedCount).toBe(12);
    expect(parseRunHistory(published(12, 12.5), 25).publishedCount).toBe(12);
  });

  it("reads the bundled sample as the eight runs it holds", () => {
    const payload: unknown = JSON.parse(
      readFileSync(join(process.cwd(), SAMPLE_RUN_HISTORY), "utf8"),
    );
    const document = parseRunHistory(payload, 25);

    expect(document.publishedCount).toBe(8);
    expect(document.runs).toHaveLength(8);
  });

  it("keeps the runs-only reader that the existing callers use", () => {
    expect(loadRunHistoryFrom(published(40), 25)).toHaveLength(25);
    expect(loadRunHistoryFrom({ nothing: true })).toEqual([]);
  });
});

describe("an unset RUN_HISTORY_URL", () => {
  it("is reported as the sample it is, not swallowed", () => {
    expect(resolveRunHistorySource(undefined)).toEqual({
      url: SAMPLE_RUN_HISTORY_URL,
      isSample: true,
    });
    expect(resolveRunHistorySource("   ")).toEqual({
      url: SAMPLE_RUN_HISTORY_URL,
      isSample: true,
    });
  });

  it("is not the sample once a published history is configured", () => {
    const source = resolveRunHistorySource("https://ipfs.filebase.io/ipns/k51abc");

    expect(source.isSample).toBe(false);
    // A pointer with no trailing slash addresses the object directly.
    expect(source.url).toBe("https://ipfs.filebase.io/ipns/k51abc");
  });

  it("is tracked on the server config apart from the parcel dataset", () => {
    // The combination that produced the defect: real parcels, sample history.
    const mixed = dataConfig(env({ PROPERTY_DATA_URL: "https://ipfs.filebase.io/ipns/k51abc" }));
    expect(mixed.isSample).toBe(false);
    expect(mixed.runHistoryIsSample).toBe(true);

    expect(dataConfig(env({})).runHistoryIsSample).toBe(true);
    expect(
      dataConfig(env({ RUN_HISTORY_URL: "https://ipfs.filebase.io/ipns/k51def" }))
        .runHistoryIsSample,
    ).toBe(false);
  });
});

describe("the stat above the run list", () => {
  it("shows the published total, and says how much of it is listed", () => {
    const stat = runHistoryStat({
      isSample: false,
      publishedCount: 40,
      listed: 25,
      loaded: true,
      latestAgo: "2 hours ago",
    });

    // The number the deployment used to get wrong, against the same document.
    expect(stat.value).toBe("40");
    expect(stat.hint).toBe("latest 25 listed below");
    expect(stat.tone).toBe("default");
  });

  it("says everything is listed when nothing is being held back", () => {
    const stat = runHistoryStat({
      isSample: false,
      publishedCount: 40,
      listed: 40,
      loaded: true,
      latestAgo: "2 hours ago",
    });

    expect(stat.value).toBe("40");
    expect(stat.hint).toBe("all listed below, latest 2 hours ago");
  });

  it("badges the bundled sample rather than passing it off as the published history", () => {
    const stat = runHistoryStat({
      isSample: true,
      publishedCount: 8,
      listed: 8,
      loaded: true,
      latestAgo: "a day ago",
    });

    expect(stat.tone).toBe("warn");
    expect(stat.hint).toContain("bundled sample");
    expect(stat.hint).toContain("RUN_HISTORY_URL");
  });

  it("admits it when the published total could not be read", () => {
    const stat = runHistoryStat({
      isSample: false,
      publishedCount: null,
      listed: 1,
      loaded: true,
      latestAgo: null,
    });

    expect(stat.value).toBe("1");
    // Singular, because "1 runs listed" is the same defect as "Send to 1 owners".
    expect(stat.hint).toBe("1 run listed, published total not reachable");
  });

  it("shows nothing rather than zero while the list is still loading", () => {
    const stat = runHistoryStat({
      isSample: false,
      publishedCount: null,
      listed: 0,
      loaded: false,
      latestAgo: null,
    });

    expect(stat.value).toBe("-");
  });
});
