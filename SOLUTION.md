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
| Agent            | Vercel AI SDK, loop runs in the tab, model call proxied server-side on this deployment's key   | its tools need the parcel data, which is in the tab            |
| Schedule         | GitHub Actions cron every 30 minutes, native DuckDB                                            | Vercel Hobby allows one cron a day, which is not a notifier    |

The property corpus is never copied into a database, and no server in this
system holds a query engine. That is not a convenience: the story's cost criterion is
_"without requiring Oracle to carry ongoing hosted-database cost beyond the
existing Duval pipeline + DuckDB / Elephant IPFS pattern"_, and that sentence
names an architecture. DuckDB-WASM range reading the published artifact from the
tab **is** that pattern. Nothing is copied, nothing is converted, and when the
pipeline re-points its IPNS name the next page load reads the new data with no
redeploy.

The artifact is **49,974,055 bytes** - 49.97 MB, which the UI renders as 47.7 MB
because it divides by 1024 twice - and the read path has three modes, each of
which the Data source panel names as it happens:

- **Ranged.** The normal path. A query costs a few hundred kilobytes of HTTP
  byte-range requests against the artifact, not a copy of it.
- **Downloaded.** A gateway that ignores `Range` is not failed over, it is
  downloaded from once. That is slower, not broken.
- **Cached.** A copy this browser already holds, attached with no network at
  all.

One thing a reader would not guess from "range reading" alone: on the ranged
path a **whole-object fetch still happens**, once per publish, in the
background on idle after the page is already interactive. A range read
deliberately never touches most of the file, so without it there would be
nothing on disk to fall back on when every gateway is down - see the cache
below.

### Where each piece runs, and why

| Runs in          | What                                                                                              | Why there                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The tab          | every parcel query: map, list, detail, scoring, the property CSV, the agent's tools               | the query engine is here, so this is where the authoritative record is   |
| Vercel functions | the CRM store: saved searches, alerts, opportunities, outreach, tasks, court records, the overlay | the store's credential lives here, and nothing else does                 |
| GitHub Actions   | the scheduled matcher, with native DuckDB over one whole-artifact download                        | a runner can use the better engine, and a cron belongs outside a request |

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
undeployable, the integration suite in
[`test/data-source.test.ts`](test/data-source.test.ts) - thirteen tests driving
the real parquet rather than a mock - passed unmodified against the replacement.

The header says which of the two is answering, always. There is no state where
the app runs on a subset without saying so.

### One gateway is a single point of failure, so there is more than one

Every read in the tab goes to one IPFS gateway, and a public gateway is allowed
to be slow or to be down. Depending on a single one with no fallback is a real
availability risk and it had a real symptom: a bad minute at the gateway was
indistinguishable from a broken deployment, because the page sat on "attaching"
with nothing on screen to explain itself.

The gateway named in `NEXT_PUBLIC_PROPERTY_DATA_URL` still leads. Behind it,
`NEXT_PUBLIC_IPFS_GATEWAYS` is a list of alternates, by default
`https://ipfs.io`, `https://{id}.{ns}.dweb.link` and `https://ipfs.filebase.io`.
Each is applied to the content id the configured URL already names, so every
candidate addresses the identical artifact and failing over cannot quietly
change which data is loaded.

**Two candidate shapes, because the two public gateway conventions are not
interchangeable.** A plain origin is a path rewrite
(`https://ipfs.io/ipns/<name>`). A `{id}`/`{ns}` template is a **subdomain**
rewrite (`https://<name>.ipns.dweb.link/`), and it exists for dweb.link
specifically: the path form `https://dweb.link/ipns/<name>` answers the CORS
preflight with a 301, and a redirected preflight is a hard failure by
specification - the browser never sends the real request that follows. That URL
used to be half the default fallback list and could not have worked, in any
browser, ever. The subdomain form it redirects to serves the identical bytes
with no hop. A template is dropped rather than mangled when the content id is
not a valid DNS label, which is why a CIDv0 `Qm...` simply produces one fewer
candidate.

The order is fixed and not measured: the gateway in the data URL, then the
alternates in the order they are listed. A **one-byte ranged `GET`**
(`Range: bytes=0-0`, `NEXT_PUBLIC_GATEWAY_PROBE_TIMEOUT_MS`, 8s) is the cheap
gate in front of each candidate in turn, not a race that reorders them. It is
deliberately the exact request the engine will make, preflight included: the
probe used to be a `HEAD`, chosen to avoid that preflight, and avoiding it was
how a gateway that could never have served a browser kept passing. A gateway
that will not answer one byte in eight seconds is not going to range read 50 MB,
so failing the probe skips it for the price of one request instead of the whole
`NEXT_PUBLIC_ATTACH_TIMEOUT_MS` (45s) the candidate would otherwise get.

The probe then asks two narrow questions. **Is it there:** 405 and 501 mean the
gateway is present and does not implement the method, which counts as an answer,
while 404 and anything 5xx do not. A plain 200 passes too, because the engine
copes with a gateway that refuses range reads by downloading once, and failing
one over for that would be failing it over something it can handle. **Is it
serving the artifact:** a gateway is allowed to answer a range request with an
error page, and gw3.io does exactly that, reporting a 965-byte total for a 50 MB
parquet. A 206 claiming less than `NEXT_PUBLIC_ARTIFACT_MIN_BYTES` (1 MB) is
refused rather than believed, because believing it costs a whole attach deadline
and then an unreadable parse error.

**A refusal is retried and silence is not.** A gateway that answers 502 or a
rate limit is asked again after a backoff (`NEXT_PUBLIC_GATEWAY_ATTEMPTS`, 2,
starting at 750 ms and doubling to a cap of 8x); one that consumed its whole
deadline saying nothing is dropped, because a second ask buys the same silence
at twice the price. The whole list is then swept again
(`NEXT_PUBLIC_GATEWAY_PASSES`, 2) rather than abandoned, since a public
gateway's bad thirty seconds is not a bad session, and all of it sits inside one
wall-clock bound (`NEXT_PUBLIC_ATTACH_BUDGET_MS`, 120s) so the worst case is a
number rather than a multiplication. After the first sweep fails, this browser's
own cached copy is attached with no network at all.

Between candidates the engine is torn down, so a half-attached one cannot answer
the next gateway's queries from the previous one's file handle. The attach state
is on screen throughout, saying which gateway of how many is being tried, and
offering a retry rather than an empty list if every one of them refuses.

