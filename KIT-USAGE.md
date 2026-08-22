# Kit usage, traced to the code

The headline, stated before the detail so nothing here reads as a bigger claim
than it is:

> The kit's router was consulted first and returned **no clean agent match**.
> The work proceeded on the router's own instruction - build directly with the
> `apply-engineering-guidelines` skill loaded - borrowing two patterns from
> agents that could not be used as agents, and using one agent, `audino`, for
> UI defect passes. **The kit did not build this repository.**

This file exists because the story's reference list names the Soofi XYZ Team
Kit, and until now the only evidence of how it was used was a paragraph asking
to be taken on trust. Everything below points at a file and a line range you can
open. Where a pattern was adapted rather than copied, the adaptation is named
and the reason the original shape did not fit is given.

## Why the citations are given as symbol plus range

Line numbers drift. Every row below names the **symbol** as well as the range,
so a citation still lands after an edit moves it. To print every cited range at
once and check them yourself:

```sh
# from the repository root
while IFS=: read -r file from to; do
  printf '\n===== %s:%s-%s\n' "$file" "$from" "$to"
  sed -n "${from},${to}p" "$file"
done <<'EOF'
lib/notify/providers.ts:1:16
lib/notify/providers.ts:22:57
lib/notify/providers.ts:118:190
lib/notify/outreach.ts:282:335
lib/notify/outreach.ts:370:427
lib/notify/types.ts:40:65
lib/notify/deliver.ts:96:145
lib/notify/evaluate.ts:1:20
lib/notify/evaluate.ts:128:168
lib/notify/evaluate.ts:222:268
lib/notify/evaluate.ts:274:314
lib/notify/evaluate.ts:316:359
lib/notify/evaluate.ts:372:395
lib/criteria/score.ts:23:47
lib/criteria/score.ts:49:74
lib/notify/snapshot.ts:19:53
lib/crm/repo.ts:177:183
lib/crm/store.ts:82:102
lib/crm/store-github.ts:484:530
lib/notify/limits.ts:15:26
EOF
```

---

## 1. The router was consulted, and the negative result is the finding

`arceus`, the kit's router, was asked to route this story before any code was
written. It returned no clean agent match, and the reason is structural rather
than incidental: the kit's fullstack, RAG, batch and CI agents all assume
standing AWS infrastructure - Amplify, Lambda, CDK, Bedrock, OpenSearch, Step
Functions - and this story explicitly forbids ongoing hosted infrastructure
cost. An agent whose first act is `cdk deploy` has nothing to deploy into here.

That is worth recording rather than papering over. A router that says "none of
these fit, here is the skill to load and here are the two patterns worth
stealing" is more useful than one that forces a match, and forcing a match would
have produced a repository with a CDK app in it that nobody could run.

The routing decision it produced, and what was actually done with it:

| Router output                                                          | What was done                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No agent match; load `apply-engineering-guidelines` and build directly | Done. Deviations are listed in [`SOLUTION.md`](SOLUTION.md), not hidden. |
| Borrow the communication-activity lifecycle shape from `chatot`        | Section 2 below, ported off AWS.                                         |
| Borrow the snapshot-diff-and-evidence shape from `watchog`             | Section 3 below, ported off AWS.                                         |

## 2. Pattern borrowed from `chatot` / `manage-communication-activity`

**The shape:** a send is accepted by a provider and returns a provider message
id; status arrives later as discrete events carrying that id; correlation maps
the provider id back to the internal record; the resulting status is normalised
and persisted idempotently, so a redelivered event is a no-op.

Outreach to owners is out of scope for this story, so nothing here sends
anything. The lifecycle is simulated. The shape is not.

