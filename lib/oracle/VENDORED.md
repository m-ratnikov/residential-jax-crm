# `lib/oracle/` is vendored, not written here

Every file in this directory was written for the **Duval County Oracle pipeline** repository and is
copied into this one verbatim, apart from import paths.

- Origin: <https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-duval-fl>
  (submitted from the fork `m-ratnikov/oracle-property-intelligence-platform-pipeline-duval-fl`,
  branch `feat/duval-oracle-pipeline`)
- Origin path: `ui/lib/`
- Copied at origin commit: `28088d0`
- Copied on: 2026-08-21

## Why a copy and not a package

The two halves of this assignment are graded as two independent pull requests, each of which has to
be clonable and runnable on its own. A shared npm package or a git submodule would make each
repository unbuildable without the other, so the shared code is vendored and the copy is declared
rather than hidden.

`scripts/sync-shared.mjs` diffs this directory against the origin checkout and reports drift. It is
not run in CI, because the origin repository is not available to a CI runner; it exists so that a
change made in one repository is visible in the other rather than silently divergent.

```
node scripts/sync-shared.mjs --origin ../oracle-property-intelligence-platform-pipeline-duval-fl/ui
node scripts/sync-shared.mjs --origin <path> --pull     # overwrite the vendored copy
```

## What is here

| File                            | What it does                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columns.ts`                    | The published query table contract: the 37 canonical Elephant columns, the derived columns the pipeline adds, how they group on a detail view, and which of them are provenance. |
| `sql.ts`                        | Read-only SQL guard (`guardSql`), the shared thresholds (`ROOF_AGE_YEARS`, `OWNERSHIP_HOLD_YEARS`, `WALK_DISTANCE_M`), and the question presets the pipeline UI answers.         |
| `duckdb.ts`                     | The DuckDB-WASM engine: attach the published parquet over HTTP range reads, register the view, run a query, report load progress, tear the engine down.                          |
| `opfs.ts`                       | Best-effort Origin Private File System cache for that parquet, with an in-memory fallback.                                                                                       |
| `format.ts`                     | Currency, distance, date and number formatting shared by both UIs.                                                                                                               |
| `agent/providers.ts`            | The model provider registry: nine providers, their free-tier terms with the URL and date each was read, and the models each one exposes.                                        |
| `agent/redact.ts`               | Strips key material from anything that could reach a log.                                                                                                                        |
| `agent/ratelimit.ts`            | Per-client-address request budget, counted in process.                                                                                                                           |
| `agent/errors.ts`               | Typed agent errors and their HTTP mapping.                                                                                                                                       |
| `agent/log.ts`                  | One JSON line per agent event.                                                                                                                                                   |
| `agent/schema.ts`               | Per-column meanings, in English, that the agent is given as context.                                                                                                             |
| `agent/types.ts`                | Shared agent request and response types.                                                                                                                                         |

## What is deliberately NOT vendored

`agent/run.ts`, `agent/tools.ts`, `agent/prompt.ts` and `agent/db.ts` are domain specific: the
pipeline UI answers questions about a county roll, this application answers questions about an
acquisition pipeline. Their equivalents live in `lib/agent/` and are written for this repository.

`geo.ts` was vendored and has been removed. It is slippy-tile arithmetic and a haversine for the
pipeline UI's library-free 3x3 tile thumbnail; this application draws its map with MapLibre and
computes distance in SQL (`haversineSql` in `lib/criteria/sql.ts`), so nothing here imported a line
of it. `scripts/sync-shared.mjs` enumerates what is present in this directory rather than a fixed
list, so a removed file narrows what the drift check compares instead of failing it.

Files are vendored whole rather than trimmed to the exports this application calls. `format.ts` is
here for `toPlain`, which `duckdb.ts` uses to flatten an Arrow value; its other formatters have no
caller in this repository. Deleting them would make every future drift report a false positive,
which is worse than carrying them.