### The cache is a fallback, so it is keyed on the content and filled on purpose

A range read is the right way to answer a query and exactly the wrong way to
leave a copy behind: it touches a few hundred kilobytes of a 50 MB file. The
vendored engine only ever wrote to its cache on the whole-download path, so on
the deployment that matters - the one where range reads work - the cache was
never populated and never saved anybody from anything. Two deliberate
divergences fix that, each stated at the top of the file it is in
([`lib/oracle/opfs.ts`](lib/oracle/opfs.ts),
[`lib/oracle/duckdb.ts`](lib/oracle/duckdb.ts)).

**Entries are keyed on the content, not on the gateway.** `contentAddressOf`
reduces both gateway shapes - `https://ipfs.io/ipns/k51.../x.parquet` and
`https://k51....ipns.dweb.link/x.parquet` - to the same `ipns/k51.../x.parquet`,
and the OPFS filename is a hash of that. So the copy taken from ipfs.io last
week is found when the configured Filebase URL is the one being asked about
today. Keying on the URL stored the same 50 MB once per gateway and still missed
whenever failover landed somewhere new.

**It is filled after a successful attach, never before one.** `precacheArtifact`
runs once, from `requestIdleCallback`, only on the success path - after the page
is interactive and the visitor is waiting on nothing. It is skipped when a copy
of this exact publish is already present (matched on `x-ipfs-roots`, ETag or
Last-Modified), when the object is larger than
`NEXT_PUBLIC_ARTIFACT_CACHE_MAX_BYTES` (128 MB), and when OPFS is unavailable -
a private window or a locked-down profile, where the in-memory fallback is right
for a 4 KB manifest and absurd for 50 MB that would not outlive the tab.
`NEXT_PUBLIC_ARTIFACT_PRECACHE=0` turns it off. The bytes are written before the
manifest, deliberately: a tab closed mid-write leaves bytes with no manifest,
which reads as "nothing cached", where the other order would leave a manifest
promising a truncated file.

**Reading it has two modes and only one of them may be stale.** A normal load
takes the strict read - a cached copy is used only when its version matches what
the gateway reports, so last week's bytes never pre-empt this morning's publish.
The relaxed read, any version, is reached for in exactly one place: after a
whole sweep of every gateway has failed. Anything served that way is labelled
with its size and the date it was taken, on the header and on the Data source
panel, because a stale answer presented as a fresh one is worse than no answer.

**Nothing evicts.** The cache holds at most one entry per content address,
overwritten in place when the same address is republished; a republish under a
new address leaves the old copy until the browser reclaims the origin's storage.
For one artifact per deployment that is the right trade, and it is stated here
rather than left to be found.

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
([`lib/crm/store.ts`](lib/crm/store.ts)) - `list`, `get`, `put`, `update`,
`remove`, `clear` over JSON documents in named collections. Three
implementations:

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
- **Nothing reads a document and writes it back with `put`.** A git backend
  cannot merge, so a `put` built from a read taken a moment earlier is an
  overwrite of whoever wrote in between, and the loser leaves no trace in the
  history. Every such caller goes through `update(collection, id, mutate)`
  instead: the mutation is handed the current document and is re-run against the
  winner if the write raced, which is why it has to be pure. Two people adding a
  note to the same opportunity in the same minute both keep their note, and a
  simulation appending a court filing cannot erase a real one recorded while it
  was running.

Where it stops: writes are serialised per branch and cost a round trip, so this
suits a small acquisitions team, not a call centre. That is why the interface
exists and why the Postgres backend is kept working - the swap is one
environment variable, with no code change and no data model change.

`pnpm verify` runs the whole notification loop against whichever backend is
configured, and seeds what it needs first, so it is a single command against any
of the three rather than a script that assumes somebody already ran the seed in
the same process.

Its last step is the one that is not like the others: it converts the alert it
just raised into an opportunity **through the route handler**, invoked in process
with the real mutation guard and the real zod schema. Everything before it calls
the repository directly, and so does `pnpm seed` - which is exactly how the worst
bug here survived. The POST the application itself uses asserted
`z.string().uuid()` on four id fields and nothing in this system has ever minted
a UUID, so the first step of the demo script returned 400 on the deployed
runtime while every script stayed green, because no script was driving a route.

### Who can write, on whose credential

This deployment is public, has no login, and holds a write token. Those three
facts together mean it writes on the owner's credential for whoever shows up,
and no amount of configuration changes that while the runtime stays open. A
login would close it and would also make the runtime unusable for its actual
purpose, so what is here is a set of bounds, and
[`lib/api-auth.ts`](lib/api-auth.ts) states them and their limits rather than
implying more:

- **A kill switch.** `CRM_READ_ONLY=1` refuses every mutation. An environment
  variable rather than a code change, so a deployment under abuse is frozen from
  a dashboard in seconds without a redeploy and without taking search offline.
- **A lock, for deployments that are not demos.** `CRM_WRITE_TOKEN` makes
  mutations require it. Unset here, which is what keeps a reviewer's browser
  working with no setup.
- **A same-origin gate.** A mutation must carry an `Origin` naming this
  deployment and must not announce itself as cross-site. This is real protection
  against one thing - another page driving a visitor's browser into writing here
  - because a browser sets both headers itself and page script cannot forge
    either. It also turns `curl -X POST` into a 403.
- **Rate limits per address**, tighter on a matcher pass, an outreach campaign
  or a simulation.

**What it does not stop**, exactly: a caller who adds `-H "Origin: <this
deployment>"` is through the gate, because that step reads a header and only a
browser is obliged to be truthful in it. What remains is the rate limit, and
that limiter counts per serverless instance rather than globally. So the
boundary is: no cross-site writes, no drive-by writes from a bare request, and a
bounded rate of writes for someone who reads the source and decides to write
anyway.

### The store survives being rate limited

GitHub counts its 5,000 requests an hour **per user**, not per token, so a local
script and the deployment draw on one budget. Two things keep the CRM inside it:
the whole branch is read in a single `git/trees` request rather than a directory
listing plus a blob per document, and that request is conditional - a `304 Not
Modified` costs nothing, measured, so polling for changes is free and the budget
is spent only when something is written.

When it is exhausted anyway, a refused read serves the last good copy and the UI
says it is showing state a few minutes old. A CRM answering 500 to its own board
with the data perfectly intact is a worse outcome than one that is slightly
behind.

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

