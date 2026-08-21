# Residential Property Acquisition CRM - implementation notes

The assignment text is in [`README.md`](README.md), unchanged. This file is the
implementation: what was built, how to run it, what it can and cannot answer,
and the test plan that doubles as the demo script.

## Business intent

**An acquisitions analyst can save the criteria that define a target residential
property in Duval County and be told, without asking again, which parcels newly
match them as the county pipeline refreshes, so that outreach starts from a
ranked, source-backed candidate list instead of a manual roll search.**

Everything below exists to make that one sentence true and checkable.

---

## What it runs on

| Role | Choice | Why |
|---|---|---|
| Runtime | Next.js 16 / React 19 / TypeScript on Vercel | no always-on server to pay for |
| Property data | DuckDB over the published parquet, server side, via HTTP range reads | 404,023 parcels queryable with no database |
| CRM state | Postgres (Neon free tier) via Drizzle | thousands of rows, not hundreds of thousands |
| Map | MapLibre GL, raster basemap declared inline | no API key, no style-document dependency |
| Agent | Vercel AI SDK, bring-your-own-key across seven providers | no server-side key on a public endpoint |
| Schedule | GitHub Actions cron every 30 minutes | Vercel Hobby allows one cron a day, which is not a notifier |

The property corpus is never copied into Postgres. That is the whole point of
the split, and it is what makes the story's cost criterion - *"without requiring
Oracle to carry ongoing hosted-database cost beyond the existing Duval pipeline +
DuckDB / Elephant IPFS pattern"* - true rather than aspirational.

---

## The data source is swappable by design

Every property read goes through one interface, `PropertyDataSource`
([`lib/data/types.ts`](lib/data/types.ts)). Nothing outside `lib/data/` opens a
parquet or builds a URL.

```
info()                  what is loaded, how big, is it a sample, which run made it
getSchema()             column descriptors, meanings, which are derived or provenance
search(query)           ranked rows + total + per-criterion score contributions + the SQL
getProperty(id)         the full published record with provenance
lookup(term)            address / owner / parcel id
listRuns(limit)         pipeline runs with per-source inserted/updated/unchanged
runSql(sql, limit)      read-only escape hatch for the agent
```

Swapping the bundled sample for the full published county artifact is **one
environment variable**:

```
PROPERTY_DATA_URL=https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r
```

The header says which of the two is answering, always. There is no state where
the app runs on a subset without saying so.

### The bundled sample is real county data

`public/sample/query-table.parquet` is **75,988 genuine Duval parcels** across
the five Arlington and Southside ZIP codes (32211, 32277, 32225, 32246, 32216),
cut from the artifact the pipeline published. It exists so `git clone && pnpm
install && pnpm dev` works with no network and no credentials. It is not the
deliverable dataset.

---

## How the notification loop actually works

This is the part worth reading carefully, because it is where a CRM like this
usually cheats.

### Change detection lives here, not in the parquet

Checked against the real 404,023-row artifact: `run_id`, `source_run_id` and
`features_run_id` are **uniform across every row**. They identify the export, not
the last touch on a parcel. So there is no per-row change stamp to read, and
anything claiming to detect "changed parcels" from the parquet alone would be
inventing it.

What the pipeline *does* publish is `run-history.json`: fifteen runs, each with
per-track `inserted` / `updated` / `unchanged` / `table_total_after` and the
limitations that run declared for itself. That is real evidence, and every alert
cites a run id from it.

So the matcher follows the snapshot-diff shape:

1. Re-evaluate every active saved search against the current data.
2. Fingerprint each matching parcel over the **sixteen fields an acquisitions
   team would act on** (`MATERIAL_FIELDS` in [`lib/criteria/score.ts`](lib/criteria/score.ts)).
3. Diff against the fingerprints stored last pass.
4. Raise `new_match` for parcels new to the search, `updated_match` for parcels
   whose material fields moved, naming exactly which ones.
5. Write an immutable evidence row for the pass - **whether or not it fired**.

A re-export that moves nothing material raises nothing. A change to a transit
distance is not news; a change to the owner, the assessed value, the roof
evidence or the tenure is.

### Three properties it has to hold

- **A new saved search seeds, it does not shout.** The first pass records what
  already matches without alerting. Otherwise saving "roofs over fifteen years"
  would fire three hundred thousand alerts about houses that have sat there for
  a decade. What the user asked to be told about is what changes *from now on*.
- **Re-running is safe.** Alerts are unique on (search, property, pass), so a
  retry after a timeout cannot double notify.
- **A broad search is capped and says so.** Each search caps alerts per pass and
  the pass records how many it suppressed.

### Why passes that raise nothing are still recorded

A history that only records the passes that produced something cannot answer
*"why did nothing arrive last night"*, which is the question people actually
ask. `/pipeline` shows every pass.

