# CRM state

This branch holds the CRM's documents: saved criteria, alerts, opportunities,
owners, court records and matcher evidence. One JSON file per aggregate, written
by the application through the GitHub contents API and by the scheduled matcher.

It is a branch rather than a database because the assignment asks for the CRM to
operate "without requiring Oracle to carry ongoing hosted-database cost beyond
the existing Duval pipeline + DuckDB / Elephant IPFS pattern". A repository is
not a database, costs nothing, and this is the same mechanism the Duval pipeline
already uses to commit its run history.

The document key carries the invariants a relational schema would have spent
unique indexes on:

- `opportunities/<propertyId>.json` - one live opportunity per parcel
- `alerts/<matcherRun>__<search>__<parcel>.json` - one alert per pass, so a
  retried matcher cannot notify twice
- `court/<propertyId>.json`, `simulated/<propertyId>.json` - one per parcel

Nothing here is hand-edited. The history reads as an audit log of what the CRM
did and when.
