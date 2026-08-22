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
to be taken on trust. Everything below points at a file and a construct you can
open. Where a pattern was adapted rather than copied, the adaptation is named
and the reason the original shape did not fit is given.

## Why the citations are anchors rather than line numbers

They used to be line ranges, and that failed exactly as it was always going to.
One commit changed `lib/notify/evaluate.ts` and this document together, the
ranges in it drifted by 50 to 120 lines, and the file whose entire purpose is
verifiability shipped a self-check that did not pass: seven of thirty-three
citations opened somewhere other than what they named. Not one of them
contradicted its claim - every symbol below exists and does what is asserted -
but being right about the code while wrong about where it lives is not a
defence, and re-deriving the numbers by hand would only reset the clock on the
same defect.

A line number is a fact about a moment. An anchor is a fact about the code. So
every citation below names a **file and a construct**, and the checker resolves
the construct to wherever that construct currently is. The next commit that
moves this code moves the answer with it instead of falsifying the document.

Each anchor is a literal substring chosen to appear **exactly once** in its
file, which is what makes "resolved" mean something: an anchor that has been
renamed, deleted or duplicated fails loudly rather than quietly pointing at a
plausible neighbour. Run this from the repository root to resolve every citation
in this file and print where each one is now:

```sh
# from the repository root. Exit status 0 means every citation still resolves.
fail=0
tab=$(printf '\t')
while IFS="$tab" read -r file anchor; do
  [ -z "$file" ] && continue
  hits=$(grep -cF -- "$anchor" "$file" 2>/dev/null) || hits=no-such-file
  if [ "$hits" != "1" ]; then
    printf 'BROKEN  %s  (%s)  %s\n' "$file" "$hits" "$anchor"
    fail=1
    continue
  fi
  at=$(grep -nF -- "$anchor" "$file" | cut -d: -f1)
  printf 'ok      %s:%s  %s\n' "$file" "$at" "$anchor"
done <<'CITATIONS'
lib/notify/providers.ts	 * The simulated messaging providers.
lib/notify/providers.ts	export interface SendRequest {
lib/notify/providers.ts	export interface OutreachProvider {
lib/notify/providers.ts	function simulatedProvider(
lib/notify/providers.ts	// Prefixed so nothing can mistake a simulated id for a real one.
lib/notify/providers.ts	lifecycle(result: SendResult, request: SendRequest): ProviderEvent[] {
lib/notify/outreach.ts	const accepted = await provider.send({
lib/notify/outreach.ts	export async function advanceOutreach(
lib/notify/types.ts	export const STATUS_RANK:
lib/notify/types.ts	export function supersedes(
lib/notify/deliver.ts	async function record(
lib/notify/evaluate.ts	 * The half of the matcher that needs no parcel data.
lib/notify/evaluate.ts	function logicalPassId(
lib/notify/evaluate.ts	const previous = search.matches ?? {};
lib/notify/evaluate.ts	const toRaise = pending.slice(0, search.alertLimitPerRun);
lib/notify/evaluate.ts	const tracked = evaluation.rows.slice(0, TRACKED_MATCH_CAP);
lib/notify/evaluate.ts	await store.put<MatcherRunDoc>("matcher-runs", {
lib/criteria/score.ts	export const MATERIAL_FIELDS = [
lib/criteria/score.ts	export function matchHashOf(
lib/criteria/score.ts	export function changedFields(
lib/criteria/score.ts	export function materialSnapshot(
lib/notify/snapshot.ts	export function alertSnapshot(
lib/notify/snapshot.ts	export function toEvaluatedMatch(
lib/crm/repo.ts	export function alertId(
lib/crm/store.ts	 * Read, change, write, with the read repeated if the write raced.
lib/crm/store-github.ts	async update<T extends StoredDocument>(
lib/notify/limits.ts	export const TRACKED_MATCH_CAP =
lib/notify/limits.ts	export const MATCH_ID_CAP =
lib/notify/match-ids.ts	export function encodeMatchIds(
lib/notify/collect.ts	export async function collectMatches(
lib/notify/matcher.ts	export async function runMatcher(
.github/workflows/matcher.yml	# The continuous half of the notification story.
.github/workflows/matcher.yml	- cron: "*/30 * * * *"
app/api/outreach/route.ts	await advanceOutreach();
app/api/opportunities/[id]/route.ts	await advanceOutreach().catch(() => undefined);
app/api/matcher/run/route.ts	const advanced = await advanceOutreach().catch(() => ({
scripts/run-matcher.ts	const advanced = await advanceOutreach().catch(() => ({
test/change-detection.test.ts	describe("match fingerprint", () => {
test/change-detection.test.ts	describe("changed fields", () => {
test/unstable-reads.test.ts	describe("a fingerprint that moves without the artifact moving", () => {
test/unstable-reads.test.ts	describe("an overlay is a real change even though the artifact has not moved", () => {
test/unstable-reads.test.ts	describe("a retried pass", () => {
test/outreach-lifecycle.test.ts	it("addresses only reserved destinations, never a real owner", async () => {
test/outreach-lifecycle.test.ts	it("is idempotent: replaying the same events changes nothing", async () => {
test/outreach-lifecycle.test.ts	it("cannot supersede a terminal status", async () => {
CITATIONS
exit "$fail"
```