What the pipeline _does_ publish is `run-history.json`: every run it has made,
each with per-track `inserted` / `updated` / `unchanged` / `table_total_after`
and the limitations that run declared for itself. That is real evidence, and
`/pipeline` shows it beside the CRM's own passes.

The count on that page is deliberately **not quoted here, because it moves**.
`RUN_HISTORY_URL` is the pipeline's `oracle-run-history-duval` **IPNS name**,
which re-points on every publish, so `/pipeline` shows whatever the pipeline has
published by the time the page is opened, and that will be a larger number than
the last time anybody looked. Pointing that variable at a CID instead would pin
the page to one immutable snapshot and freeze the count, which is the one thing
a page about continuous refresh must not do. With the variable unset the bundled
eight-run sample history answers instead, and the tile is badged as the sample.

**Pipeline runs published** on that page is the published document's own
`runCount`, read off the envelope, not the length of the list underneath it.
The two are not the same number and the page used to confuse them: it asked for
25 runs, printed 25 from what came back, and the artifact held forty-odd - so
the page was reporting its own page size as the pipeline's history, and a
reviewer who opened the IPNS document saw a different number. A display cap is a
property of the request and the total is a property of the document
([`lib/data/runs-parse.ts`](lib/data/runs-parse.ts)); they are now two fields,
and the tile says which case it is in. The cap is 100 today, which is above what
the pipeline has published, so the tile currently reads "all listed below" - the
point is that it will say "latest 100 listed below" rather than silently
re-describing its own page size once the history outgrows it.

A declared `runCount` is trusted only when it is a whole number no smaller than
what the document actually carries, so a stale envelope can never make the page
claim fewer runs than it is listing, and an unreachable history falls back to
describing what it listed rather than to an error. The Data source panel names
the run-history URL that answered and whether it is the published history or the
bundled sample, and the tile is badged when it is the sample.

An alert cites the run id **stamped inside the artifact it read**, not the newest
entry in that history. The two can disagree: the parquet and `run-history.json`
are separate objects behind separate IPNS names, republished at different
moments, and an alert that cited a run which did not produce the values it
quotes would be citing the wrong evidence. The history is the fallback when the
artifact carries no run id at all.

So the matcher follows the snapshot-diff shape:

1. Re-evaluate every active saved search against the current data.
2. Collect the **id of every matching parcel** (up to `MATCH_ID_CAP`), and
   fingerprint the best of them by the ranking order (up to
   `TRACKED_MATCH_CAP`) over the **sixteen fields an acquisitions team would act
   on** (`MATERIAL_FIELDS` in [`lib/criteria/score.ts`](lib/criteria/score.ts)).
   One sweep produces both ([`lib/notify/collect.ts`](lib/notify/collect.ts)).
3. Diff the id set against the id set stored last pass, and the fingerprints
   against the fingerprints stored last pass. Membership and field-level change
   are two questions of two different stores; see "Two caps" below for why.
4. Raise `new_match` for parcels new to the search **at any rank**,
   `updated_match` for parcels whose material fields moved, naming exactly which
   ones.
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
  the pass records how many it suppressed; the two watch caps below are reported
  on the same run record and disclosed on screen before a search is saved.

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
- **A signal the `WHERE` clause already guarantees does not score.** A constant
  cannot order anything, and this was the bug that mattered most: `absenteeOwner`
  and `noHomestead` were both filter predicates _and_ scoring signals, so the
  distress component was exactly 1.0 on every row in the result by construction -
  three ninths of the weight of the flagship thesis contributing nothing to the
  order. Absentee is now graded on `owner_region_class`, which genuinely varies:
  out of state outranks elsewhere in Florida outranks a landlord who mails to the
  next ZIP, because that is a materially better call to make.
- **The guarantee is derived, not remembered.** Writing that rule down as a flag
  beside each signal put the same truth in two places and left them free to
  disagree, which is the shape of the original bug. `buildWhere` now returns a
  set of `WhereGuarantee`s, each one added at the same line that pushes the
  clause it comes from, and `buildScoreComponents` reads that set instead of
  restating the filter. So the grade drops out on its own where it stops
  varying: `absenteeOwner` keeps ranking while owner classes differ, and stops
  scoring the moment `ownerRegionClasses` pins the search to a single class,
  because then the four-step grade is one constant. An exhaustive test walks 64
  filter combinations and fails if any signal is scored while the emitted clause
  guarantees it.
- **Continuous signals ramp, and the ramp never plateaus.** Clearing the
  threshold earns a small qualifying credit; a linear core then runs across the
  criterion's real range as read off the roll - tenure to 45 years, roof age to
  65, both about the p99 and p90 of the matched population - and past that a
  compressive hyperbolic tail approaches 1.0 without ever reaching it. So a
  60-year hold still outranks a 45-year hold, by less than the first ten years
  were worth. When the user sets an upper bound the tail is dropped: everything
  above it was filtered out, so there is nothing left up there to order.
- **Falling ramps** do the same job in the other direction, for every distance
  the criteria can ask about: from the centre of a drawn area, from the water,
  from a transit stop. Each is linear - full marks at nought metres, nothing at
  the limit the user set, clamped outside. Polygons and boxes rank as well as
  circles now; before, only a circle had a centre to measure from, so every
  hand-drawn area tied.
- Genuinely boolean signals stay boolean. Grading a homestead exemption or a
  recorded filing would be inventing precision the roll does not have.
- **Assessed value is measured from the floor of the band, not from its
  middle.** An acquisition budget is a ceiling, so the best parcel is the
  cheapest one that clears the floor, not the one nearest the centre. With a
  floor and a ceiling both set it is the same falling ramp as the distances:
  1.0 at the floor, 0 at the ceiling. With a floor and no ceiling there is
  nothing to run a ramp to, so the component is `floor / assessed_value` -
  hyperbolic decay rather than a ramp, half credit at twice the floor, a third
  at three times, approaching nought without ever reaching it. That keeps the
  order strict all the way up the distribution instead of inventing a ceiling
  the user did not ask for and flattening everything above it.
- With no ranking signals at all, nothing is ranked: every row scores the same
  and the list says so once, above the results, rather than pretending to an
  order. The badge on those rows reads `unranked` rather than a green `100`,
  because a hundred looks like a verdict and there is no verdict to give.

