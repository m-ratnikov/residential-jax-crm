# Architecture

A CRM with no database. It watches a county property dataset it does not own, on a schedule it does
not control, and remembers what a team decided about a parcel as JSON documents on a git branch.
Every 30 minutes something asks "did anything just start matching," and every time the answer is no,
that is written down too.

| | |
|---|---|
| Parcels consumed | 404,023, read-only, never copied into this application's own store |
| Data source | Published Duval Oracle query table, parquet on IPFS/Filebase, 133 columns |
| Query engines | DuckDB-WASM (browser), native DuckDB or WASM-node (scheduled matcher, agent) |
| Continuous half | GitHub Actions, every 30 minutes, diffs against the last stored snapshot |
| CRM store | JSON documents, default: a git branch. Swappable to Postgres or in-process |
| Membership cap / fingerprint cap | 200,000 ids per search / 2,000 fully diffed fields |
| Outreach | Simulated: 3 channels, 8 statuses, addressed to reserved `.invalid` / 555 destinations |
| Runtime cost when idle | none: no server, no database, no standing compute |

Diagrams follow the **C4 model** (context, then containers), drawn as Mermaid flowcharts rather than
`C4Context` blocks for the same reason the sibling pipeline repository gives: reliable layout on
GitHub. Node shape carries the C4 role: rounded is a person, a plain box is something built here, a
cylinder is a data store, and a double-edged box is a system outside this application's control.

---

## 1. Context - C4 Level 1

```mermaid
flowchart LR
    analyst(["Acquisitions analyst<br/><i>any browser, no login</i>"])

    core["Residential Acquisition CRM<br/>criteria -> match -> alert -> deal<br/><i>Jacksonville / Duval County</i>"]

    pipeline[["Duval Oracle Pipeline<br/><i>separate repository, separate PR</i>"]]
    ipfs[["Filebase / IPFS<br/><i>gateway, range reads</i>"]]
    gh[["GitHub<br/><i>crm-state branch, Actions cron</i>"]]
    llm[["Model provider<br/><i>OpenAI by default, 8 more selectable</i>"]]

    analyst -->|defines criteria, works deals| core
    core -->|reads the published parquet, never writes to it| pipeline
    core -->|range reads / whole-object fallback| ipfs
    core -->|reads and writes CRM documents,<br/>runs the scheduled matcher| gh
    core -->|tool loop, only when asked| llm
```

One person, four outside dependencies, and three of them cost nothing per use. Only the model
provider is metered, and only when the agent is actually asked something.

---

## 2. Containers - C4 Level 2

The pipeline is somebody else's writer. This application never writes to the parquet, and the
parquet's owner never writes to this application's store.

```mermaid
flowchart LR
    pq[("Published query table<br/>parquet on IPFS<br/><i>404,023 parcels, read only</i>")]

    subgraph browser ["Visitor's tab - on demand, no credential"]
        direction TB
        wasm["DuckDB-WASM<br/><i>criteria, scoring, the map</i>"]
        agentui["Agent UI<br/><i>tool loop runs here too</i>"]
    end

    subgraph scheduled ["Scheduled - GitHub Actions, every 30 min"]
        direction TB
        matcher["Matcher runner<br/>native DuckDB<br/><i>evaluate every active search</i>"]
    end

    subgraph api ["API routes - Vercel serverless"]
        direction TB
        crmapi["CRM routes<br/>searches · opportunities · alerts · outreach"]
        agentroute["Agent route<br/>forwards the model call only"]
    end

    store[("CRM store<br/>git documents (default)<br/>Postgres or in-process (opt-in)")]
    llm[["Model provider"]]

    pq -->|range reads| wasm
    pq -->|native range reads| matcher
    wasm -->|POST evaluated matches| crmapi
    matcher -->|same evaluateAndAlert as the browser| store
    crmapi <--> store
    agentui -->|tool loop, rows stay client-side| agentroute
    agentroute -->|model call only, key never leaves the server| llm
```

| Container | Built with | Responsibility |
|---|---|---|
| Browser (map, search, criteria) | Next.js, DuckDB-WASM | Runs SQL in the visitor's own tab against the published parquet; posts what it found to the CRM routes |
| Scheduled matcher | GitHub Actions, native DuckDB | Wakes every 30 minutes, evaluates every active saved search against the current artifact, diffs, alerts |
| CRM API routes | Next.js route handlers, Vercel serverless | Saved searches, opportunities, alerts, outreach, simulation - all through one `CrmStore` interface |
| CRM store | GitHub Contents API (default), Neon Postgres, or in-process | Saved criteria, match history, alerts, deals, notes, tasks, outreach, overlay - never the parcels |
| Agent route | Vercel AI SDK, `/api/llm/<provider>` proxy | Forwards a model call on the deployment's own key; the tool loop and the data it reads never leave the tab |

