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
 * How many matches a saved search fingerprints and watches.
 *
 * A thesis can match 151,856 parcels; storing a snapshot of each on the search
 * document, and diffing all of them every thirty minutes, is not a trade worth
 * making for a change to the 50,000th best match. So the tracked set is the
 * best `TRACKED_MATCH_CAP` by score.
 *
 * The cost is real and is disclosed on screen rather than buried here: a change
 * to a parcel ranked below the cap raises nothing, and never will.
 */
export const TRACKED_MATCH_CAP = 2_000;