That list is the citation set, and it is exhaustive in both directions: every
anchor in it is cited in a table or a sentence below, and nothing below cites
anything that is not in it.

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

| Step in the pattern                                                                                                                        | File                      | Anchor                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The borrowed shape, named in the code itself                                                                                               | `lib/notify/providers.ts` | module header, `* The simulated messaging providers.`                                                         |
| Adapter contract: `idempotencyKey` in, `providerMessageId` out, events carrying `providerEventId` + `providerMessageId`                    | `lib/notify/providers.ts` | `export interface SendRequest {` through `export interface OutreachProvider {`                                |
| Provider message id **derived from** the internal id, which is what makes correlation checkable rather than stored                         | `lib/notify/providers.ts` | `function simulatedProvider(`, minting at `// Prefixed so nothing can mistake a simulated id for a real one.` |
| The event chain a send will follow, each event with its own `providerEventId`                                                              | `lib/notify/providers.ts` | `lifecycle(result: SendResult, request: SendRequest): ProviderEvent[] {`                                      |
| Send, then persist the message with its provider id and its event list in one write                                                        | `lib/notify/outreach.ts`  | `const accepted = await provider.send({`, inside `sendOutreach`                                               |
| Correlate and apply: due events are matched back to the message and folded into a status                                                   | `lib/notify/outreach.ts`  | `export async function advanceOutreach(`                                                                      |
| Normalisation and idempotency: terminal statuses cannot be superseded, a status never walks backwards, a redelivered event changes nothing | `lib/notify/types.ts`     | `export const STATUS_RANK:` and `export function supersedes(`                                                 |
| Alert notifications reuse the same adapters rather than growing a second lifecycle; the idempotency key is `${alertId}:${channel}`         | `lib/notify/deliver.ts`   | `async function record(`                                                                                      |

### What was adapted, and why the original did not fit

**There is no webhook ingress, so the lifecycle is pulled rather than pushed.**
The AWS-shaped original is provider webhook to API Gateway to a queue to a
handler. This deployment has no server awake between requests and no endpoint a
simulator could call. So the provider returns its whole event timeline up front,
each event stamped with the offset at which it becomes due - the `lifecycle`
anchor above - and the events are materialised when wall-clock time passes them.
`advanceOutreach` is invoked from the ordinary request paths -
`app/api/outreach/route.ts`, `app/api/opportunities/[id]/route.ts` and
`app/api/matcher/run/route.ts` - and from the scheduled matcher runner in
`scripts/run-matcher.ts`. All four call sites are in the citation list, so the
checker resolves them. The consequence is the one worth keeping: a direct mail
piece is visibly slower than an SMS instead of both jumping to a final state the
moment a button is pressed.