---

## 3. One matcher pass, stage by stage

Two callers run the identical decision logic: the browser posts what DuckDB-WASM found, and the
scheduled runner does the same with native DuckDB. Neither owns a second implementation of what
counts as new, changed, or worth suppressing - both hand their result to `evaluateAndAlert`.

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub Actions (cron */30)
    participant M as runMatcher
    participant PQ as Published parquet
    participant E as evaluateAndAlert
    participant Store as CRM store

    GH->>M: wake, native DuckDB
    M->>Store: load every active saved search
    loop each active search
        M->>PQ: page through matches, ordered by score
        PQ-->>M: ids (up to 200,000), fingerprinted rows (best 2,000)
        M->>E: SearchEvaluation (matched, rows, matchIds)
        E->>Store: read the search's last snapshot + id set
        alt search never evaluated before
            E->>Store: seed the baseline
            Note over E: no alert. A brand new search does not shout.
        else has a stored baseline
            E->>E: diff ids -> newly matching / left the set
            E->>E: diff fingerprints -> which material fields moved
            E->>E: same artifact, different fingerprint? suppress, log unstable read
            E->>Store: write an alert per surviving change,<br/>keyed on (data generation, search, parcel)
            Note over E,Store: a retry recomputes the same key,<br/>finds the document, delivers nothing
        end
        E->>Store: replace the search's snapshot + id set
    end
    E->>Store: write matcher-runs record, whether or not anything fired
```

That last write matters as much as any alert: a pass that finds nothing writes down that it looked,
which is what lets "nothing arrived since the last check" be an answer instead of a silence.

---

## 4. The core mechanism - two caps, because membership and change cost differently

This is the part a database schema would not need and a git-committed JSON document does: an id is
eleven bytes, a fingerprint plus a sixteen-field snapshot is about a kilobyte, so "is this parcel in
the set" and "what does this parcel look like" are capped separately rather than sharing one number.

```mermaid
flowchart TD
    rows[/"page through the criteria,<br/>ordered by score"/]
    ids["every matching id<br/>up to MATCH_ID_CAP = 200,000"]
    fp["fingerprint + 16-field snapshot<br/>best TRACKED_MATCH_CAP = 2,000"]
    detail["full detail for up to 500 more,<br/>only for ids the search has not seen before"]

    known[("stored id set<br/>from the last pass")]
    prev[("stored snapshots<br/>from the last pass")]

    memdiff{"in ids but<br/>not in known?"}
    fielddiff{"in both, does<br/>the fingerprint differ?"}
    samegen{"same artifact<br/>generation as last time?"}

    newmatch["new_match alert"]
    suppress["suppressed: a reader<br/>disagreeing with itself,<br/>not the world changing"]
    changedfields["updated_match alert,<br/>names the fields that moved"]
    nothing["no alert: fingerprint moved,<br/>but on no material field"]

    rows --> ids --> memdiff
    rows --> fp --> fielddiff
    rows --> detail

    known --> memdiff
    memdiff -- yes --> newmatch
    memdiff -- no --> fielddiff
    prev --> fielddiff
    fielddiff -- differs --> samegen
    fielddiff -- same --> nothing
    samegen -- yes --> suppress
    samegen -- no, real change --> changedfields
```

The `samegen` guard exists because it fired for real: a gateway resolved one IPNS name to two
different pinned generations of the artifact, and four consecutive passes alerted on the same 23
parcels as a field flickered between a value and null with nothing having actually changed on the
roll. Comparing two reads of the *same* published generation and believing the difference is the
exact failure this guard closes; comparing across generations is the feature.

---

## 5. Data flow - criteria to a worked deal

```mermaid
flowchart LR
    crit["Saved criteria<br/><i>roof age, tenure, distress signals,<br/>geography, court flags</i>"]
    search[("SavedSearchDoc<br/>matches{} + matchIds{}")]
    matcherpass["matcher pass<br/><i>browser or scheduled</i>"]
    alert[("AlertDoc<br/>one per pass per parcel")]
    opp[("OpportunityDoc<br/>one per parcel, ever")]
    outreach["Outreach message<br/><i>simulated lifecycle</i>"]
    stage["Stage<br/><i>identified -> ... -> closed/dead</i>"]

    crit --> search
    matcherpass -->|diff against| search
    matcherpass -->|writes| alert
    alert -->|"Convert to opportunity<br/>(a human action)"| opp
    opp -->|"Launch campaign<br/>(a human action)"| outreach
    opp -->|"Advance stage<br/>(a separate human action)"| stage