### Tenure the roll cannot support

Tenure is the strongest signal here and the least trustworthy column in the
roll, so it has its own guard ([`lib/criteria/sql.ts`](lib/criteria/sql.ts)).

The two **most common non-null values in the entire sale-date column are not
sales**. 842 parcels are stamped `1899-12-30` (the spreadsheet zero date), 609
are stamped `1899-01-01`, one each sits at `1900-09-13` and `1800-01-01`. Almost
all of them - 1,450 of the 1,458 rows the guard catches - carry
`tenure_basis = 'COJ_SALESL'` with a null `sale_count` and a null
`last_sale_date`; the remaining eight carry `FDOR_SALE`, a sale count of one or
two, and the placeholder date sitting in `last_sale_date` where a real one would
be. The pipeline turns all of them into holds of 125 to 226 years.
Two dates being more common than any genuine sale date is itself the evidence
that they are placeholders and not very old transactions. They are also not
nulls: a parcel the roll genuinely says nothing about already carries a null
tenure, and a null already scores nothing.

1,453 rows out of 404,023 is a rounding error until they are ranked. The tenure
ramp pays for longer holds by design, so they floated to the top of every
distress list: 23 of the top 100 of the tired-landlord thesis, led by
`201 N BROOKVIEW DR` - built in 1986, opening the list at "held 127 years".

Two rules, both read off columns every query already selects, so the guard needs
no new column and behaves identically in the tab and in the scheduled matcher:

- an implied sale year of **1901 or earlier** is the placeholder, not a
  transaction (`NO_RECORDED_SALE`). It catches every placeholder, plus six rows
  whose implied sale year lands on 1901 exactly - four single-family, one
  timberland, one right-of-way. Four of the six being residential is the point
  of ranking them as unknown rather than trusting them: 125 years of unbroken
  ownership is not a thesis anyone is ranking on either way. 1,458 rows in
  total;
- a sale recorded **more than a year before `built_year`** contradicts the
  roll's own record of the building (`PREDATES_STRUCTURE`, 4,225 parcels). That
  one is capped at the age of the structure rather than discarded, so a genuine
  1966 lot with a 2005 house on it still ranks on twenty years rather than
  sixty. The one-year grace absorbs the ordinary case of buying the lot the
  calendar year before completion.

Rule two is deliberately independent of rule one, so a placeholder nobody has
seen yet still gets capped to something plausible instead of leading the list.

Three properties worth checking rather than taking on trust:

- **Nothing is filtered out.** The `WHERE` clause still reads the published
  `years_since_last_sale`, so the match count is identical before and after -
  10,209 on the tired-landlord thesis either way. An unranked parcel is still in
  the result and still says why on screen: "no recorded sale" is a signal an
  acquisitions team wants, it just must not outrank a verified forty-five year
  hold.
- **No stored snapshot was invalidated.** `years_since_last_sale` is one of the
  sixteen fingerprinted material fields, so rewriting it would have made every
  saved search re-baseline and alert on a change that never happened in the
  county. The guard produces two _separate_ values instead, and the old column
  list was re-run through the unchanged hash over 3,000 published parcels with
  zero drift.
- **The guard is visible, not hidden.** `tenure_confidence` and
  `tenure_years_ranked` are selected on every row, so they appear in _Show the
  SQL behind this result_, in the parcel drawer, in the alert and in the
  properties CSV. A reviewer can see why a parcel the roll calls a 127 year hold
  is not ranked as one.

Effect on the flagship thesis: the top 100 went from 23 placeholder rows and 24
rows claiming holds over a century to **zero of each**, and the parcel that had
been opening the list at "held 127 years" fell out of the first several hundred.

Those before-and-after ranks were measured on the artifact published at the
time, and they are not reproducible against today's roll - the parcel that led
the list then is not in the match set now. What is reproducible, and what
actually matters, is the after state: re-run the thesis today and the top 100
still contains zero placeholder rows and zero holds over a century.

### What the rationale says

It quotes the values behind the number, and only the signals that actually
ranked. This is the current top match of the _Tired landlord_ thesis on the
published artifact:

> held 66 years (+31.1); roof about 71 years old, estimated from year built
> (+29.7); absentee owner mailing from out of state (+28.3).

It used to end that middle clause "absentee owner mailing from out of state, no
homestead exemption (+28.3)", which was a false provenance claim: the homestead
flag is guaranteed by the `WHERE` clause and therefore scores nothing, so the
whole 28.3 was the absentee grade and the sentence credited half of it to a
signal worth zero. The generator now names the signals it ranked and the
sentence renders evidence only for those, so the two cannot drift apart.

A parcel whose tenure the roll cannot support says so in the same sentence:
"no recorded sale: the roll carries a placeholder date, so ownership tenure is
unknown and is not ranked", or the capped form naming the build year. It is said
whether or not tenure is one of the criteria, because the parcel is on screen
either way and the number beside it would otherwise read as a fact.

**Expect scores in the eighties, not hundreds.** Every measurement here is on
the published county artifact, not on the bundled sample. Under the old model
the tired-landlord thesis spread its 10,209 matches over 31 distinct scores,
none below 73.3, with 1,140 of them - eleven percent - at exactly 100: a tie for
first place in which "held 47 years with a 79 year old roof" and "held 25 years
with a 30 year old roof" were the same parcel. The same thesis on the same
artifact, re-measured after the tenure guard, now produces **1,951 distinct
scores over those same 10,209 matches, topping out at 89.18 with exactly one
parcel there, and a floor of 18.33**. A top score of 100 on a ranked search
would now be the symptom, not the goal.

The same shape holds on the bundled sample, which is how to check this without
the county artifact: the same thesis over `public/sample/query-table.parquet`
matches 2,293 parcels across **821 distinct scores, topping out at 84.88 with
exactly one parcel there, a floor of 19.35, and none at 100**. Different corpus,
different numbers, same three properties - a wide spread, a single parcel in
first place, and no perfect scores.

### What breaks a tie, and why it mattered more than it looks

With no ranking signals set every row carries the same score, so the tiebreak
decides the entire default list. It used to be `assessed_value ASC`, and the app
opened on fifteen consecutive $1 condo shells at 514 LOMAX ST: the exact failure
the dwelling filter exists to prevent, in the first screenshot anyone takes.

