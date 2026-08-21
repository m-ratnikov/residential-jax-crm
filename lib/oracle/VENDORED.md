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
| `geo.ts`                        | Haversine distance, bounding boxes, point-in-polygon.                                                                                                                            |
| `format.ts`                     | Currency, distance, date and number formatting shared by both UIs.                                                                                                               |
| `agent/providers.ts`            | The bring-your-own-key provider registry: seven model providers, their free-tier terms with the URL and date each was read, and the models each one exposes.                     |
| `agent/model.ts`                | Resolves a provider and model into a Vercel AI SDK `LanguageModel`, from either server environment or per-request credentials.                                                   |
| `agent/credentials.ts`          | Reads the per-request `x-llm-*` headers and validates them.                                                                                                                      |
| `agent/redact.ts`               | Strips key material from anything that could reach a log.                                                                                                                        |
| `agent/ratelimit.ts`            | Per-client-address request budget, counted in process.                                                                                                                           |
| `agent/errors.ts`               | Typed agent errors and their HTTP mapping.                                                                                                                                       |
| `agent/log.ts`                  | One JSON line per agent event.                                                                                                                                                   |
| `agent/schema.ts`               | Per-column meanings, in English, that the agent is given as context.                                                                                                             |
| `agent/settings-client.ts`      | Browser-side storage of the visitor's provider choice and key.                                                                                                                   |
| `agent/bedrock-prompt-cache.ts` | Bedrock prompt cache point insertion.                                                                                                                                            |
| `agent/types.ts`                | Shared agent request and response types.                                                                                                                                         |

## What is deliberately NOT vendored

`agent/run.ts`, `agent/tools.ts`, `agent/prompt.ts` and `agent/db.ts` are domain specific: the
pipeline UI answers questions about a county roll, this application answers questions about an
acquisition pipeline. Their equivalents live in `lib/agent/` and are written for this repository.
