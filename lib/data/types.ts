/**
 * The property side of this application talks to one interface and never to a
 * file, a URL or a SQL dialect. Everything below describes what a property data
 * source must be able to answer; `source.ts` picks the implementation.
 *
 * This exists because the CRM must not be welded to one dataset. Today the
 * bundled sample parquet answers these calls; pointing PROPERTY_DATA_URL at the
 * published Duval query table on an IPFS gateway swaps in 404,023 real parcels
 * with no code change. A future county, a Postgres warehouse or a REST service
 * is a new implementation of this interface and nothing else.
 */

import type { MapViewport } from "@/lib/criteria/sql";
import type { CriteriaSet } from "@/lib/criteria/types";
import type { Overlay } from "./overlay";

/** Identity and honesty about what is currently answering. */
export interface DataSourceInfo {
  /** Implementation id, e.g. "duckdb-parquet". */
  readonly kind: string;
  /** Human label shown in the header, e.g. "Duval County query table". */
  readonly label: string;
  /** Where the data came from, shown to the user. Never a secret. */
  readonly location: string;
  /**
   * True when this is a bundled sample rather than the published county
   * artifact. The UI renders a SAMPLE badge whenever this is true, so a
   * reviewer can never mistake a subset for the full roll.
   */
  readonly isSample: boolean;
  readonly countyName: string;
  readonly stateCode: string;
  /** Rows available to query. */
  readonly rowCount: number;
  /** Column count, for the schema panel. */
  readonly columnCount: number;
  /** When the underlying artifact was produced by the pipeline. */
  readonly generatedAt: string | null;
  /** The pipeline run that produced the artifact currently loaded. */
  readonly runId: string | null;
}

/* ------------------------------------------------------------------ attach */

/**
 * Whether the published artifact is readable yet.
 *
 * This is a union rather than a pair of booleans because of a specific lie the
 * product used to tell. On a cold load the parquet attach takes as long as the
 * gateway takes - forty seconds is normal, two minutes has been observed - and
 * during that window the surface rendered "Searching" and then "No parcels
 * match these criteria". A reviewer's first impression of a CRM over 404,023
 * parcels was that it had found nothing.
 *
 * "The query ran and returned zero rows" and "there is nothing to query yet"
 * are different facts, and only one of them is ever true. Making them different
 * *types* is what stops the second from being rendered as the first: the row
 * count and the total live on the ready variant only, so a component cannot
 * reach for `rows.length` without having narrowed past `attaching` first. It is
 * a compile error rather than a code review note.
 */
export type AttachState = AttachAttaching | AttachReady | AttachFailed;

export interface AttachAttaching {
  readonly phase: "attaching";
  /** What it is doing right now, in words a non-engineer can read. */
  readonly message: string;
  /** 0..1 while bytes are being counted, null when the size is not known. */
  readonly progress: number | null;
  /** Since the first gateway was tried, so a long wait reads as a slow network. */
  readonly elapsedMs: number;
  /** The gateway being tried, and where it sits in the list. */
  readonly gateway: string;
  readonly gatewayIndex: number;
  readonly gatewayCount: number;
  /** True once the configured gateway has been given up on. Said out loud. */
  readonly failedOver: boolean;
}

export interface AttachReady {
  readonly phase: "ready";
  /** The gateway that answered. Not always the configured one. */
  readonly gateway: string;
  readonly failedOver: boolean;
  readonly elapsedMs: number;
  /** How the bytes got here: range read, whole download, or browser cache. */
  readonly accessMode: string | null;
  /**
   * Set when NO gateway answered and this browser's own cached copy is what is
   * being served.
   *
   * Present rather than absent is the whole signal, and it is not optional
   * politeness: an app quietly answering a query about 404,023 parcels out of
   * last Tuesday's artifact, with no gateway reachable to confirm any of it, is
   * telling the same class of lie as "no parcels match these criteria" during a
   * cold load. `DataSourceInfo.label` and `.location` carry it to the surface,
   * so the Dataset row says cached and says when the copy was taken.
   */
  readonly cached?: CachedArtifactInfo | null;
}