```

Two edges into `opp` and one into `stage` are deliberately **not automatic**. Converting an alert to
an opportunity, launching outreach, and moving the stage are three distinct decisions an analyst
makes - sending a campaign does not itself advance the stage, because the outcome of the campaign is
exactly what should decide that, not the act of sending it.

---

## 6. The CRM store - one document per aggregate, no join to get wrong

```mermaid
flowchart TD
    subgraph store ["CrmStore interface - one of three backends"]
        direction TB
        gh[("GitHub documents (default)<br/>JSON committed to crm-state branch")]
        pg[("Postgres (opt-in)<br/>one table, created on first use")]
        mem[("In-process (fallback)<br/>works immediately, gone on restart")]
    end

    searches["searches/&lt;id&gt;<br/>criteria + matches{} + matchIds{}"]
    alerts["alerts/&lt;run&gt;__&lt;search&gt;__&lt;parcel&gt;<br/>one per pass, retry-safe by construction"]
    opps["opportunities/&lt;propertyId&gt;<br/>whole aggregate: stage history,<br/>notes, tasks, outreach thread"]
    owners["owners/&lt;id&gt;<br/>real mailing address + mocked skip-trace"]
    court["court/&lt;propertyId&gt;<br/>distress-signal overlay"]
    sim["simulated/&lt;propertyId&gt;<br/>demo-only roll overrides"]
    runs["matcher-runs/&lt;id&gt;<br/>evidence record, written every pass"]

    store --> searches
    store --> alerts
    store --> opps
    store --> owners
    store --> court
    store --> sim
    store --> runs
```

The document id carries an invariant a relational schema would spend a unique index on:
`opportunities/<propertyId>` makes "one live deal per parcel" structural rather than enforced;
`alerts/<run>__<search>__<parcel>` makes a retried matcher pass a no-op rather than a duplicate
notification, because it recomputes the same key and finds the document already there.

The default backend writes through the GitHub Contents API rather than a database: an unchanged
document is never re-written (so a steady-state 30-minute pass that finds nothing produces no commit
at all), a conflicting write re-reads and re-applies the mutation rather than clobbering it, and reads
revalidate against the branch (a conditional request GitHub answers `304` for free) so a write on one
serverless instance is visible to a read on another within one round trip.

---

## 7. Read path A - the browser (map, search, criteria)

```mermaid
sequenceDiagram
    autonumber
    participant U as Visitor
    participant App as Next.js page (static)
    participant W as DuckDB-WASM
    participant GW as IPFS gateway
    participant API as CRM API routes

    U->>App: open /search
    App->>W: boot wasm in a Worker, CREATE VIEW properties
    W->>GW: probe, then range read the row groups needed
    GW-->>W: bytes (a few hundred KB against a 50 MB file)
    U->>App: adjust criteria (roof age, tenure, distress)
    App->>W: rule SQL, disclosed on screen, plus a separate COUNT
    W-->>App: ranked rows + total matched
    U->>App: Save search
    App->>API: POST /api/searches
    API-->>App: baseline recorded, no alert on the first pass
```

No server is in the query path. The count shown is a separate statement built from the same predicate
as the row query, so the headline number can never disagree with the rows beneath it - the same
discipline the sibling pipeline repository applies to its own six questions.

---

## 8. Read path B - the scheduled matcher

```mermaid
sequenceDiagram
    autonumber
    participant Actions as GitHub Actions (cron */30)
    participant DuckDB as native DuckDB
    participant GW as IPFS gateway
    participant Store as CRM store (crm-state branch)

    Actions->>Actions: checkout, install, verify CRM_STORE_* / PROPERTY_DATA_URL present
    Actions->>DuckDB: PROPERTY_ENGINE=native, PROPERTY_FETCH_WHOLE=1
    DuckDB->>GW: fetch the whole ~50 MB artifact once
    Note over DuckDB,GW: range reading per query rate-limits the gateway<br/>under hundreds of small requests - one download does not
    Actions->>Store: evaluate every active search, diff, alert
    Store-->>Actions: matcher-runs record, written whether or not anything fired
