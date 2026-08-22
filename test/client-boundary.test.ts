/**
 * Server code must not import from a `"use client"` module.
 *
 * This exists because the suite could not catch the bug that motivated it.
 * `app/api/export/route.ts` imported `provenanceInstant` from
 * `lib/data/export-csv.ts`, which is `"use client"` because it holds a DOM
 * download helper. Next compiled the import to a client reference stub and the
 * route answered 500:
 *
 *   Attempted to call provenanceInstant() from the server but
 *   provenanceInstant is on the client.
 *
 * `test/export.test.ts` imports and drives that same route handler and stayed
 * green, because under Vitest `"use client"` is an inert string with no
 * meaning. The runtime failure is invisible to every test that runs the code,
 * so this checks the structure instead: it reads the import graph and fails on
 * the edge itself, without executing anything.
 *
 * Scope is deliberately the reachable graph, not just direct imports: the
 * original defect was one hop, but two hops through a plain module into a
 * client one fails at runtime in exactly the same way and would otherwise slip
 * through.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

function readSource(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** True when the file's own directive marks it as client-only. */
function isClientModule(file: string): boolean {
  const head = readSource(file).slice(0, 4000);
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*["']use client["']/.test(head);
}

/** Resolve an import specifier to a file on disk, or null if it is a package. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function importsOf(file: string): string[] {
  const source = readSource(file);
  const specifiers: string[] = [];
  // Value imports only. A `import type` is erased at compile and crosses the
  // boundary harmlessly, which is why the deal page's own owner type is fine.
  const pattern = /^\s*import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? "";
    const specifier = match[2];
    if (specifier && !/^\s*\{\s*type\s/.test(clause)) specifiers.push(specifier);
  }
  return specifiers;
}

/** The first client module reachable from `entry`, with the path that led there. */
function findClientImport(entry: string): string[] | null {
  const seen = new Set<string>();
  const queue: { file: string; path: string[] }[] = [{ file: entry, path: [entry] }];

  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    if (seen.has(next.file)) continue;
    seen.add(next.file);

    for (const specifier of importsOf(next.file)) {
      const target = resolveImport(next.file, specifier);
      if (!target || seen.has(target)) continue;
      const path = [...next.path, target];
      if (isClientModule(target)) return path;
      queue.push({ file: target, path });
    }
  }
  return null;
}

const relative = (file: string) => file.slice(ROOT.length + 1).replaceAll("\\", "/");

describe("client/server boundary", () => {
  const routes = walk(join(ROOT, "app", "api")).filter((file) => file.endsWith("route.ts"));

  it("finds the route handlers to check", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('no API route reaches a "use client" module', () => {
    const offenders = routes
      .map((route) => ({ route, path: findClientImport(route) }))
      .filter((entry) => entry.path !== null)
      .map((entry) => (entry.path ?? []).map(relative).join("\n    -> "));

    expect(offenders).toEqual([]);
  });

  it("still recognises a client module when it sees one", () => {
    // Guards the detector itself: if `isClientModule` silently stopped matching,
    // the test above would pass by seeing nothing rather than by there being
    // nothing, which is the failure mode that let the original bug ship.
    expect(isClientModule(join(ROOT, "lib", "data", "export-csv.ts"))).toBe(true);
    expect(isClientModule(join(ROOT, "lib", "data", "instant.ts"))).toBe(false);
  });

  it("scripts run under node and must not reach a client module either", () => {
    const scripts = walk(join(ROOT, "scripts")).filter((file) => /\.(ts|mts)$/.test(file));
    const offenders = scripts
      .map((file) => ({ file, path: findClientImport(file) }))
      .filter((entry) => entry.path !== null)
      .map((entry) => (entry.path ?? []).map(relative).join("\n    -> "));

    expect(offenders).toEqual([]);
  });
});