It now breaks on **priced-dwelling class, then distance from downtown
Jacksonville, then `property_id`** (`TIEBREAK_SQL` in
[`lib/criteria/sql.ts`](lib/criteria/sql.ts)).

Priced is measured per square foot rather than as an invented floor, and the
threshold came from the data: of the 68,403 sample dwellings that clear the
existing guard, **zero** are assessed below $1/sqft and the cheapest genuine
house is $1.70/sqft, so a dollar-assessed shell misses by three orders of
magnitude. It orders, it never filters.

Distance from a fixed downtown point comes next because `property_id` alone
turned out to carry an opinion nobody chose. An RE number is assigned in the
order the county platted the land, so ascending order marches west-to-east
through one rural subdivision at a time: the first twenty rows of the default
search were all on N US 301 HWY, the Baldwin corridor, 28-30 km out, past the
95th percentile of the county's own distance distribution. The tiebreak now
states the opinion an acquisitions team would actually hold - when nothing else
separates two parcels, the one in the market they work comes first - and the
same default search opens on N Ocean St, E Ashley St, E Church St and Phelps St.
It is a constant point and not the map viewport, because where you scrolled must
not change what a saved search watches.

`property_id` remains last so an exact distance tie resolves the same way on
every pass: paging and the tracked set both need a total order.

Sorting descending was tried and rejected: it leads with $75M apartment
complexes, which for an acquisitions team is worse than the shells. `Cheapest`
survives as an explicit sort, because that is somebody answering a question
rather than a machine guessing at one.

The second-order effect is the one worth knowing. **The same ORDER BY decides
which matches the scheduler fingerprints**, since the fingerprinted set is the
top `TRACKED_MATCH_CAP` by that order. An unranked saved search was therefore
diffing the two thousand cheapest rows in Duval rather than a sample of what it
matched. It no longer decides what the scheduler _watches_ - the next section is
about why - but it still decides which matches an alert can describe field by
field.

### Two caps, because membership and change detection cost differently

A thesis can match six figures of parcels. On the deployed runtime, read off
`GET /api/searches` on 2026-08-22, the three seeded saved searches matched
**10,209, 67,398 and 151,855** of the 404,023-parcel roll, and every one of them
had `matchIds.truncated: false` - the whole match set watched, not a slice of
it.

Those three counts move, and it is worth saying exactly how, because the same
thesis reports slightly different totals depending on what you ask. Querying the
published artifact directly the same day gives 10,209, 67,400 and 151,856; the
store reports 67,398 and 151,855 because a saved search's count is what the last
matcher pass saw, and that pass read the roll **through the simulation
overlay**, which is the whole point of the overlay. The county also republishes
every six hours. So a constant in `lib/notify/limits.ts` naming 67,399 is not
wrong, it is a different day. The roll total and the two caps are the numbers
that do not move.

There used to be one cap over all of that, and one cap was the whole defect.
"Which parcels does this search match" and "what did each of those parcels look
like last pass" are different questions with different storage costs - an id is
eleven characters, a fingerprint plus its sixteen-field snapshot is roughly a
kilobyte - so they are capped separately, in
[`lib/notify/limits.ts`](lib/notify/limits.ts):

| Cap                 | What it bounds                                                                                                | Value   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| `MATCH_ID_CAP`      | **Membership.** The ids of every parcel the search matched, stored on the search document, grouped by prefix. | 200,000 |
| `TRACKED_MATCH_CAP` | **Field-level history.** The fingerprint and material snapshot of the best matches, by the ranking order.     | 2,000   |

What each one does and does not buy:

- **`new_match` is answered from the whole match set.** A parcel that newly
  matches at rank 5,000, or at rank 140,000, raises an alert. The pass sweeps
  ids in ordered pages of `MATCH_ID_PAGE_SIZE` (5,000, the ceiling the data
  source imposes on any one query) - 31 pages for the aging-roof thesis - and
  diffs that id set against the one stored last pass. "Left the set" is the same
  set difference over the same set.
- **`updated_match` is still answered from the top 2,000.** Naming _which_
  fields moved needs last pass's values of them, and that is the
  kilobyte-a-parcel side of the trade. **A change to a field of an
  already-matching parcel ranked below 2,000 raises nothing**, and that is the
  limitation that survives.
- **A new match below 2,000 still gets a usable alert.** An id cannot state an
  address, an owner, a score or a rationale, so the sweep keeps the full rows it
  has already materialised for up to `NEW_MATCH_DETAIL_CAP` (500) parcels below
  the fingerprint cap that the store has not seen matching before. 500 is
  `alertLimitPerRun`'s own maximum, so that bound can never be what stops an
  alert the search was willing to raise. A new match detected beyond it is
  counted on the run record as `newMatchesWithoutDetail` rather than dropped
  quietly.
- **200,000 is headroom, not a live constraint.** It clears the largest thesis
  observed here by a third and stops short of a criteria set that selects the
  whole roll, which is a browse and not a watch. Past it the stored set is
  marked `truncated` and absence from it stops meaning "was not matching", which
  the run record and the UI both carry. Nothing on the deployment is truncated
  today, and `GET /api/searches/<id>` shows it.

The single cap was worse than a blind spot, and that is worth keeping on the
record. `previous` held the stored top 2,000, so a parcel that sat at rank 2,001
and moved to 1,999 had no entry to compare against and was delivered as "now
matches your saved search" for a parcel that had been matching for months. Every
boundary crossing was a false alert. And a parcel below the cap was permanently
invisible rather than merely late: the ranking is deterministic and tenure and
roof age rise monotonically, so rank 5,000 does not climb three thousand places
on the next refresh.

**Storing a six-figure id set on a document committed to a git branch** is the
part that had to be made cheap, and it is measured rather than asserted
([`lib/notify/match-ids.ts`](lib/notify/match-ids.ts), pinned by
`test/match-id-set.test.ts`). Ids are grouped by a four-character id prefix with
the prefix stored once per group, which answers both of the costs a git-backed
document has: how many bytes it is, and how many lines change when one parcel
enters or leaves. Because a parcel's group is a function of its id alone rather
than of its position in a sorted list, one id arriving rewrites one line instead
of shifting every line after it - which a sorted array, the obvious
representation, gets exactly wrong.

Two measurements, at two scales, so neither is mistaken for the other:

