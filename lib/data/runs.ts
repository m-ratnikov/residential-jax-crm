/**
 * Reading the upstream pipeline's published run history in Node.
 *
 * This is the CRM's only window onto "the pipeline ran again". Each run carries
 * per-track inserted / updated / unchanged counts, the limitations the pipeline
 * declared for that run, and the totals after it. Alerts cite a run id from
 * here, which is what makes "show the specific pipeline run that triggered each
 * alert" answerable rather than decorative.
 *
 * The parsing lives in runs-parse.ts so the browser can reuse it; this file is
 * only the file-or-gateway read.
 */

import { readFile } from "node:fs/promises";

import type { PipelineRun } from "./types";
import { loadRunHistoryFrom } from "./runs-parse";

export { runDelta, runMovedData, loadRunHistoryFrom } from "./runs-parse";

async function readSource(location: string): Promise<unknown> {
  if (/^https?:\/\//i.test(location)) {
    // The published history changes every six hours; a short revalidate window
    // keeps the dashboard responsive without pinning a stale run id into an
    // alert. The `next` hint is a Next.js extension to RequestInit and is
    // ignored when this module runs outside the framework, which is why the
    // cast is here rather than a framework import.
    const response = await fetch(location, { next: { revalidate: 300 } } as RequestInit);
    if (!response.ok) throw new Error(`run history ${response.status} from ${location}`);
    return response.json();
  }
  return JSON.parse(await readFile(location, "utf8"));
}

export async function loadRunHistory(
  location: string | null,
  limit = 25,
): Promise<readonly PipelineRun[]> {
  if (!location) return [];
  try {
    return loadRunHistoryFrom(await readSource(location), limit);
  } catch {
    // A pipeline artifact the CRM cannot reach is a degraded dashboard, not a
    // broken CRM. The caller renders "history unavailable".
    return [];
  }
}