| Step in the pattern                                                                                                                        | Where it is                                         | Symbol                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| The borrowed shape, named in the code itself                                                                                               | `lib/notify/providers.ts:1-16`                      | module header                                                    |
| Adapter contract: `idempotencyKey` in, `providerMessageId` out, events carrying `providerEventId` + `providerMessageId`                    | `lib/notify/providers.ts:22-57`                     | `SendRequest`, `SendResult`, `ProviderEvent`, `OutreachProvider` |
| Provider message id **derived from** the internal id, which is what makes correlation checkable rather than stored                         | `lib/notify/providers.ts:118-190` (mint at 125-128) | `simulatedProvider().send`                                       |
| The event chain a send will follow, each event with its own `providerEventId`                                                              | `lib/notify/providers.ts:133-188`                   | `simulatedProvider().lifecycle`                                  |
| Send, then persist the message with its provider id and its event list in one write                                                        | `lib/notify/outreach.ts:282-335`                    | inside `sendOutreach`                                            |
| Correlate and apply: due events are matched back to the message and folded into a status                                                   | `lib/notify/outreach.ts:370-427`                    | `advanceOutreach`                                                |
| Normalisation and idempotency: terminal statuses cannot be superseded, a status never walks backwards, a redelivered event changes nothing | `lib/notify/types.ts:40-65`                         | `STATUS_RANK`, `isTerminal`, `supersedes`                        |
| Alert notifications reuse the same adapters rather than growing a second lifecycle; the idempotency key is `${alertId}:${channel}`         | `lib/notify/deliver.ts:96-145`                      | `record`                                                         |

### What was adapted, and why the original did not fit

**There is no webhook ingress, so the lifecycle is pulled rather than pushed.**
The AWS-shaped original is provider webhook to API Gateway to a queue to a
handler. This deployment has no server awake between requests and no endpoint a
simulator could call. So the provider returns its whole event timeline up front,
each event stamped with the offset at which it becomes due
(`lib/notify/providers.ts:133-188`), and the events are materialised when
wall-clock time passes them. `advanceOutreach` is invoked from the ordinary
request paths - `app/api/outreach/route.ts:86`,
`app/api/opportunities/[id]/route.ts:53`, `app/api/matcher/run/route.ts:135` -
and from the scheduled matcher runner at `scripts/run-matcher.ts:91`. The
consequence is the one worth keeping: a direct mail piece is visibly slower than
an SMS instead of both jumping to a final state the moment a button is pressed.

**Idempotency is a document key plus a monotonic status, not a conditional
put.** The original leans on a DynamoDB conditional write keyed on the provider
event id. There is no DynamoDB here. The same guarantee is assembled from two
things already in the repository: `supersedes` refuses any event that would move
a status backwards or past a terminal one (`lib/notify/types.ts:40-65`), and the
document store's read-modify-write contract re-runs the mutation against what is
actually stored rather than against a stale read (`lib/crm/store.ts:82-102`,
implemented with a compare-and-set retry loop over blob shas at
`lib/crm/store-github.ts:484-530`). Applying the same event twice is therefore a
no-op by construction.

**Honest gap:** this lifecycle has no dedicated test file. The status-ordering
rule in `lib/notify/types.ts` is small and total, but no test currently replays a
duplicate provider event through `advanceOutreach` and asserts the no-op. The
matcher pattern below is covered; this one is not.

## 3. Pattern borrowed from `watchog`

**The shape:** on a schedule, diff each new snapshot against the last stored
snapshot, and persist an immutable evidence record per decision - including the
decision to do nothing.

| Step in the pattern                                                                                                                                                                | Where it is                                                     | Symbol                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| The borrowed shape, named in the code itself                                                                                                                                       | `lib/notify/evaluate.ts:1-20`                                   | module header                       |
| What a snapshot consists of, and the fingerprint over it                                                                                                                           | `lib/criteria/score.ts:23-47`                                   | `MATERIAL_FIELDS`, `matchHashOf`    |
| The diff, and why an absent field is not a change                                                                                                                                  | `lib/criteria/score.ts:49-74`                                   | `changedFields`, `materialSnapshot` |
| The record handed to the evaluator, defined once so the browser pass and the scheduled pass build the identical thing                                                              | `lib/notify/snapshot.ts:19-53`                                  | `alertSnapshot`, `toEvaluatedMatch` |
| **The diff itself:** last stored snapshot vs this pass, the seeding rule for a never-evaluated search, and the suppression of a fingerprint that moved without the artifact moving | `lib/notify/evaluate.ts:222-268`                                | inside `evaluateAndAlert`           |
| One immutable alert document per decision, written only if the key is not already present                                                                                          | `lib/notify/evaluate.ts:274-314`                                | inside `evaluateAndAlert`           |
| The idempotency key, and a frank account of what it does **not** guarantee                                                                                                         | `lib/notify/evaluate.ts:128-168`                                | `logicalPassId`                     |
| The key as the constraint                                                                                                                                                          | `lib/crm/repo.ts:177-183`                                       | `alertId`                           |
| This pass's observations become the next pass's baseline, capped, with the cap reported rather than applied quietly                                                                | `lib/notify/evaluate.ts:316-359`                                | inside `evaluateAndAlert`           |
| **The evidence record per pass**, written last and written whether or not anything fired                                                                                           | `lib/notify/evaluate.ts:372-395`                                | `matcher-runs` document             |
| The disclosed cap on what is watched                                                                                                                                               | `lib/notify/limits.ts:15-26`                                    | `TRACKED_MATCH_CAP`                 |
| The scheduled entry point                                                                                                                                                          | `.github/workflows/matcher.yml:21-31`, `scripts/run-matcher.ts` | cron plus `runMatcher`              |
| Producing the matches the evaluator diffs                                                                                                                                          | `lib/notify/matcher.ts:61-150`                                  | `runMatcher`                        |