| Measured on                                 | Ids     | Grouped  | Bytes an id | Flat sorted array |
| ------------------------------------------- | ------- | -------- | ----------- | ----------------- |
| the bundled sample, whole roll (test suite) | 75,988  | 599 KB   | 8.07        | 1,410 KB          |
| the deployed runtime, aging-roof thesis     | 151,855 | 1,212 KB | 8.18        | -                 |

The second row is not an extrapolation of the first: it is
`GET /api/searches/<id>` on the live deployment, and it gzips to 248 KB on the
wire across 1,777 lines. Roughly twice the sample at roughly the same cost an
id, which is what the representation was chosen to give.

Both caps are disclosed where the numbers are read rather than only in the code:
under the match count before you press save, and beside `Matched last pass` on
every saved search, which states how many parcels are watched for new matches
and how many of those are fingerprinted for changes.

Every pass also **records** both, per search, on its evidence document -
`knownMatches` with `knownMatchesTruncated`, `trackedMatches` with
`matchesTruncated`, and `newMatchesWithoutDetail` beside them - so a cap that
actually bit is answerable after the fact rather than only before it. That is
stored in `detail.outcomes` on the `matcher-runs` document rather than rendered:
the pass table on `/pipeline` shows searches evaluated, parcels evaluated,
alerts raised, alerts suppressed and notifications sent, and the per-search
watch figures are in the record underneath it. Recorded and readable, not on
screen - said plainly here so nobody goes looking for a column that is not
there.

---

## The agent answers on this deployment's key, from a loop in your tab

Two facts that pull in opposite directions. The agent's tools query the parcel
data, and that data is read by DuckDB-WASM **in the visitor's tab**, so the tool
loop has to run there. The model key belongs on the **server**, because a key
shipped to a browser is a key given away.

So only the model call crosses over. The loop runs in the tab and points the AI
SDK at `/api/llm/<provider>`
([route](app/api/llm/[provider]/[...path]/route.ts)), which forwards the request
upstream with the key attached and streams the answer back. Same SDK, same wire
protocol, one hop. The key never reaches the browser and the tools never leave
it.

The Ask page therefore opens with a dropdown of the models this deployment can
answer with, not a request to go and configure something. The list is published
by `GET /api/agent` from the registry, so the server cannot offer a model it
would refuse to run.

**What bounds the proxy**, because a route that spends someone's key on behalf
of anonymous callers deserves stating plainly:

- the provider must be one this build knows **and** have a key configured here,
  so the path cannot be used to reach arbitrary hosts;
- the model must be one the registry lists for that provider, or a hand-written
  request could point the key at the most expensive model the vendor sells;
- every caller is rate limited by address, per process.

The residual risk is real and not engineered away: a public runtime answering on
the owner's key can have that key spent by strangers, and a per-process counter
raises the effort rather than removing it. The deployment owner decides whether
to configure a key at all. With none configured the route 404s, the dropdown is
empty, and the Ask page says so - while the map, search, saved criteria, alerts
and the acquisition board carry on working, because nothing else here needs a
model.

**There is deliberately no bring-your-own-key page.** An earlier version had one
and it was the wrong shape for this: asking the person evaluating a CRM to go
and mint an API key before it will answer a question is a failure at the
question. The deployment answers, or it says it cannot.

Amazon Bedrock is the one provider in the registry that cannot be forwarded: it
signs the whole request with SigV4 rather than carrying a header token, so it is
listed but never offered.

---

## What the data can and cannot answer

Stated here rather than discovered by a reviewer.

- **Roof age is usually a proxy.** `roof_age_basis` containing `PROXY` means the
  county publishes no roof date and the year built stands in, which over-counts
  re-roofed houses. The filter panel has a "only roofs with real evidence"
  toggle; the list marks proxied roofs with an asterisk; the agent is required
  to say so.
