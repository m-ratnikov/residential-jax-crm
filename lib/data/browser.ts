"use client";

/**
 * `PropertyDataSource`, implemented in the visitor's tab.
 *
 * This is the deployed read path, and it is the one the assignment actually
 * asks for. The story requires the CRM to run "without requiring Oracle to
 * carry ongoing hosted-database cost beyond the existing Duval pipeline +
 * DuckDB / Elephant IPFS pattern". DuckDB-WASM range reading the published
 * parquet straight off the gateway IS that pattern: nothing is copied, nothing
 * is converted, and no server is involved in answering a query. When the
 * pipeline re-points its IPNS name, the next page load reads the new data with
 * no redeploy.
 *
 * The engine underneath (lib/oracle/duckdb.ts) is vendored from the pipeline
 * repository, where it already does this at 404,023 parcels. What is new here
 * is only the mapping from this application's interface onto it, so the browser
 * and the Node matcher answer the same criteria with the same SQL and the same
 * scoring.
 */

import { runQuery, ensureLoaded, getState, resetEngine } from "@/lib/oracle/duckdb";
import { COLUMN_MEANINGS } from "@/lib/oracle/agent/schema";
import { EXTRA_COLUMNS, PROVENANCE_COLUMNS } from "@/lib/oracle/columns";
import { guardSql } from "@/lib/oracle/sql";
import { buildSearch, SCORE_ALIAS, TOTAL_ALIAS, str, VIEW } from "@/lib/criteria/sql";
import { matchHashOf, rationaleFor } from "@/lib/criteria/score";
import { buildOverlay, EMPTY_OVERLAY, isEmptyOverlay, type Overlay } from "./overlay";
import { toRecord } from "./map";
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
import { loadRunHistoryFrom } from "./runs-parse";

const DERIVED = new Set<string>(EXTRA_COLUMNS);
const PROVENANCE = new Set<string>(PROVENANCE_COLUMNS);

export interface BrowserSourceOptions {
  /** The parquet URL DuckDB-WASM range reads. */
  url: string;
  isSample: boolean;
  label: string;
  countyName: string;
  stateCode: string;
  runHistoryUrl: string | null;
}

export class BrowserPropertyDataSource implements PropertyDataSource {
  readonly kind = "duckdb-wasm-browser";

  #info: DataSourceInfo | null = null;
  #schema: readonly ColumnDescriptor[] | null = null;
  #runs: readonly PipelineRun[] | null = null;

  constructor(private readonly options: BrowserSourceOptions) {}

  /** Start loading without waiting, so the UI can show progress. */
  prefetch(): Promise<void> {
    return ensureLoaded(this.options.url);
  }

  /** Engine load progress, for the banner while the artifact attaches. */
  engineState() {
    return getState();
  }

  async #query(sql: string) {
    return runQuery(this.options.url, sql);
  }

  async info(): Promise<DataSourceInfo> {
    if (this.#info) return this.#info;

    const [counts, schema] = await Promise.all([
      this.#query(`SELECT count(*) AS n FROM ${VIEW}`),
      this.getSchema(),
    ]);

    // features_as_of and run_id are uniform across the export, so any_value is
    // both correct and cheap.
    const meta = await this.#query(
      `SELECT any_value(run_id) AS run_id, max(features_as_of) AS as_of FROM ${VIEW}`,
    ).catch(() => null);

    this.#info = {
      kind: this.kind,
      label: this.options.label,
      location: this.options.url,
      isSample: this.options.isSample,
      countyName: this.options.countyName,
      stateCode: this.options.stateCode,
      rowCount: Number(counts.rows[0]?.["n"] ?? 0),
      columnCount: schema.length,
      generatedAt: (meta?.rows[0]?.["as_of"] as string | null) ?? null,
      runId: (meta?.rows[0]?.["run_id"] as string | null) ?? null,
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
      prefix: overlay.prefix,
      from: overlay.from,
    });

    const [page, count] = await Promise.all([this.#query(built.sql), this.#query(built.countSql)]);

    const totalWeight = built.score.components.reduce((sum, component) => sum + component.weight, 0);

    const rows: ScoredProperty[] = page.rows.map((row) => {
      const property = toRecord(row);
      const components = built.score.components.map((component) => {
        const value = Number(row[component.alias] ?? 0);
        return {
          key: component.key,
          label: component.rule,
          value,
          weight: component.weight,
          points: totalWeight
            ? Math.round(((component.weight * value) / totalWeight) * 1000) / 10
            : 0,
          matched: value > 0,
        };
      });
      return {
        property,
        score: Number(row[SCORE_ALIAS] ?? 0),
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
      tookMs: Math.round(page.elapsedMs + count.elapsedMs),
      truncated: total > offset + rows.length,
    };
  }

  async getProperty(propertyId: string, overlay?: Overlay): Promise<PropertyRecord | null> {
    // Restrict the overlay to this parcel: inlining every court row to read one
    // property would be wasted work on every detail view.
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
    if (this.#runs) return this.#runs.slice(0, limit);
    if (!this.options.runHistoryUrl) return [];
    try {
      const response = await fetch(this.options.runHistoryUrl);
      if (!response.ok) return [];
      this.#runs = loadRunHistoryFrom(await response.json(), 100);
      return this.#runs.slice(0, limit);
    } catch {
      // A run history the tab cannot reach is a degraded panel, not a broken
      // CRM. The caller renders "history unavailable".
      return [];
    }
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
      rows: result.rows as Readonly<Record<string, unknown>>[],
      rowCount: result.rows.length,
      truncated: result.rows.length >= limit,
      sql: guarded,
      tookMs: Math.round(result.elapsedMs),
    };
  }

  async close(): Promise<void> {
    await resetEngine();
  }
}
