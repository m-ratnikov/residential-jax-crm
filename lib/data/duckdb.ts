/**
 * The DuckDB implementation of `PropertyDataSource`.
 *
 * One DuckDB instance per warm process, one view named `properties` over the
 * published query table parquet, one short lived connection per statement. The
 * parquet is read in place: a bundled file today, an IPFS gateway URL through
 * httpfs range reads once the pipeline publishes. Nothing is copied into a
 * database, which is what keeps the "no ongoing hosted-database cost" criterion
 * true for the property corpus.
 *
 * Court records and simulated pipeline updates are not baked into the view.
 * They arrive per query as an overlay (lib/data/overlay.ts) and are inlined as
 * a CTE, because they change between one request and the next while the parquet
 * does not. When no overlay is supplied the query reads the view directly, so
 * the common path costs nothing.
 */

import { COLUMN_MEANINGS } from "@/lib/oracle/agent/schema";
import { EXTRA_COLUMNS, PROVENANCE_COLUMNS } from "@/lib/oracle/columns";
import { guardSql } from "@/lib/oracle/sql";
import { buildSearch, VIEW, SCORE_ALIAS, TOTAL_ALIAS, str } from "@/lib/criteria/sql";
import { buildOverlay, EMPTY_OVERLAY, isEmptyOverlay, type Overlay } from "./overlay";
import { rationaleFor, matchHashOf } from "@/lib/criteria/score";
import { dataConfig } from "./config";
import type {
  ColumnDescriptor,
  DataSourceInfo,
  PipelineRun,
  PropertyDataSource,
  PropertyRecord,
  PropertySearchQuery,
  PropertySearchResult,
  QueryResult,
  ScoredProperty,
} from "./types";
import { toRecord } from "./map";
import { loadRunHistory } from "./runs";

import { openEngine, sqlPath, type Plain, type QueryEngine } from "./engine";

export type { Plain } from "./engine";
export type Row = Record<string, Plain>;

const DERIVED = new Set<string>(EXTRA_COLUMNS);
const PROVENANCE = new Set<string>(PROVENANCE_COLUMNS);

export interface DuckDbSourceOptions {
  /** Parquet path or URL for the query table. */
  source: string;
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  /** Where run-history.json lives. */
  runHistoryUrl: string | null;
}

export class DuckDbPropertyDataSource implements PropertyDataSource {
  readonly kind = "duckdb-parquet";

  #engine: Promise<QueryEngine> | null = null;
  #info: DataSourceInfo | null = null;
  #schema: readonly ColumnDescriptor[] | null = null;
  #closed = false;

  constructor(private readonly options: DuckDbSourceOptions) {}

  /** Which engine answered, for the data source panel. */
  async engineKind(): Promise<string> {
    return (await this.#db()).kind;
  }

  async #db(): Promise<QueryEngine> {
    if (this.#closed) throw new Error("data source is closed");
    this.#engine ??= openEngine(
      this.options.source,
      (path) => `CREATE OR REPLACE VIEW ${VIEW} AS SELECT * FROM read_parquet(${sqlPath(path)})`,
    ).catch((error: unknown) => {
      this.#engine = null; // a failed open must not poison the cache
      throw error;
    });
    return this.#engine;
  }