**Idempotency is a document key plus a monotonic status, not a conditional
put.** The original leans on a DynamoDB conditional write keyed on the provider
event id. There is no DynamoDB here. The same guarantee is assembled from two
things already in the repository: `supersedes` refuses any event that would move
a status backwards or past a terminal one (`lib/notify/types.ts`), and the
document store's read-modify-write contract re-runs the mutation against what is
actually stored rather than against a stale read (`lib/crm/store.ts`,
implemented with a compare-and-set retry loop over blob shas in
`lib/crm/store-github.ts`). Applying the same event twice is therefore a no-op
by construction.

### Evidence you can run

This lifecycle used to be the honest gap in this document: the shape was
borrowed and nothing replayed it. `test/outreach-lifecycle.test.ts` closes it,
with eight tests driving the real `sendOutreach` / `advanceOutreach` path
against an in-memory store. The three that pin the claims above:

- `it("addresses only reserved destinations, never a real owner", ...)` - a
  simulated send can only ever address a reserved destination, so no owner on
  the roll is reachable from a demo.
- `it("is idempotent: replaying the same events changes nothing", ...)` - the
  duplicate-event no-op, asserted rather than reasoned about. A second
  `advanceOutreach` over the same schedule advances no message and leaves the
  status, the status timestamp and the event count identical.
- `it("cannot supersede a terminal status", ...)` - the ordering rule in
  `lib/notify/types.ts` stated directly, including that a status never walks
  backwards.

The other five cover accepting a send and minting a provider id that cannot pass
for a real one, correlating later events back to the message by provider id,
walking the status forward only as scheduled time passes, fast-forward applying
the schedule rather than inventing an outcome, and skipping a missing
opportunity instead of failing the whole campaign. `pnpm test` runs them.

## 3. Pattern borrowed from `watchog`

**The shape:** on a schedule, diff each new snapshot against the last stored
snapshot, and persist an immutable evidence record per decision - including the
decision to do nothing.

| Step in the pattern                                                                                                                                                                | File                            | Anchor                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| The borrowed shape, named in the code itself                                                                                                                                       | `lib/notify/evaluate.ts`        | module header, `* The half of the matcher that needs no parcel data.`                          |
| What a snapshot consists of, and the fingerprint over it                                                                                                                           | `lib/criteria/score.ts`         | `export const MATERIAL_FIELDS = [`, `export function matchHashOf(`                             |
| The diff, and why an absent field is not a change                                                                                                                                  | `lib/criteria/score.ts`         | `export function changedFields(`, `export function materialSnapshot(`                          |
| The record handed to the evaluator, defined once so the browser pass and the scheduled pass build the identical thing                                                              | `lib/notify/snapshot.ts`        | `export function alertSnapshot(`, `export function toEvaluatedMatch(`                          |
| **The diff itself:** last stored snapshot vs this pass, the seeding rule for a never-evaluated search, and the suppression of a fingerprint that moved without the artifact moving | `lib/notify/evaluate.ts`        | `const previous = search.matches ?? {};` and the loop beneath it                               |
| One immutable alert document per decision, written only if the key is not already present                                                                                          | `lib/notify/evaluate.ts`        | `const toRaise = pending.slice(0, search.alertLimitPerRun);`                                   |
| The idempotency key, and a frank account of what it does **not** guarantee                                                                                                         | `lib/notify/evaluate.ts`        | `function logicalPassId(`                                                                      |
| The key as the constraint                                                                                                                                                          | `lib/crm/repo.ts`               | `export function alertId(`                                                                     |
| This pass's observations become the next pass's baseline, capped, with the cap reported rather than applied quietly                                                                | `lib/notify/evaluate.ts`        | `const tracked = evaluation.rows.slice(0, TRACKED_MATCH_CAP);`                                 |
| **The evidence record per pass**, written last and written whether or not anything fired                                                                                           | `lib/notify/evaluate.ts`        | `await store.put<MatcherRunDoc>("matcher-runs", {`                                             |
| The two disclosed caps on what is watched: membership for the whole match set, field-level fingerprints for the best of it by score                                                | `lib/notify/limits.ts`          | `export const MATCH_ID_CAP =`, `export const TRACKED_MATCH_CAP =`                              |
| The stored form of the membership set, sized and diff-shaped for a git-backed document                                                                                             | `lib/notify/match-ids.ts`       | `export function encodeMatchIds(`                                                              |
| One sweep, three sizes, shared by both matchers                                                                                                                                    | `lib/notify/collect.ts`         | `export async function collectMatches(`                                                        |
| The scheduled entry point                                                                                                                                                          | `.github/workflows/matcher.yml` | header comment `# The continuous half of the notification story.` and `- cron: "*/30 * * * *"` |
| Producing the matches the evaluator diffs                                                                                                                                          | `lib/notify/matcher.ts`         | `export async function runMatcher(`                                                            |

