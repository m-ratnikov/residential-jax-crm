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

| Role             | Choice                                                                                         | Why                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Runtime          | Next.js 16 / React 19 / TypeScript on Vercel                                                   | no always-on server to pay for                                 |
| Property queries | DuckDB-WASM **in the visitor's tab**, range reading the published parquet off the IPFS gateway | 404,023 parcels queryable with no database and no query server |
| CRM state        | JSON documents committed to a git branch (Postgres and in-process are drop-in alternatives)    | thousands of rows, and no database to provision or pay for     |
| Map              | MapLibre GL, raster basemap declared inline                                                    | no API key, no style-document dependency                       |
| Agent            | Vercel AI SDK, bring-your-own-key across seven providers, loop runs in the tab                 | its tools need the parcel data, which is in the tab            |
| Schedule         | GitHub Actions cron every 30 minutes, native DuckDB                                            | Vercel Hobby allows one cron a day, which is not a notifier    |

The property corpus is never copied into a database, and no server in this
system holds a query engine. That is not a convenience: the story's cost criterion is
_"without requiring Oracle to carry ongoing hosted-database cost beyond the
existing Duval pipeline + DuckDB / Elephant IPFS pattern"_, and that sentence
names an architecture. DuckDB-WASM range reading the published artifact from the
tab **is** that pattern. Nothing is copied, nothing is converted, and when the
pipeline re-points its IPNS name the next page load reads the new data with no
redeploy.

### Where each piece runs, and why

| Runs in          | What                                                                                              | Why there                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The tab          | every parcel query: map, list, detail, scoring, the property CSV, the agent's tools               | the query engine is here, so this is where the authoritative record is   |
| Vercel functions | the CRM store: saved searches, alerts, opportunities, outreach, tasks, court records, the overlay | the store's credential lives here, and nothing else does                 |
| GitHub Actions   | the scheduled matcher, with native DuckDB                                                         | a runner can use the better engine, and a cron belongs outside a request |

Producing matches and deciding what to alert on are separated
([`lib/notify/evaluate.ts`](lib/notify/evaluate.ts)) precisely so the tab and the
cron hand the identical shape to the same decision code. An alert raised by the
schedule and an alert raised by pressing a button in the app are the same code
path, with no second implementation to drift.

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

There are two implementations of it, and swapping between the bundled sample and
the full published county artifact is **one environment variable**:

```
NEXT_PUBLIC_PROPERTY_DATA_URL=https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r
```

- `BrowserPropertyDataSource` - DuckDB-WASM in the tab. The deployed read path.
- `DuckDbPropertyDataSource` - native DuckDB in Node, used by the scheduled
  matcher and the seed script. Its engine seam
  ([`lib/data/engine.ts`](lib/data/engine.ts)) also carries a WASM fallback for
  environments where the native addon will not load.

The interface earned its keep: when the native engine turned out to be
undeployable, twelve integration tests passed unmodified against the replacement.

The header says which of the two is answering, always. There is no state where
the app runs on a subset without saying so.

### The bundled sample is real county data

`public/sample/query-table.parquet` is **75,988 genuine Duval parcels** across
the five Arlington and Southside ZIP codes (32211, 32277, 32225, 32246, 32216),
cut from the artifact the pipeline published. It exists so `git clone && pnpm
install && pnpm dev` works with no network and no credentials. It is not the
deliverable dataset.

---

## The CRM store is swappable too, and its default has no database

The story asks for a CRM that runs _"without requiring Oracle to carry ongoing
hosted-database cost beyond the existing Duval pipeline + DuckDB / Elephant IPFS
pattern"_. A managed Postgres on a free tier satisfies the invoice and not the
sentence: it is still a hosted database, still an account somebody owns, still a
thing that suspends, expires, or starts costing money when the row count or the
company changes. So the default backend is not a database at all.

Everything the CRM writes goes through one interface, `CrmStore`
([`lib/crm/store.ts`](lib/crm/store.ts)) - `list`, `get`, `put`, `remove`,
`clear` over JSON documents in named collections. Three implementations:

| Backend                                                          | Used when                             | What it costs                       |
| ---------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| **Git documents** ([`store-github.ts`](lib/crm/store-github.ts)) | `CRM_STORE_REPO` is set (the default) | nothing; a repository, not a server |
| Postgres ([`store-postgres.ts`](lib/crm/store-postgres.ts))      | `DATABASE_URL` is set                 | whatever the database costs         |
| In process ([`store-memory.ts`](lib/crm/store-memory.ts))        | neither is set                        | nothing, and it forgets on restart  |

The git backend commits one JSON document per aggregate to a branch, which is
the same mechanism the Duval pipeline already uses to commit its run history.
It is deliberately a narrow bet, and the constraints that make it safe are:

- **The document key carries the invariants** a schema would spend unique indexes
  on: `opportunities/<propertyId>`, `alerts/<runId>__<searchId>__<parcelId>`. Two
  writers cannot open a second opportunity on the same parcel or double-notify
  the same match, because they would be writing the same path.
- **Aggregates are stored whole.** An opportunity carries its stage history,
  notes, tasks and outreach inside it, so a deal is one read and one write, not
  a join.