/** A copy of the artifact held by this browser from an earlier visit. */
export interface CachedArtifactInfo {
  /** The gateway URL the bytes were originally read from. */
  readonly sourceUrl: string;
  readonly bytes: number;
  /** ISO 8601, when the copy was taken. */
  readonly cachedAt: string;
  /** The version the gateway reported then. Null when it reported none. */
  readonly version: string | null;
}

export interface AttachFailed {
  readonly phase: "failed";
  readonly error: string;
  /** Every gateway that was tried, so the retry message can name them. */
  readonly tried: readonly string[];
  readonly elapsedMs: number;
  /**
   * What each gateway actually did, in the order they were first tried.
   *
   * "Something went wrong" is not a diagnosis a person can act on. This is: it
   * distinguishes a gateway that timed out from one that rate limited us from
   * one that does not hold the content, which is the difference between waiting,
   * pointing NEXT_PUBLIC_IPFS_GATEWAYS somewhere else, and re-publishing.
   */
  readonly attempts?: readonly GatewayAttempt[];
}

export interface GatewayAttempt {
  readonly url: string;
  /** How many times it was asked, across every pass. */
  readonly tries: number;
  /** The last thing it said, or the deadline it missed. */
  readonly error: string;
  /** True when it consumed its whole deadline rather than refusing outright. */
  readonly timedOut: boolean;
}

export interface ColumnDescriptor {
  readonly name: string;
  readonly type: string;
  /** English description, used by the filter builder and given to the agent. */
  readonly meaning: string | null;
  /** True for the columns that record where a row came from. */
  readonly isProvenance: boolean;
  /** True when the pipeline derived this rather than reading it from a source. */
  readonly isDerived: boolean;
}

/** Where a single displayed record came from. Required by the story. */
export interface Provenance {
  readonly sourceSystem: string | null;
  readonly sourceUrl: string | null;
  readonly fetchedAt: string | null;
  readonly runId: string | null;
  readonly sourceArtifact: string | null;
  readonly sourceSha256: string | null;
}

/**
 * The subset of query table columns this application reads by name. Anything
 * else is still available through `raw`, so a column added by the pipeline is
 * never lost just because the CRM has not been taught about it.
 */
export interface PropertyRecord {
  readonly propertyId: string;
  readonly parcelIdentifier: string | null;
  readonly propertyCid: string | null;

  readonly addressStreet: string | null;
  readonly addressCity: string | null;
  readonly addressZip: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly subdivision: string | null;
  readonly neighborhoodCode: string | null;

  readonly propertyType: string | null;
  readonly propertyUsageType: string | null;
  readonly builtYear: number | null;
  readonly livableFloorArea: number | null;
  readonly totalArea: number | null;
  readonly residentialUnits: number | null;

  readonly roofYearEst: number | null;
  readonly roofAgeYears: number | null;
  readonly roofAgeBasis: string | null;
  readonly roofCoveringMaterial: string | null;

  readonly assessedValue: number | null;
  readonly marketValue: number | null;
  readonly landValue: number | null;
  readonly taxableValue: number | null;

  readonly ownerName: string | null;
  readonly ownerCount: number | null;
  readonly ownerOccupied: boolean | null;
  readonly ownerRegionClass: string | null;
  readonly ownerMailingAddress: string | null;
  readonly ownerMailingCity: string | null;
  readonly ownerMailingState: string | null;
  readonly ownerMailingZip: string | null;
  readonly homesteadFlag: boolean | null;

  readonly lastSaleDate: string | null;
  readonly lastSalePrice: number | null;
  readonly yearsSinceLastSale: number | null;
  readonly tenureBasis: string | null;