### What was adapted, and why the original did not fit

**The schedule is GitHub Actions, not EventBridge.** The reasoning is in the
workflow header: the pass needs native DuckDB to range-read the published
parquet, which a serverless function cannot carry, and the platform's own cron
allows one invocation a day, which is not a notification service. Actions runs
every 30 minutes and writes to the same store through the same
`evaluateAndAlert`, so a cron alert and an alert raised from the app are the
same record.

**Decide-what-to-alert-on was split away from produce-the-matches.** Not in the
original, and added because this application has two producers: the browser
evaluates criteria with DuckDB-WASM, and the scheduled runner does the same with
native DuckDB. `lib/notify/evaluate.ts` takes no parcel data and no engine, so
both feed it - `runMatcher` in `lib/notify/matcher.ts` on the Node side, both of
them through the one sweep in `lib/notify/collect.ts`. Without the split there
would be two implementations of the diff, and they would drift.

**Two things the original does not have, added because the data required
them.** First, a fingerprint that moves while the artifact has not moved is
suppressed rather than alerted on - the loop beneath
`const previous = search.matches ?? {};` - because a gateway resolving one
content name to two pinned generations produced four consecutive passes alerting
on the same 23 parcels. Second, an alert id is keyed on the generation of the
data rather than on the attempt, so a retried pass recomputes the same ids and
delivers nothing (`logicalPassId`). That comment also states plainly what the
key does not cover, which is the part worth reading.

**Membership and field-level history are capped separately**, which the original
has no equivalent of because it diffs a handful of published datasets rather
than a 404,023-parcel roll. A pass remembers which parcels a search matched up
to `MATCH_ID_CAP`, and fingerprints the best `TRACKED_MATCH_CAP` of them by
score; the two numbers, and what each does and does not buy, are in
[`SOLUTION.md`](SOLUTION.md) under "Two caps, because membership and change
detection cost differently".

### Evidence you can run

This pattern is pinned by tests:

- `describe("match fingerprint", ...)` and `describe("changed fields", ...)` in
  `test/change-detection.test.ts` - the fingerprint is stable for an unchanged
  record, moves for a material one, ignores an immaterial one, covers every
  field the snapshot stores, and the diff names exactly what moved.
- `describe("a fingerprint that moves without the artifact moving", ...)` in
  `test/unstable-reads.test.ts` - suppressed, counted, and raises no alert.
- `describe("an overlay is a real change even though the artifact has not moved", ...)`
  in the same file - an overlay is a real change even though the parquet has
  not moved.
- `describe("a retried pass", ...)` in the same file - a retried pass does not
  notify twice, whoever repeats it.

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