- **Ownership tenure needs the published artifact, and not every published
  value is a sale.** A locally built roll carries only the current roll period's
  sales, so `years_since_last_sale` is null on most parcels and "no ownership
  change in 10+ years" returns nothing. The published table is built where the
  county's own sales history is reachable: tenure is published on **401,832 of
  404,023** parcels and 153,240 of those read ten years or more. Of the
  published values, **1,458 imply a sale in 1901 or earlier rather than a real
  transaction** and 4,225 record a sale predating the structure, so on a
  recorded sale the
  ten-year-plus population is **148,722**. Those rows are still returned and
  still filtered on the published column; they are excluded from the ranking and
  labelled wherever they appear. See _Tenure the roll cannot support_ above.
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
RUN_HISTORY_URL=https://ipfs.filebase.io/ipns/k51qzi5uqu5dl3zmapadjh90auy4k6gtr6w52zg6ozeu64kzbiwwgw8k9ef6ny \
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
pnpm seed            # a team, three theses, up to nine worked deals
```

`--reset` is **not** needed on a fresh store, and it is not the default. The
branch (`crm-state`) and directory (`crm`) are created on the first write. Set
`DATABASE_URL` instead for the Postgres backend; the table is created on first
use and there is no migration step. "Nine worked deals" is an upper bound: the
seed takes what the ranked pools can actually supply and reports what it wrote.

**`--reset` destroys CRM state**, so it is worth reading before it is run
against a store somebody is using. It clears all eight collections before it
writes: the team, saved searches, alerts, matcher passes, owners, opportunities
(and the notes, tasks and outreach threads stored inside them), court records
and the simulation overlay. On the git backend that is **one delete commit per
document, sequentially** - the contents API serialises commits to a branch
anyway - so a reset over a worked board is dozens of commits and dozens of API
calls against the hourly budget, not one. Every one of them is recoverable from
the branch history; on Postgres none of it is.

Without it the seed **refuses to run on top of a board that already holds
opportunities or alerts** and exits 3. Those two are what the check looks at,
because they are what carries a score and a rationale; a store holding only a
team or a saved search is seeded onto without complaint. The refusal is not
caution for its own sake: seeding over an existing board leaves two generations
of CRM state side by side, the older rows keeping the scores and rationales of
the model that produced them, both looking equally current. That is how a stale
fixture survives a scoring fix. `--keep-existing` says otherwise deliberately,
in one word, and `--memory` runs the whole thing against an in-process store and
writes nowhere, which is the way to see the shape without a token.

The fixture is generated, not written down: scores and rationales come from the
real scoring engine over the configured artifact rather than from literals, and
up to three of the opportunities carry genuine `alert_id` and `matcher_run_id`
values because the seed applies real simulated pipeline updates and runs an
ordinary matcher pass over them, rather than writing an `alertId` in. It is up
to three rather than exactly three because the candidates have to come from a
thesis with no assessed-value ceiling - a reassessment that pushes a parcel out
of the band its own saved search filters on drops it from the match set, and a
parcel that has left a search cannot raise an updated-match alert for it. The
seed prints how many it actually produced, with the ids, so the number in the
run log is the number on the board.

**Order matters between the two scripts.** `pnpm verify` clears the simulation
at both ends of its run, so that it says the same thing every time rather than
only the first time. That means it must run **before** a seed and not after: run
it second and it strips the overlay rows the seeded board's alerts rest on.

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

**On the runner the artifact is fetched whole - about 50 MB - and queried from
disk, not range read** (`PROPERTY_FETCH_WHOLE`, which defaults on whenever
`CI=true`). Range reading turns each query into hundreds of small requests, and
a public gateway rate limits and then times out under that: a scheduled pass
once answered "Timeout was reached" for every saved search after thirteen
minutes of it. A process that outlives a single query should pay for one large
transfer instead, which is the opposite of the right trade in a tab and the
right one here.

To run one by hand:

```bash
pnpm matcher
```

### Proving the deployed runtime

```bash
npx tsx scripts/smoke.mts https://residential-jax-crm.vercel.app
```

Opens a real browser against the live URL and drives it the way a reviewer
would: the artifact attaches over the gateway, a criteria search returns scored
matches, the rationale cites real values, the SQL is disclosed, the parcel drawer
carries a clickable source URL and a pipeline run id, the board has worked deals
across several stages, and an alert converts into an opportunity **through the
real HTTP route**. It writes `smoke-search.png`.

Every assertion in it is held to one rule: it has to fail in the state it exists
to rule out. Three of them were rewritten because they did not:

- the parcel count asserted `>= 50_000`, which the bundled 75,988 parcel sample
  passes - so the line whose entire purpose was proving this deployment is on the
  404,023 parcel county artifact could not tell the two apart. It now asserts
  county scale, that the badge is not the SAMPLE badge, and that the parquet
  bytes were fetched from an IPFS gateway and not from this deployment's own
  `/sample/` path;
- the funnel check counted page text matching each stage name, which the stage
  filter's own dropdown supplies on a completely empty board;
- the store check only looked for the absence of a warning badge, which a header
  that failed to render also satisfies.

And the conversion step is there because of a specific failure. `pnpm seed`
writes to the store directly and never calls an HTTP route, so it stayed green
while the POST the app itself uses rejected every request: four id fields
asserted `z.string().uuid()` and nothing in this system has ever minted a UUID.
The first step of the demo script returned 400 on the deployed runtime and no
script noticed, because no script was driving a route.

### Everything else

`.env.example` documents every variable and why it exists. No secret is in the
repository.

---

## Test plan, which is also the demo script

Each step states what to look for. All of it runs against the deployed URL.

1. **Open `/`.** The header states the dataset and its size. If it says a parcel
   count without SAMPLE, the full published county table is loaded.
2. **Open `/search`.** Pick the _Tired landlord_ thesis. Watch the count settle
   as the criteria apply - it is debounced, not a button. **Every number in this
   step is county scale**, measured on the full published artifact the deployed
   URL reads. The step behaves identically on the bundled five-ZIP sample and
   counts much smaller there, so do not expect these figures from `pnpm dev`.
   It settles a little over ten thousand: 10,209 on the artifact published as
   this was written, and the exact figure moves with the county's six-hourly
   republish, which is the whole premise of the app. Expand _Show the SQL behind
   this result_: the statement that produced the count is on screen. Now turn
   off _Has a dwelling_. Two things happen, and both are the point. The count
   rises by a few hundred - on the county artifact, 468 parcels the appraisal
   roll declines to price as somewhere to live: 430 of them assessed at a dollar
   or less, 196 with no floor area at all, and a median livable area of 55 sq ft
   among those that have any. And the top of the list does not move. The guard
   is what keeps those out of the result; the tiebreak is what keeps them off
   the first screen anyway, for the land buyer who turns the guard off on
   purpose.

   Two things to read on this screen before moving on. **The scores are not
   hundreds**: the top match is in the high eighties, one parcel is there, and
   the rationale under it quotes the values that earned it - a hold, a roof age
   and how far away the owner mails - and names no signal that scored nothing.
   **No row claims a hold of a century.** The published roll stamps 1,453
   parcels with a placeholder sale date that reads as 125 to 226 years; they are
   still in the result, ranked as unknown tenure and labelled "no recorded
   sale". _Show the SQL behind this result_ carries `tenure_confidence` and
   `tenure_years_ranked` so the guard is auditable rather than asserted.

   Now clear the thesis back to no criteria. Every badge reads **`unranked`**,
   not a green 100, and one line above the list says why. Nothing here can tell
   these parcels apart, and a hundred would have claimed the opposite.

3. **Draw an area.** `Radius`, click a centre, click again for the radius. The
   count drops to what is inside it. `Polygon` works the same way; double click
   closes it.
4. **Press `Search this view`,** then pan and zoom. Every move re-runs the query
   against what is on screen and the header says "in this view". It is a display
   filter and not part of the criteria: saving the search does not capture where
   the map happened to be pointing, because the scheduled matcher would then
   alert forever on that rectangle.
5. **Open a parcel.** Confirm the grouped published columns, and the Provenance
   block with a clickable source URL, the collection timestamp and the pipeline
   run id. Where the roll's tenure is a placeholder or predates the structure,
   the drawer says so in words beside the number rather than presenting it as a
   fact. The owner block shows the mocked skip-traced contact when one exists.
6. **Save the search.** Before pressing save, read the line under the match
   count. Whenever a criteria set matches more than 2,000 parcels it states
   **both** watch promises in the two units they are actually in: _"Saving these
   criteria watches all 10,209 for new matches, and the top 2,000 by score for
   changes to a parcel already matching."_ Those are different promises, and the
   sentence refuses to quote one number and let it stand for both. Past 200,000
   it changes to name the membership cap and the total it did not cover; no
   thesis on this deployment reaches that, which is the point of the headroom.
   The dialog also states that the first pass records a baseline without
   alerting. Enable in-app and mocked email.
7. **Go to `/searches`.** The saved search shows when it was last evaluated,
   against which pipeline run, how many matched, and the same two caps beside
   `Matched last pass`. To check the claim rather than read it, open
   `/api/searches/<id>` on this deployment: `matchIds.count` is the membership
   set actually stored and `matchIds.truncated` says whether it is all of them,
   beside `matches` - the fingerprinted map - which stops at 2,000. On the
   seeded theses the first is five figures and false, and the second is exactly
   2,000, which is the whole of this design in two fields.
8. **Press `Simulate: new court filings`.** This writes real court records
   against parcels that fit everything else, then runs the ordinary matcher. The
   result line names the synthetic run id and how many alerts it raised.
9. **Go to `/alerts`.** Each alert shows the search that raised it, the pipeline
   run id that triggered it, the fields that changed, the score rationale, and -
   under `Detail` - the mocked email body that would have gone out.
10. **Convert one to an opportunity.** It lands at Identified with the owner
    attached and the match rationale preserved. The owner panel on the deal
    renders the mocked skip-traced contact - it used to read "not on file" on
    the one screen a converted alert actually lands on, while the API had the
    contact all along.
11. **Open `/opportunities`.** Board and table views, and five named filters:
    stage, match strength, area, city or ZIP, and ownership signal. Set **Area**
    to Arlington - that is the one control a city column cannot answer, because
    Arlington is three ZIPs and every one of them says JACKSONVILLE on the roll.
    Select rows in the table and launch a mocked campaign.
12. **Open an opportunity.** Advance the stage and watch the stage history
    record it. Add a note and a task. In the outreach thread, scheduled provider
    events are dimmed until their time arrives; `Fast forward lifecycle` pulls
    them to now, and the status walks sent → delivered → opened → replied or
    bounced.
13. **Export.** `Export CSV` for the opportunity set, `Mailing list` for owners
    with a mailing address. Open either in a text editor: the opportunity set
    carries `source_system`, `source_url`, `fetched_at`, `pipeline_run_id`,
    `alert_id` and `matcher_run_id`; the mailing list carries `source_system`
    and `pipeline_run_id`. A row whose provenance is genuinely unknown has empty
    cells rather than an invented value. Provenance travelling with the data is
    the argument this whole application makes, and a CSV that leaves the
    building without it is where that argument would break. The property CSV on
    `/search` makes the same argument about data quality: it exports
    `years_since_last_sale` unaltered and carries `tenure_confidence` and
    `tenure_caveat` beside it, so a placeholder tenure cannot travel downstream
    with nothing attached to say so. It re-runs the search rather than exporting
    the rows on screen, and it stops at **5,000 rows** - the ceiling the data
    source puts on any one query. Take it from a thesis that matches more than
    that and the last line of the file says so, naming how many matched and how
    many were written; the button says the same before it is pressed. A silently
    truncated export reads as a complete one at the other end, which is the one
    thing an export of a five-figure match set must not do.
14. **Open `/pipeline`.** Upstream pipeline runs with their real per-source
    counts and declared limitations, next to every matcher pass including the
    ones that raised nothing. **Pipeline runs published** is the published
    document's own `runCount`, not the number of rows listed below it; open the
    run-history URL in the Data source panel and the two agree. That panel also
    names which artifact and which run history answered, and badges either one
    when it is the bundled sample rather than the published document. Press
    `Run matcher now`; a new pass appears. `Clear simulation` removes the
    simulated rows. The passes marked `cron` were run by GitHub Actions on a
    runner nobody was watching, which is the point of the whole exercise.
15. **Open `/agent`.** Pick a model from the dropdown. This deployment answers
    on its own key, so there is nothing to configure and no key to supply. Use
    the first suggested question, which is the assignment's own: _"Which
    residential properties in the Arlington area match a distressed profile -
    roofs older than 15 years, no ownership change in 10 or more years - and
    have not been contacted yet?"_ Check the `Tools` and `Rows` tabs under the
    answer, and the caveats block. Arlington resolves to ZIPs 32211, 32277 and
    32225, because every one of them says JACKSONVILLE on the roll and the agent
    is handed that mapping in `get_schema` rather than left to guess it.
16. **Scroll to the bottom of `/opportunities`.** Disposition, portfolio tracking
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

`audino`, the kit's frontend bug-fix specialist, was used for several UI defect
passes. Nothing else in the kit was.

Both borrowed patterns are traced to the files and constructs that implement them
in [`KIT-USAGE.md`](KIT-USAGE.md), along with what was adapted off AWS and why
and the tests that pin each one. The citations there are anchors rather than
line numbers, and that file carries a runnable checker that resolves every one
of them against the current tree. That file is the artifact to inspect; this
section is the summary.

## Shared code

`lib/oracle/` is **vendored** from the Duval pipeline repository at commit
`28088d0`, not written here: the published column contract, the read-only SQL
guard, the per-column meanings, the DuckDB-WASM engine and its OPFS cache, and
the provider registry with its dated free-tier terms. Two of those files are
**deliberately diverged** rather than straight copies, each saying so at the top
of itself: the cache is keyed on the content address rather than the gateway
URL, and the engine gained two additive exports so the cache is filled after a
successful range attach and can be attached back with no network. Everything
else in the directory is a copy. See
[`lib/oracle/VENDORED.md`](lib/oracle/VENDORED.md) for why it is a copy rather
than a package - each assignment is graded as an independently clonable
repository - and `scripts/sync-shared.mjs` to check the two copies for drift.

It is the subset this application actually imports, not a mirror of the origin
directory, and it is kept that way rather than left to accumulate. Three things
are not carried. The pipeline's server-side model resolver, its
credential-header reader and its Bedrock prompt-cache wrapper went with the
bring-your-own-key page: this deployment answers on its own key through one
proxy route, so those modules had no caller left. `geo.ts` went the same way -
it is slippy-tile arithmetic and a haversine for the pipeline UI's library-free
tile thumbnail, where this application draws with MapLibre and computes distance
in SQL, so nothing here imported a line of it. The drift check enumerates what
is present in this directory rather than a fixed list, so a smaller vendored set
narrows what it compares rather than breaking it.

Within a file that is carried, nothing is trimmed. `format.ts` is here because
`duckdb.ts` needs `toPlain` to flatten an Arrow value; its other formatters have
no caller in this repository and are kept anyway, because deleting them would
turn every future drift report into a false positive.