  readonly waterViewFlag: boolean | null;
  readonly waterDistM: number | null;
  readonly waterBodyName: string | null;
  readonly nearestTransitStopM: number | null;
  readonly nearestTransitStopName: string | null;

  readonly hasPermits: boolean | null;
  readonly permitCount: number | null;
  readonly roofPermitCount: number | null;
  readonly lastPermitDate: string | null;

  readonly provenance: Provenance;
  /** Every published column, unmodified, for the detail view. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** One criterion's contribution to a property's score, for the rationale. */
export interface ScoreComponent {
  readonly key: string;
  /** Shown to the user, e.g. "Roof 34 years old (threshold 15)". */
  readonly label: string;
  /** 0..1 before weighting. */
  readonly value: number;
  readonly weight: number;
  /** value * weight, in points out of 100. */
  readonly points: number;
  readonly matched: boolean;
}

export interface ScoredProperty {
  readonly property: PropertyRecord;
  /** 0..100. */
  readonly score: number;
  readonly components: readonly ScoreComponent[];
  /** One sentence explaining the score, assembled from the components. */
  readonly rationale: string;
  /**
   * Stable digest of the fields that matter to matching. The scheduled matcher
   * diffs this to tell "this parcel is new to your search" from "this parcel
   * changed underneath you".
   */
  readonly matchHash: string;
}

export interface PropertySearchQuery {
  readonly criteria: CriteriaSet;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "score" | "assessed_value" | "roof_age" | "tenure";
  /** Restrict to these ids. Used by the matcher when re-checking known hits. */
  readonly propertyIds?: readonly string[];
  /**
   * Narrow to the map's current view. Display only: it is not part of the
   * criteria set, is never saved, and the scheduled matcher never sets it.
   */
  readonly viewport?: MapViewport | null;
  /**
   * Court records and simulated pipeline updates to apply on top of the
   * published parquet for this query. See lib/data/overlay.ts.
   */
  readonly overlay?: Overlay;
}

export interface PropertySearchResult {
  readonly rows: readonly ScoredProperty[];
  /** Total matching the criteria, before limit/offset. */
  readonly total: number;
  /** The SQL that produced this, shown in the UI so a result is auditable. */
  readonly sql: string;
  readonly tookMs: number;
  readonly truncated: boolean;
}

/** A run of the upstream pipeline, read from its published run history. */
export interface PipelineRun {
  readonly runId: string;
  readonly county: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: string;
  readonly trigger: string | null;
  readonly tracks: readonly string[];
  readonly sources: readonly PipelineSourceDelta[];
  readonly limitations: readonly string[];
  readonly totals: Readonly<Record<string, number>>;
}

export interface PipelineSourceDelta {
  readonly track: string;
  readonly sourceSystem: string | null;
  readonly sourceUrl: string | null;
  readonly rowsStaged: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly tableTotalAfter: number;
  readonly status: string;
  readonly limitations: readonly string[];
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly sql: string;
  readonly tookMs: number;
}

/**
 * The contract. Every property read in this application goes through one of
 * these methods; nothing outside `lib/data/` opens a parquet file or builds a
 * URL.
 */
export interface PropertyDataSource {
  info(): Promise<DataSourceInfo>;
  getSchema(): Promise<readonly ColumnDescriptor[]>;
  search(query: PropertySearchQuery): Promise<PropertySearchResult>;
  getProperty(propertyId: string, overlay?: Overlay): Promise<PropertyRecord | null>;
  /** Free text lookup by address, owner or parcel id, for the search box. */
  lookup(term: string, limit?: number): Promise<readonly PropertyRecord[]>;
  listRuns(limit?: number): Promise<readonly PipelineRun[]>;
  /** Read only SQL, used by the agent and the query console. */
  runSql(sql: string, limit?: number): Promise<QueryResult>;
  /** Release any held handles. Safe to call more than once. */
  close(): Promise<void>;
}