- **Unchanged documents are not written.** The matcher runs every thirty minutes
  and most passes change nothing; a `put` matching what is stored returns without
  a commit, so steady state produces no history at all.
- **Reads are content addressed.** Documents are fetched by blob sha, not from
  `download_url`, because the raw host is a CDN that serves a stale copy for
  minutes after a write. That is not a theoretical concern: it silently dropped a
  note during seeding, where a read-modify-write read the pre-note document.
- **A write updates the read cache in place** rather than invalidating it, so the
  process that wrote a document always reads back what it wrote.

Where it stops: writes are serialised per branch and cost a round trip, so this
suits a small acquisitions team, not a call centre. That is why the interface
exists and why the Postgres backend is kept working - the swap is one
environment variable, with no code change and no data model change. The same
verification script (`pnpm verify`) passes against all three.

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

What the pipeline _does_ publish is `run-history.json`: fifteen runs, each with
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
  a decade. What the user asked to be told about is what changes _from now on_.
- **Re-running is safe.** Alerts are unique on (search, property, pass), so a
  retry after a timeout cannot double notify.
- **A broad search is capped and says so.** Each search caps alerts per pass and
  the pass records how many it suppressed.

### Why passes that raise nothing are still recorded

A history that only records the passes that produced something cannot answer
_"why did nothing arrive last night"_, which is the question people actually
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

Nothing is required. With no store configured the whole loop works in process
and is lost on restart, which the app says on screen rather than leaving to be
discovered. To keep it, point it at a repository:

```bash
cat >> .env.local <<'EOF'
CRM_STORE_REPO=owner/residential-jax-crm
CRM_STORE_TOKEN=github_pat_...        # fine-grained, one repo, contents: write
EOF
pnpm seed           # a team, three theses, nine worked opportunities
```

The branch (`crm-state`) and directory (`crm`) are created on the first write.
Set `DATABASE_URL` instead for the Postgres backend; the table is created on
first use and there is no migration step.

### The scheduler

`.github/workflows/matcher.yml` runs the matcher itself every 30 minutes, on the
runner, with native DuckDB against the published artifact. On the repository
running it set:

- variables `CRM_STORE_REPO`, `CRM_STORE_BRANCH`, `CRM_STORE_ROOT` - the same
  store the deployment writes to (or secret `DATABASE_URL` for the Postgres
  backend). No token secret is needed when the store is a branch of the
  repository running the workflow: the pass writes with the run's own
  `GITHUB_TOKEN`, which expires when the run ends
- variables `PROPERTY_DATA_URL` and `RUN_HISTORY_URL` - the published artifacts

It writes to the store directly rather than calling the deployment, so it needs
no runtime URL. The workflow refuses to start when no store is configured: a
pass that silently evaluated an in-process store would report green having
alerted nobody.

To run one by hand:

```bash
pnpm matcher
```

### Proving the deployed runtime

```bash
npx tsx scripts/smoke.mts https://residential-jax-crm.vercel.app
```

Opens a real browser against the live URL and asserts that the artifact attaches
over the gateway, the parcel count is county scale, a criteria search returns
scored matches, the rationale cites real values, the SQL is disclosed and the
parcel drawer shows provenance. It writes `smoke-search.png`.

### Everything else

`.env.example` documents every variable and why it exists. No secret is in the
repository.

---

## Test plan, which is also the demo script

Each step states what to look for. All of it runs against the deployed URL.

1. **Open `/`.** The header states the dataset and its size. If it says a parcel
   count without SAMPLE, the full published county table is loaded.
2. **Open `/search`.** Pick the _Tired landlord_ thesis. Watch the count settle
   as the criteria apply - it is debounced, not a button. Expand _Show the SQL
   behind this result_: the statement that produced the count is on screen.
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
14. **Open `/agent`.** Add a free-tier key on `/settings` first. Ask _"Which
    residential properties in the Arlington area match my distressed criteria and
    have not been contacted yet?"_ Check the `Tools` and `Rows` tabs under the
    answer, and the caveats block.
15. **Scroll to the bottom of `/opportunities`.** Disposition, portfolio tracking
    and live messaging are visible and disabled, with the reason each is out of
    scope for this milestone.

---

## Deviations from the engineering guidelines

The kit's `apply-engineering-guidelines` was loaded and followed where it does
not conflict with the story. Deviations, stated rather than hidden:

| Rule                                      | What was done                                                                                 | Why                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cloud-aws-primary`, CDK-only IaC         | No AWS. Vercel plus GitHub Actions.                                                           | The story explicitly forbids ongoing hosted infrastructure cost.           |
| Powertools / X-Ray / CloudWatch           | Structured JSON logs to stdout; metrics surfaced in-app on `/pipeline`.                       | No Lambda and no CloudWatch to publish to.                                 |
| PagerDuty on critical failure, DLQ alarms | Matcher failures are recorded as `matcher-runs` documents with the error and shown in the UI. | No on-call rotation exists for a take-home.                                |
| Lexicon metric registration               | Not done.                                                                                     | That repository is not part of this deliverable.                           |
| `integrate-ci-cd`                         | Plain GitHub Actions workflows.                                                               | That skill's contract is a justfile of `cdk synth` / `cdk deploy` recipes. |

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