### What was adapted, and why the original did not fit

**The schedule is GitHub Actions, not EventBridge.** Reasoning is in the
workflow header at `.github/workflows/matcher.yml:1-18`: the pass needs native
DuckDB to range-read the published parquet, which a serverless function cannot
carry, and the platform's own cron allows one invocation a day, which is not a
notification service. Actions runs every 30 minutes and writes to the same store
through the same `evaluateAndAlert`, so a cron alert and an alert raised from the
app are the same record.

**Decide-what-to-alert-on was split away from produce-the-matches.** Not in the
original, and added because this application has two producers: the browser
evaluates criteria with DuckDB-WASM, and the scheduled runner does the same with
native DuckDB. `lib/notify/evaluate.ts` takes no parcel data and no engine, so
both feed it (`lib/notify/matcher.ts:61-150` for the Node side). Without the
split there would be two implementations of the diff, and they would drift.

**Two things the original does not have, added because the data required
them.** First, a fingerprint that moves while the artifact has not moved is
suppressed rather than alerted on (`lib/notify/evaluate.ts:222-268`): a gateway
resolving one content name to two pinned generations produced four consecutive
passes alerting on the same 23 parcels. Second, an alert id is keyed on the
generation of the data rather than on the attempt, so a retried pass recomputes
the same ids and delivers nothing (`lib/notify/evaluate.ts:128-168`). That
comment also states plainly what the key does not cover, which is the part worth
reading.

### Evidence you can run

Unlike the outreach lifecycle, this pattern is pinned by tests:

- `test/change-detection.test.ts:86-137` - the fingerprint is stable for an
  unchanged record, moves for a material one, ignores an immaterial one, and the
  diff names exactly what moved.
- `test/unstable-reads.test.ts:55-122` - a fingerprint that moves without the
  artifact moving is suppressed, counted, and raises no alert.
- `test/unstable-reads.test.ts:124-148` - an overlay is still a real change even
  though the parquet has not moved.
- `test/unstable-reads.test.ts:150-229` - a retried pass does not notify twice,
  whoever repeats it.

`pnpm test` runs them.

## 4. `audino`

The kit's frontend bug-fix specialist was used for several UI defect passes.
This is a process fact and it is **not traceable to a line of code**: the agent's
output is ordinary component changes indistinguishable from hand-written ones,
and claiming a particular file as "the agent's" would be an invented citation.
It is recorded here because it happened, and marked as unverifiable from inside
the repository because it is.

## 5. Guideline deviations

`apply-engineering-guidelines` was loaded and followed where it does not
conflict with the story. Every deviation - no AWS or CDK, no Powertools, X-Ray
or CloudWatch, no PagerDuty or DLQ alarms, no Lexicon metric registration - is
because the story forbids the infrastructure the rule assumes.

The deviation table itself lives in [`SOLUTION.md`](SOLUTION.md), under
"Deviations from the engineering guidelines", and is deliberately **not copied
here**. Two documents encoding one list is the same defect this repository has
already fixed twice in code.

## 6. What the kit did not do

Stated so the claim above cannot be read as larger than it is:

- No agent generated this application's architecture, data model, scoring
  engine, query layer or UI.
- No kit agent ran the deployment, the pipeline integration or the CI.
- The two patterns were borrowed as shapes and reimplemented against a different
  runtime. Neither is a port of kit code, and no kit code is vendored here.
  (`lib/oracle/` **is** vendored, from the Duval pipeline repository - see
  [`lib/oracle/VENDORED.md`](lib/oracle/VENDORED.md) - which is a separate
  matter from this file.)