  async #query(sql: string) {
    const engine = await this.#db();
    return engine.query(sql);
  }

  async info(): Promise<DataSourceInfo> {
    if (this.#info) return this.#info;
    const [counts, meta] = await Promise.all([
      this.#query(`SELECT count(*) AS n FROM ${VIEW}`),
      this.#query(
        `SELECT any_value(run_id) AS run_id, max(features_as_of) AS as_of FROM ${VIEW}`,
      ).catch(() => null),
    ]);
    const schema = await this.getSchema();
    const rowCount = Number(counts.rows[0]?.n ?? 0);
    this.#info = {
      kind: this.kind,
      label: this.options.label,
      location: this.options.source,
      isSample: this.options.isSample,
      countyName: this.options.countyName,
      stateCode: this.options.stateCode,
      rowCount,
      columnCount: schema.length,
      generatedAt: (meta?.rows[0]?.as_of as string | null) ?? null,
      runId: (meta?.rows[0]?.run_id as string | null) ?? null,
    };
    return this.#info;
  }

  async getSchema(): Promise<readonly ColumnDescriptor[]> {
    if (this.#schema) return this.#schema;
    const described = await this.#query(`DESCRIBE SELECT * FROM ${VIEW}`);
    this.#schema = described.rows.map((row) => {
      const name = String(row["column_name"] ?? "");
      return {
        name,
        type: String(row["column_type"] ?? "UNKNOWN"),
        meaning: COLUMN_MEANINGS[name] ?? null,
        isProvenance: PROVENANCE.has(name),
        isDerived: DERIVED.has(name) || name.startsWith("court_"),
      };
    });
    return this.#schema;
  }

  async search(query: PropertySearchQuery): Promise<PropertySearchResult> {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 5_000);
    const offset = Math.max(query.offset ?? 0, 0);
    const overlay = buildOverlay(query.overlay ?? EMPTY_OVERLAY);

    const built = buildSearch({
      criteria: query.criteria,
      limit,
      offset,
      orderBy: query.orderBy ?? "score",
      courtJoinAvailable: overlay.courtAvailable,
      propertyIds: query.propertyIds,
      viewport: query.viewport,
      prefix: overlay.prefix,
      from: overlay.from,
    });

    const [page, count] = await Promise.all([this.#query(built.sql), this.#query(built.countSql)]);

    const rows: ScoredProperty[] = page.rows.map((row) => {
      const property = toRecord(row);
      const score = Number(row[SCORE_ALIAS] ?? 0);
      const components = built.score.components.map((component) => {
        const value = Number(row[component.alias] ?? 0);
        return {
          key: component.key,
          label: component.rule,
          value,
          weight: component.weight,
          points:
            Math.round(
              ((component.weight * value) /
                built.score.components.reduce((sum, c) => sum + c.weight, 0)) *
                1000,
            ) / 10,
          matched: value > 0,
        };
      });
      return {
        property,
        score,
        components,
        rationale: rationaleFor(property, components, built.score.unranked),
        matchHash: matchHashOf(property),
      };
    });

    const total = Number(count.rows[0]?.[TOTAL_ALIAS] ?? rows.length);

    return {
      rows,
      total,
      sql: built.sql,
      tookMs: page.tookMs + count.tookMs,
      truncated: total > offset + rows.length,
    };
  }

  async getProperty(propertyId: string, overlay?: Overlay): Promise<PropertyRecord | null> {
    // Restrict the overlay to this parcel: inlining thousands of court rows to
    // read one property would be a waste on every detail view.
    const scoped =
      overlay && !isEmptyOverlay(overlay)
        ? {
            court: overlay.court.filter((entry) => entry.propertyId === propertyId),
            overrides: overlay.overrides.filter((entry) => entry.propertyId === propertyId),
          }
        : EMPTY_OVERLAY;
    const built = buildOverlay(scoped);

    const result = await this.#query(
      `${built.prefix}SELECT * FROM ${built.from} WHERE property_id = ${str(propertyId)} LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async lookup(term: string, limit = 25): Promise<readonly PropertyRecord[]> {
    const needle = str(`%${term.trim()}%`);
    const exact = str(term.trim());
    const result = await this.#query(
      `SELECT * FROM ${VIEW}
       WHERE property_id = ${exact}
          OR parcel_identifier = ${exact}
          OR address_street ILIKE ${needle}
          OR owner_name ILIKE ${needle}
       ORDER BY CASE WHEN property_id = ${exact} THEN 0 ELSE 1 END, address_street
       LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
    );
    return result.rows.map(toRecord);
  }

  async listRuns(limit = 25): Promise<readonly PipelineRun[]> {
    return loadRunHistory(this.options.runHistoryUrl, limit);
  }

  async runSql(sql: string, limit = 200): Promise<QueryResult> {
    const guard = guardSql(sql, limit);
    if (!guard.ok || !guard.sql) {
      throw new Error(guard.reason ?? "the statement was rejected by the read-only guard");
    }
    const guarded = guard.sql;
    const result = await this.#query(guarded);
    return {
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.rows.length >= limit,
      sql: guarded,
      tookMs: result.tookMs,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const engine = this.#engine;
    this.#engine = null;
    if (engine) await (await engine).close();
  }
}

/** Resolve the configured source into a live data source. */
export function createDuckDbSource(): DuckDbPropertyDataSource {
  const cfg = dataConfig();
  return new DuckDbPropertyDataSource({
    source: cfg.queryTableSource,
    isSample: cfg.isSample,
    label: cfg.label,
    countyName: cfg.countyName,
    stateCode: cfg.stateCode,
    runHistoryUrl: cfg.runHistoryUrl,
  });
}