---

## The overlay: real changes, not staged ones

Two things are true about a parcel but not in the parquet, and both live in one
mechanism ([`lib/data/overlay.ts`](lib/data/overlay.ts)) joined in as a CTE:

1. **Court filings** - foreclosure, lien, probate, code enforcement. They arrive
   continuously and are small, so a filing recorded a minute ago changes who
   matches immediately rather than waiting for the six-hourly county export.
2. **Simulated pipeline updates** - the demo requirement.

The simulation does not inject a notification. It writes a **real row** the
matcher reads - a reassessment, a re-roof permit, an owner change, a new court
filing - stamped with a `sim-` run id, and then the ordinary matcher pass finds
it by diffing. Nothing about the resulting alert is special-cased, which is the
only way the demo proves anything about the real path. It is labelled everywhere
it appears and `Clear simulation` restores the published values.

With no overlay, queries read the parquet view directly and it costs nothing.

---

## Match scoring

Criteria are data, not code: one zod-validated `CriteriaSet` is posted by the
filter panel, stored as jsonb on a saved search, produced by the agent from a
sentence, and replayed by the matcher hours later.

[`lib/criteria/sql.ts`](lib/criteria/sql.ts) builds **both** the `WHERE` clause
and the score expression from it, in SQL. Ranking done in TypeScript over a page
of results would make the matcher and the map disagree about which parcels are
the best ones, and the disagreement would only surface later as a wrong alert.

Rules:

- Only criteria the user actually set take part. A search filtering on roof age
  alone is scored on roof age alone, not diluted by five components nobody asked
  for.
- Weights are relative and normalised across the participating components.
- Meeting a threshold earns 60% of a component; the remaining 40% ramps over the
  next 15 years past it.
- Cheaper scores higher inside a requested value band - a budget is a ceiling.
- With no ranking signals at all, everything scores 100 and the rationale says
  so, rather than inventing an order.

The rationale quotes the values behind the number:

> held 35 years (+33); roof about 53 years old, estimated from year built (+33);
> absentee owner, no homestead exemption (+33).

---

## What the data can and cannot answer

Stated here rather than discovered by a reviewer.

- **Roof age is usually a proxy.** `roof_age_basis` containing `PROXY` means the
  county publishes no roof date and the year built stands in, which over-counts
  re-roofed houses. The filter panel has a "only roofs with real evidence"
  toggle; the list marks proxied roofs with an asterisk; the agent is required
  to say so.
- **Ownership tenure needs the published artifact.** A locally built roll carries
  only the current roll period's sales, so `years_since_last_sale` is null on
  most parcels and "no ownership change in 10+ years" returns nothing. The
  published table is built where the county's own sales history is reachable:
  tenure is filled on **401,832 of 404,023** parcels, and 153,240 have been held
  ten years or more.
- **Court signals need a store.** Without a CRM store there are no court records,
  and the court filters are disabled with that reason shown. Their absence is
  not evidence that no filings exist.
- **Absentee and owner-region signals use the tax mailing address**, which is not
  proof of residence.
- **Water view is a proximity proxy**, not a confirmed view. Distances are
  straight lines from the parcel centroid, not walking routes.
- **Outreach is simulated.** Messages address a reserved `.invalid` domain and a
  555 number. Nothing reaches a property owner.

---

## Running it

```bash
pnpm install
pnpm dev          # works with no credentials at all
```

That gives the map, the criteria panel, scored search, the parcel detail with
full provenance, and the CSV property export, over 75,988 real parcels. The
header says SAMPLE and the CRM pages say no store is attached.

### Full county data

```bash
PROPERTY_DATA_URL=https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r \
RUN_HISTORY_URL=https://ipfs.filebase.io/ipfs/bafybeif2bwakcxmc3p2rkczkqvuecin6657oihsdm5mba5lktajoazemdm \
pnpm dev
```

### The CRM half

Any Postgres. Neon's free tier needs no card.

```bash
echo 'DATABASE_URL=postgresql://...' >> .env.local
pnpm db:migrate
pnpm db:seed        # a team, three theses, nine worked opportunities
```

### The scheduler

`.github/workflows/matcher.yml` calls `POST /api/matcher/run` every 30 minutes.
On the repository running it, set the variable `RUNTIME_URL` to the deployment
and the secret `MATCHER_TOKEN` to the same value as the deployment's
`MATCHER_TOKEN`.

### Everything else

`.env.example` documents every variable and why it exists. No secret is in the
repository.

---

## Test plan, which is also the demo script

Each step states what to look for. All of it runs against the deployed URL.

1. **Open `/`.** The header states the dataset and its size. If it says a parcel
   count without SAMPLE, the full published county table is loaded.
