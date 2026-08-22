/**
 * The caps the notifier works within, in a module with no server imports.
 *
 * They belong beside the code that enforces them, in evaluate.ts - but that
 * module reaches the CRM store, and importing it from a component would drag
 * every store adapter into the browser bundle. So the numbers live here, where
 * the tab and the server can both read them, and evaluate.ts re-exports them so
 * server code still finds them where it expects.
 *
 * They were previously written out by hand in three client files. A cap that is
 * disclosed on screen and defined in four places is a cap that will eventually
 * be disclosed wrongly.
 */

/**
 * How many matches a saved search FINGERPRINTS, so it can say what changed.
 *
 * A thesis can match 151,856 parcels; storing a sixteen field snapshot of each
 * on the search document, and diffing all of them every thirty minutes, is not
 * a trade worth making for a change to the 50,000th best match. So the
 * fingerprinted set is the best `TRACKED_MATCH_CAP` by score.
 *
 * This is the cap the UI discloses, and it still means exactly what it says: a
 * change to a FIELD of a parcel ranked below it raises nothing. What it no
 * longer means is that the parcel is invisible - see `MATCH_ID_CAP`.
 */
export const TRACKED_MATCH_CAP = 2_000;

/**
 * How many matching parcel IDS a pass retrieves and the search then remembers.
 *
 * These two numbers used to be one constant, and that single fact was the whole
 * defect. A pass never asked for rank 2,001, so "this parcel newly matches your
 * saved search" - the sentence the whole feature exists to say - was answered
 * from the top 2,000 of a 151,856 row match set: 1.3% of it. Ranking here is
 * deterministic and tenure and roof age rise monotonically, so a parcel at rank
 * 5,000 does not climb 3,000 places on the next refresh. It was not late, it
 * was permanently invisible.
 *
 * It was worse than blind. `previous` was the stored top 2,000, so a parcel
 * that sat at rank 2,001 and moved to 1,999 had no entry to compare against and
 * was delivered as "now matches your saved search" for a parcel that had
 * matched for months. Every boundary crossing was a false alert.
 *
 * So membership and field level change detection are now separately capped,
 * because they cost separately: an id is eleven bytes and a fingerprint plus
 * snapshot is roughly a kilobyte. Membership - "is this parcel in the set" -
 * runs to `MATCH_ID_CAP`. Field level change detection stays at
 * `TRACKED_MATCH_CAP`, where the storage cost actually is.
 *
 * 200,000 covers every thesis observed on the live deployment (10,209, 67,399
 * and 151,856 matches) with headroom, and stops short of a criteria set that
 * selects the whole 404,023 parcel roll, which is a browse and not a watch.
 */
export const MATCH_ID_CAP = 200_000;

/**
 * The page size the id sweep reads in.
 *
 * Not a policy: it is the ceiling `PropertyDataSource.search` imposes on any one
 * query (`Math.min(..., 5_000)` in both lib/data/browser.ts and
 * lib/data/duckdb.ts). Collecting 151,856 ids therefore costs 31 ordered pages
 * rather than one query. The ordering is a total order by construction - score,
 * then the tiebreak, then property_id - so paging cannot repeat or skip a row.
 */
export const MATCH_ID_PAGE_SIZE = 5_000;

/**
 * How many parcels beyond `TRACKED_MATCH_CAP` a pass carries full detail for.
 *
 * Detecting that rank 5,000 newly matches is free once the id set exists.
 * Alerting on it is not: an alert names the address, the owner, the score and
 * the rationale, and none of that is in an id. So the sweep keeps the rows it
 * has already materialised for parcels the caller does not already know about,
 * bounded by this.
 *
 * 500 is `alertLimitPerRun`'s own maximum (see app/api/searches/route.ts), so
 * the bound can never be what stops an alert the search was willing to raise.
 */
export const NEW_MATCH_DETAIL_CAP = 500;

/**
 * How many leading characters of a parcel id decide which line it is stored on.
 *
 * The id set lives in a JSON document committed to a git branch, so two costs
 * matter that would not matter in a database: how many bytes the document is,
 * and how many lines change when one parcel enters or leaves the set.
 *
 * Grouping by a fixed id prefix answers both at once. Duval parcel ids are
 * eleven characters and heavily prefix clustered by plat, so storing the shared
 * prefix once per group and only the seven character remainder per parcel takes
 * the 75,988 id sample from 1,410 KB as a JSON array to 599 KB - and, because a
 * parcel's group is a function of the parcel alone rather than of its position
 * in a sorted list, one id arriving rewrites one line instead of shifting every
 * line after it. Measured on that sample: five parcels in and five out changed
 * nine lines out of 336.
 */
export const MATCH_ID_GROUP_PREFIX = 4;
