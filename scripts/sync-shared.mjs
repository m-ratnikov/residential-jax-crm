#!/usr/bin/env node
/**
 * Drift check for lib/oracle/, which is vendored from the Duval Oracle pipeline
 * repository. See lib/oracle/VENDORED.md for why the code is copied rather than
 * depended on.
 *
 *   node scripts/sync-shared.mjs --origin ../oracle-.../ui
 *   node scripts/sync-shared.mjs --origin ../oracle-.../ui --pull
 *
 * Without --pull it reports differences and exits non zero when any exist, so it
 * can be run by hand before a release. With --pull it overwrites the vendored
 * copy from the origin, reapplying the provenance header and the import rewrite.
 *
 * This is not wired into CI on purpose: a CI runner has no checkout of the
 * origin repository, and a check that cannot run is worse than one that is
 * documented as manual.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const originIndex = args.indexOf("--origin");
const origin = originIndex >= 0 ? args[originIndex + 1] : null;
const pull = args.includes("--pull");

if (!origin) {
  console.error(
    "usage: node scripts/sync-shared.mjs --origin <path to pipeline repo ui/> [--pull]",
  );
  process.exit(2);
}

const VENDOR_ROOT = "lib/oracle";
const HEADER_MARKER = "// VENDORED FILE";
const HEADER_LINES = 3;

/** Origin path for a vendored file: lib/oracle/agent/x.ts came from ui/lib/agent/x.ts. */
function originPathFor(rel) {
  return join(origin, "lib", rel);
}

/**
 * Line endings are not drift. The origin checkout and this one are cloned on
 * different `core.autocrlf` settings, so comparing raw bytes reports every line
 * of a CRLF file as changed and hides the one line that actually moved.
 */
function normalizeEol(source) {
  return source.replaceAll("\r\n", "\n");
}

function rewriteImports(source) {
  return normalizeEol(source)
    .replaceAll('from "@/lib/sql"', 'from "@/lib/oracle/sql"')
    .replaceAll('from "@/lib/columns"', 'from "@/lib/oracle/columns"')
    .replaceAll('from "@/lib/geo"', 'from "@/lib/oracle/geo"')
    .replaceAll('from "@/lib/format"', 'from "@/lib/oracle/format"');
}

function headerFor(rel) {
  return [
    "// VENDORED FILE - do not edit here without reading lib/oracle/VENDORED.md.",
    `// Origin: oracle-property-intelligence-platform-pipeline-duval-fl, ui/lib/${rel}, commit 28088d0.`,
    "// Only the import paths differ from the original. Run scripts/sync-shared.mjs to check for drift.",
    "",
  ].join("\n");
}

const CLIENT_DIRECTIVES = ['"use client";', "'use client';"];

/**
 * Split a leading "use client" directive off the front of a source file.
 *
 * The directive has to stay the first statement in the file, so the provenance
 * header is written underneath it rather than above. Matched as a plain string
 * rather than a pattern, because the escaping needed for a newline inside a
 * regular expression is exactly the sort of thing that gets mangled on the way
 * into this file.
 */
function splitDirective(source) {
  for (const directive of CLIENT_DIRECTIVES) {
    if (!source.startsWith(directive)) continue;
    const newline = source.indexOf("\n", directive.length);
    if (newline < 0) continue;
    return { directive: source.slice(0, newline + 1), rest: source.slice(newline + 1) };
  }
  return { directive: "", rest: source };
}

/**
 * The vendored body with the provenance header removed, for comparison.
 *
 * The header is not always at the top, so it is located by its marker rather
 * than by position.
 */
function bodyOf(source) {
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.startsWith(HEADER_MARKER));
  if (at < 0) return source;
  lines.splice(at, HEADER_LINES);
  return lines.join("\n");
}

function stamp(rel, source) {
  const { directive, rest } = splitDirective(source);
  return directive + headerFor(rel) + rest;
}

function listVendored(dir = VENDOR_ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listVendored(full, out);
    else if (name.endsWith(".ts")) out.push(relative(VENDOR_ROOT, full).split(sep).join("/"));
  }
  return out;
}

const drifted = [];
const missing = [];

for (const rel of listVendored()) {
  const vendoredPath = join(VENDOR_ROOT, rel);
  const originPath = originPathFor(rel);

  let originSource;
  try {
    originSource = readFileSync(originPath, "utf8");
  } catch {
    missing.push(rel);
    continue;
  }

  const expected = rewriteImports(originSource);
  const actual = normalizeEol(bodyOf(readFileSync(vendoredPath, "utf8")));

  if (expected !== actual) {
    drifted.push(rel);
    if (pull) {
      writeFileSync(vendoredPath, stamp(rel, expected));
      console.log(`pulled  ${rel}`);
    } else {
      console.log(`DRIFT   ${rel}`);
    }
  }
}

for (const rel of missing) console.log(`ABSENT  ${rel} (not found at ${originPathFor(rel)})`);

if (!drifted.length && !missing.length) {
  console.log(`in sync: ${listVendored().length} vendored files match ${origin}`);
  process.exit(0);
}

console.log(`\n${drifted.length} drifted, ${missing.length} absent`);
process.exit(pull ? 0 : 1);