2. **Open `/search`.** Pick the *Tired landlord* thesis. Watch the count settle
   as the criteria apply - it is debounced, not a button. Expand *Show the SQL
   behind this result*: the statement that produced the count is on screen.
3. **Draw an area.** `Radius`, click a centre, click again for the radius. The
   count drops to what is inside it. `Polygon` works the same way; double click
   closes it.
4. **Open a parcel.** Confirm the grouped published columns, and the Provenance
   block with a clickable source URL, the collection timestamp and the pipeline
   run id.
5. **Save the search.** The dialog states that the first pass records a baseline
   without alerting. Enable in-app and mocked email.
6. **Go to `/searches`.** The saved search shows when it was last evaluated,
   against which pipeline run, and how many matched.
7. **Press `Simulate: new court filings`.** This writes real court records
   against parcels that fit everything else, then runs the ordinary matcher. The
   result line names the synthetic run id and how many alerts it raised.
8. **Go to `/alerts`.** Each alert shows the search that raised it, the pipeline
   run id that triggered it, the fields that changed, the score rationale, and -
   under `Detail` - the mocked email body that would have gone out.
9. **Convert one to an opportunity.** It lands at Identified with the owner
   attached and the match rationale preserved.
10. **Open `/opportunities`.** Board and table views. Filter by stage, match
    score, city and ownership signal. Select rows in the table and launch a
    mocked campaign.
11. **Open an opportunity.** Advance the stage and watch the stage history
    record it. Add a note and a task. In the outreach thread, scheduled provider
    events are dimmed until their time arrives; `Fast forward lifecycle` pulls
    them to now, and the status walks sent → delivered → opened → replied or
    bounced.
12. **Export.** `Export CSV` for the opportunity set, `Mailing list` for owners
    with a mailing address. Both carry the source system and pipeline run id.
13. **Open `/pipeline`.** Upstream pipeline runs with their real per-source
    counts and declared limitations, next to every matcher pass including the
    ones that raised nothing. Press `Run matcher now`; a new pass appears.
    `Clear simulation` removes the simulated rows.
14. **Open `/agent`.** Add a free-tier key on `/settings` first. Ask *"Which
    residential properties in the Arlington area match my distressed criteria and
    have not been contacted yet?"* Check the `Tools` and `Rows` tabs under the
    answer, and the caveats block.
15. **Scroll to the bottom of `/opportunities`.** Disposition, portfolio tracking
    and live messaging are visible and disabled, with the reason each is out of
    scope for this milestone.

---

## Deviations from the engineering guidelines

The kit's `apply-engineering-guidelines` was loaded and followed where it does
not conflict with the story. Deviations, stated rather than hidden:

| Rule | What was done | Why |
|---|---|---|
| `cloud-aws-primary`, CDK-only IaC | No AWS. Vercel plus GitHub Actions. | The story explicitly forbids ongoing hosted infrastructure cost. |
| Powertools / X-Ray / CloudWatch | Structured JSON logs to stdout; metrics surfaced in-app on `/pipeline`. | No Lambda and no CloudWatch to publish to. |
| PagerDuty on critical failure, DLQ alarms | Matcher failures are recorded on `matcher_runs` with the error and shown in the UI. | No on-call rotation exists for a take-home. |
| Lexicon metric registration | Not done. | That repository is not part of this deliverable. |
| `integrate-ci-cd` | Plain GitHub Actions workflows. | That skill's contract is a justfile of `cdk synth` / `cdk deploy` recipes. |

Kept in full: TypeScript everywhere, all LLM interaction through the Vercel AI
SDK with zod tool schemas and no `any` on any LLM path, Vitest, Prettier,
ESLint, `tsc --noEmit`, structured logging, and no secret in the repository.

## Kit usage

`arceus` was asked to route this first. It returned **no clean agent match**:
every fullstack, RAG and CI agent in the kit is bound to AWS, Lambda, CDK,
Bedrock or Step Functions, which this story forbids. Its instruction was to build
directly with `apply-engineering-guidelines` loaded, borrowing two patterns,
which is what was done:

- **`chatot` / `manage-communication-activity`** for the mocked outreach
  lifecycle: send returns a provider message id, status arrives as discrete
  events carrying that id, correlation maps it back to the internal record, and
  status writes are idempotent on the provider event id.
- **`watchog`** for the scheduled matcher: diff each new snapshot against the
  last stored one, and persist an immutable evidence record per pass.

## Shared code

`lib/oracle/` is **vendored** from the Duval pipeline repository at commit
`28088d0`, not written here: the published column contract, the read-only SQL
guard, the per-column meanings, and the whole bring-your-own-key provider
registry. See [`lib/oracle/VENDORED.md`](lib/oracle/VENDORED.md) for why it is a
copy rather than a package - each assignment is graded as an independently
clonable repository - and `scripts/sync-shared.mjs` to check the two copies for
drift.