```

The scheduled pass exists because nothing else in this application is awake between requests: parcel
queries run in the visitor's browser and the API is stateless serverless functions. Vercel's Hobby
plan allows one platform-cron invocation a day, which is not a notification service, so the schedule
lives in GitHub Actions instead, where minutes are free on a public repository.

---

## 9. Read path C - the agent

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (DuckDB-WASM already attached)
    participant R as /api/llm/[provider]
    participant M as Model provider

    B->>B: tool loop runs here - 8 read-only tools<br/>(get_schema, search_properties, run_sql,<br/>get_property, list_saved_searches,<br/>list_opportunities, list_alerts, get_pipeline_status)
    B->>R: forward only the MODEL CALL, rate limited per address
    R->>M: question + tool definitions
    M-->>R: tool call requested
    R-->>B: (nothing to run server-side - the loop already ran the tool)
    B-->>B: answer, evidence rows, full tool transcript shown
```

The key never reaches the tab and the data never reaches the server: `/api/llm/<provider>` is a thin
proxy that attaches this deployment's key to a model call and nothing else, so a public, login-free
`/agent` page costs its operator per question rather than per key handed out. Naming a provider with
no key configured is a build-time misconfiguration, not a silent fallback - see the vendored
`lib/oracle/agent/providers.ts` finding recorded in the PR body for the one place this discipline
slipped in the sibling repository.

---

## 10. The outreach lifecycle - simulated, not special-cased

```mermaid
flowchart LR
    queued(("queued")) --> sent(("sent")) --> delivered(("delivered"))
    delivered --> opened(("opened"))
    opened --> replied{{"replied<br/>(terminal)"}}
    delivered --> bounced{{"bounced<br/>(terminal)"}}
    sent --> returned{{"returned<br/>(terminal)"}}
    sent --> failed{{"failed<br/>(terminal)"}}
```

A send mints a `providerMessageId` and receives its whole event timeline **up front**, each event
stamped with the wall-clock time it becomes due - email in 20-240 seconds, SMS in 10-90 seconds,
direct mail in 3-9 days - and `advanceOutreach` applies whatever has come due whenever an opportunity
is read, whenever the matcher runs, or when `Fast forward lifecycle` pulls the whole schedule to now.
`supersedes()` enforces that a terminal status cannot be walked backwards and a redelivered event is a
no-op, so replaying the same event twice changes nothing. Only direct mail's multi-day delay is
guaranteed to still be pending by the time anyone looks at it; email and SMS routinely resolve
themselves within minutes of being sent.

---

## 11. What is real, and what is mocked

| Real | Mocked, because the story says so |
|---|---|
| 404,023 Duval parcels, every value and its provenance | Owner outreach: addressed to a reserved `.invalid` domain and a 555 number |
| Criteria matching, scoring, ranking, the disclosed SQL | Owner contact details: a deterministic mocked skip trace, never a real vendor |
| Change detection: a diff against a real stored snapshot | The delivery lifecycle: a deterministic simulator, not a real Twilio/SendGrid/print vendor |
| The scheduled matcher: a real GitHub Actions cron, a real diff | The "simulate a pipeline update" button: writes a real overlay row the matcher then finds by diffing - the notification is not injected |
| Alerts, opportunities, notes, tasks, stage history | Court data volume: a small demo overlay, not a live county-records feed |

---

## 12. Repository map

```
app/
  search/               map, criteria panel, disclosed SQL, parcel drawer
  searches/             saved searches, watch state, simulate buttons
  alerts/               notification history, evidence per alert
  opportunities/        board + table, filters, export, campaign launch
  opportunities/[id]/   deal detail: stage, notes, tasks, outreach panel
  pipeline/             pipeline run history + matcher run history, clear simulation
  agent/                natural-language search, model dropdown, tool transcript
  api/                  one route per CRM aggregate; see the container diagram
lib/
  data/                 PropertyDataSource: browser (DuckDB-WASM) and server (native/WASM) engines
  criteria/              SQL builder, scoring, fingerprinting (matchHashOf, changedFields)
  notify/                the matcher: evaluate.ts (shared diff), matcher.ts (Node side),
                         collect.ts (the one sweep both matchers use), providers.ts + outreach.ts
                         (the simulated send/lifecycle), limits.ts (the two caps, one place)
  crm/                   documents.ts (shapes), store.ts + store-github.ts / store-postgres.ts /
                         store-memory.ts (the three backends), repo.ts, overlay.ts, simulate.ts
  agent/                 provider registry, the 8-tool read-only agent, rate limiting
  oracle/                vendored from the Duval pipeline repository - see lib/oracle/VENDORED.md
scripts/
  run-matcher.ts         what .github/workflows/matcher.yml actually runs
  verify-loop.ts          the whole notification loop, end to end, against whatever store is configured
  smoke.mts               drives the deployed URL with a real browser
.github/workflows/
  matcher.yml             the continuous half: cron */30, native DuckDB, writes to the CRM store
  ci.yml                  typecheck, lint, test on every push
```

Live system: <https://residential-jax-crm.vercel.app>
