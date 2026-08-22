/**
 * The agent's tools.
 *
 * Every one goes through the same `PropertyDataSource` and the same repository
 * functions the UI uses, so the agent cannot see a different dataset from the
 * screen next to it. Schemas are zod, per the engineering guideline that no LLM
 * code uses `any`.
 *
 * The trace is how a tool call becomes evidence a reader can check: each call
 * records its name, input, a one line summary, row count and elapsed time, and
 * the rows it returned are kept so the UI can show them under the answer rather
 * than asking the reader to trust the prose. Caveats the tools notice - a
 * sample dataset, a roof age that is really a proxy, a missing court source -
 * are collected as assumptions rather than left to the model to remember.
 */

import { tool } from "ai";
import { z } from "zod";

import { criteriaSetSchema, CRITERIA_PRESETS } from "@/lib/criteria/types";
import { provenanceInstant } from "@/lib/data/instant";
import { NEIGHBOURHOODS } from "@/lib/criteria/areas";
import { displayAddress } from "@/lib/data/map";
// From runs-parse, not runs: these tools run in the browser, and lib/data/runs
// is the Node half of that split - it imports node:fs/promises for the local
// file path. Pulling it in here put a node: builtin in the browser chunk, which
// Turbopack cannot chunk, and `pnpm dev` answered /agent with a 500.
import { runDelta } from "@/lib/data/runs-parse";
import type { PropertyDataSource } from "@/lib/data/types";
import type { Overlay } from "@/lib/data/overlay";
import type { AgentDataFreshness, AgentEvidenceRow, AgentToolCall } from "@/lib/oracle/agent/types";

/** The shapes the CRM API returns, named so the tools stay free of `any`. */
interface SavedSearchRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  lastEvaluatedAt: string | null;
  lastPipelineRunId: string | null;
  lastMatchCount: number | null;
  criteria: unknown;
}

interface OpportunityListRow {
  opportunity: {
    id: string;
    propertyId: string;
    addressLine: string;
    stage: string;
    matchScore: number | null;
    assessedValue: number | null;
    ownerNameSnapshot: string | null;
    askingPrice: number | null;
    offerPrice: number | null;
    nextStep: string | null;
  };
  owner: { name: string } | null;
  assignee: { name: string } | null;
  searchName: string | null;
}

interface AlertListRow {
  id: string;
  kind: string;
  propertyId: string;
  searchName: string | null;
  score: number;
  rationale: string;
  changedFields: string[];
  pipelineRunId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface AgentTrace {
  calls: AgentToolCall[];
  evidence: AgentEvidenceRow[];
  /** Caveats the tools observed, surfaced under the answer. */
  assumptions: string[];
  freshness: AgentDataFreshness | null;
  /** True when the loaded dataset is the bundled sample. */
  isSample: boolean;
}

export function newTrace(): AgentTrace {
  return { calls: [], evidence: [], assumptions: [], freshness: null, isSample: false };
}

/** Rows the agent may quote, capped so a transcript stays readable. */
const EVIDENCE_CAP = 25;
const ROW_CAP = 200;

function note(trace: AgentTrace, text: string): void {
  if (!trace.assumptions.includes(text)) trace.assumptions.push(text);
}

function record(
  trace: AgentTrace,
  name: string,
  input: Record<string, unknown>,
  started: number,
  rowCount: number,
  summary: string,
  error?: string,
): void {
  const call: AgentToolCall = {
    name,
    input,
    summary,
    output_summary: summary,
    elapsed_ms: Date.now() - started,
    row_count: rowCount,
  };
  if (error) call.error = error;
  trace.calls.push(call);
}

function addEvidence(trace: AgentTrace, rows: Record<string, unknown>[], via: string): void {
  for (const row of rows.slice(0, EVIDENCE_CAP)) {
    if (trace.evidence.length >= EVIDENCE_CAP * 2) break;
    const propertyId = row["property_id"];
    if (typeof propertyId !== "string") continue;
    trace.evidence.push({ ...row, property_id: propertyId, via } as AgentEvidenceRow);
  }
}

export interface ToolContext {
  source: PropertyDataSource;
  overlay: Overlay;
  courtDataAvailable: boolean;
}

/**
 * CRM reads go over the application's own HTTP API rather than through the
 * repository, because this loop runs in the tab and the repository is a
 * Postgres client. A deployment with no store answers these with a 503, which
 * is reported as "unavailable" rather than thrown - the parcel tools still work
 * and the agent can still answer most questions.
 */
async function crmFetch<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const NO_STORE_NOTE =
  "No CRM store is attached, so saved searches, alerts and opportunities are unavailable.";

export function createAgentTools(context: ToolContext, trace: AgentTrace) {
  const { source } = context;

  return {
    get_schema: tool({
      description:
        "The columns of the properties relation, their types and what each one means, plus the loaded dataset's identity and size. Call once before writing SQL.",
      inputSchema: z.object({}),
      execute: async () => {
        const started = Date.now();
        const [schema, info] = await Promise.all([source.getSchema(), source.info()]);
        trace.isSample = info.isSample;

        if (info.isSample) {
          note(
            trace,
            `The loaded dataset is a bundled sample extract of ${info.rowCount.toLocaleString("en-US")} parcels, not the full published county roll.`,
          );
        }
        if (!context.courtDataAvailable) {
          note(
            trace,
            "No court source is attached, so lien, foreclosure, probate and code enforcement signals are unavailable. Their absence is not evidence that no filings exist.",
          );
        }

        record(
          trace,
          "get_schema",
          {},
          started,
          schema.length,
          `${schema.length} columns over ${info.rowCount.toLocaleString("en-US")} parcels`,
        );

        return {
          dataset: {
            label: info.label,
            county: `${info.countyName} County, ${info.stateCode}`,
            row_count: info.rowCount,
            column_count: info.columnCount,
            is_sample: info.isSample,
            pipeline_run_id: info.runId,
            generated_at: info.generatedAt,
          },
          court_data_available: context.courtDataAvailable,
          criteria_presets: CRITERIA_PRESETS.map((preset) => ({
            id: preset.id,
            name: preset.name,
            description: preset.description,
          })),
          // The county publishes no neighbourhood boundary, so a spoken area
          // name has to become a ZIP list. Without this the agent guessed
          // `address_city = 'Arlington'`, which matches nothing: every one of
          // these ZIPs is JACKSONVILLE on the roll.
          named_areas: NEIGHBOURHOODS.map((area) => ({
            name: area.label,
            zips: area.zips,
            use: `set filters.zips to ${JSON.stringify(area.zips)}; do not filter on address_city`,
          })),
          columns: schema.map((column) => ({
            name: column.name,
            type: column.type,
            meaning: column.meaning,
            derived: column.isDerived,
            provenance: column.isProvenance,
          })),
        };
      },
    }),

    search_properties: tool({
      description:
        "Find parcels matching an acquisition criteria set. `criteria` is an OBJECT of the same shape the app's filter panel produces - {name, filters:{...}, weights:{...}} - never a sentence. For a named area such as Arlington, put the ZIPs from get_schema's named_areas into filters.zips. Returns a ranked list with a per-parcel rationale, using the same scoring the UI shows.",
      inputSchema: z.object({
        criteria: criteriaSetSchema,
        limit: z.number().int().min(1).max(50).default(15),
        orderBy: z.enum(["score", "assessed_value", "roof_age", "tenure"]).default("score"),
      }),
      execute: async ({ criteria, limit, orderBy }) => {
        const started = Date.now();

        // A sentence where the object belongs is the failure mode that made the
        // agent answer "no properties in Arlington" while the map answered
        // 1,094: the search ran with nothing in it and returned zero, which
        // reads exactly like a true negative. Refusing loudly is the whole
        // point - a tool that answers a malformed question is worse than one
        // that errors.
        if (typeof criteria !== "object" || criteria === null || !("filters" in criteria)) {
          const message =
            "criteria must be an object shaped {name, filters, weights}, not a sentence. Describe the area with filters.zips (see named_areas from get_schema), the thresholds with filters, and call this again.";
          record(
            trace,
            "search_properties",
            { criteria: String(criteria) },
            started,
            0,
            "rejected",
            message,
          );
          throw new Error(message);
        }
        const result = await source.search({
          criteria,
          limit,
          orderBy,
          overlay: context.overlay,
        });

        const rows = result.rows.map((row) => ({
          property_id: row.property.propertyId,
          address: displayAddress(row.property),
          owner_name: row.property.ownerName,
          assessed_value: row.property.assessedValue,
          built_year: row.property.builtYear,
          roof_age_years: row.property.roofAgeYears,
          roof_age_basis: row.property.roofAgeBasis,
          years_since_last_sale: row.property.yearsSinceLastSale,
          owner_occupied: row.property.ownerOccupied,
          owner_region_class: row.property.ownerRegionClass,
          water_view: row.property.waterViewFlag,
          nearest_transit_stop_m: row.property.nearestTransitStopM,
          court_distress_score: row.property.raw["court_distress_score"] ?? null,
          simulated: Boolean(row.property.raw["overlay_run_id"]),
          match_score: row.score,
          rationale: row.rationale,
          source_system: row.property.provenance.sourceSystem,
          source_url: row.property.provenance.sourceUrl,
          fetched_at: provenanceInstant(row.property.provenance.fetchedAt),
        }));

        if (rows.some((row) => String(row.roof_age_basis ?? "").includes("PROXY"))) {
          note(
            trace,
            "Some roof ages come from a year-built proxy because the county publishes no roof date for that parcel, which over-counts re-roofed houses.",
          );
        }
        if (rows.some((row) => row.simulated)) {
          note(
            trace,
            "Some values shown came from a simulated pipeline update rather than from the county.",
          );
        }

        addEvidence(trace, rows, "search_properties");
        record(
          trace,
          "search_properties",
          { criteria: criteria.name, limit, orderBy },
          started,
          rows.length,
          `${result.total.toLocaleString("en-US")} parcels matched, showing ${rows.length}`,
        );

        return {
          total_matched: result.total,
          returned: rows.length,
          sql: result.sql,
          rows,
        };
      },
    }),

    run_sql: tool({
      description:
        "Run one read-only SELECT or WITH statement against the properties relation. Use for aggregates and combinations search_properties cannot express. Results are capped.",
      inputSchema: z.object({
        sql: z.string().min(1).max(4000),
        limit: z.number().int().min(1).max(ROW_CAP).default(50),
      }),
      execute: async ({ sql, limit }) => {
        const started = Date.now();
        try {
          const result = await source.runSql(sql, limit);
          addEvidence(trace, result.rows as Record<string, unknown>[], "run_sql");
          record(
            trace,
            "run_sql",
            { sql: result.sql, limit },
            started,
            result.rowCount,
            `${result.rowCount} rows${result.truncated ? " (capped)" : ""}`,
          );
          return {
            columns: result.columns,
            rows: result.rows,
            row_count: result.rowCount,
            truncated: result.truncated,
            sql: result.sql,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          record(
            trace,
            "run_sql",
            { sql, limit },
            started,
            0,
            "the statement was rejected",
            message,
          );
          return { error: message, rows: [], row_count: 0 };
        }
      },
    }),

    get_property: tool({
      description:
        "The full published record for one parcel, including every column and its provenance.",
      inputSchema: z.object({ property_id: z.string().min(1) }),
      execute: async ({ property_id }) => {
        const started = Date.now();
        const property = await source.getProperty(property_id, context.overlay);

        record(
          trace,
          "get_property",
          { property_id },
          started,
          property ? 1 : 0,
          property ? displayAddress(property) : "not found",
        );

        if (!property) return { found: false, property_id };

        addEvidence(
          trace,
          [
            {
              property_id,
              address: displayAddress(property),
              source_system: property.provenance.sourceSystem,
              source_url: property.provenance.sourceUrl,
              fetched_at: provenanceInstant(property.provenance.fetchedAt),
            },
          ],
          "get_property",
        );

        return {
          found: true,
          address: displayAddress(property),
          simulated: Boolean(property.raw["overlay_run_id"]),
          record: property.raw,
        };
      },
    }),

    list_saved_searches: tool({
      description:
        "The team's saved acquisition criteria, with when each was last evaluated and how many parcels matched.",
      inputSchema: z.object({}),
      execute: async () => {
        const started = Date.now();
        const body = await crmFetch<{ searches: SavedSearchRow[] }>("/api/searches");
        if (!body) {
          note(trace, NO_STORE_NOTE);
          record(trace, "list_saved_searches", {}, started, 0, "no CRM store attached");
          return { available: false, searches: [] };
        }
        const searches = body.searches;
        record(
          trace,
          "list_saved_searches",
          {},
          started,
          searches.length,
          `${searches.length} saved searches`,
        );
        return {
          available: true,
          searches: searches.map((search) => ({
            id: search.id,
            name: search.name,
            description: search.description,
            active: search.active,
            last_evaluated_at: search.lastEvaluatedAt,
            last_pipeline_run_id: search.lastPipelineRunId,
            last_match_count: search.lastMatchCount,
            criteria: search.criteria,
          })),
        };
      },
    }),

    list_opportunities: tool({
      description:
        "Opportunities the team is working, with stage, assignee, match score, owner and assessed value. Use this to tell a parcel nobody has touched from one already in play. The `summary` block already contains the per-stage counts and assessed-value totals: quote those rather than adding the rows up yourself.",
      inputSchema: z.object({
        stage: z
          .array(
            z.enum(["identified", "contacted", "negotiating", "under_contract", "closed", "dead"]),
          )
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: async ({ stage, limit }) => {
        const started = Date.now();
        const query = new URLSearchParams({ limit: String(limit) });
        if (stage?.length) query.set("stage", stage.join(","));
        const body = await crmFetch<{ opportunities: OpportunityListRow[] }>(
          `/api/opportunities?${query.toString()}`,
        );
        if (!body) {
          note(trace, NO_STORE_NOTE);
          record(
            trace,
            "list_opportunities",
            { stage: stage ?? null, limit },
            started,
            0,
            "no CRM store attached",
          );
          return { available: false, opportunities: [] };
        }
        const rows = body.opportunities;
        record(
          trace,
          "list_opportunities",
          { stage: stage ?? null, limit },
          started,
          rows.length,
          `${rows.length} opportunities`,
        );
        const opportunities = rows.map((row) => ({
          id: row.opportunity.id,
          property_id: row.opportunity.propertyId,
          address: row.opportunity.addressLine,
          stage: row.opportunity.stage,
          match_score: row.opportunity.matchScore,
          // Carried here rather than left for the model to join. Without it a
          // question like "total assessed value of the live ones" has no number
          // in reach, and a model that will not admit that estimates one: the
          // first run of this answered "approximately $420,000" with every row
          // marked "(value not provided)". The store already holds the value.
          assessed_value: row.opportunity.assessedValue,
          owner_name: row.owner?.name ?? row.opportunity.ownerNameSnapshot,
          assignee: row.assignee?.name ?? null,
          asking_price: row.opportunity.askingPrice,
          offer_price: row.opportunity.offerPrice,
          next_step: row.opportunity.nextStep,
          from_search: row.searchName,
        }));

        // These are evidence too. "You have two parcels at Negotiating" is a
        // claim about specific deals, and the Rows panel exists so a reader can
        // see which ones rather than take the count on faith. Asking about the
        // board was previously the one way to get a confident answer with an
        // empty evidence panel underneath it.
        addEvidence(trace, opportunities, "list_opportunities");

        // Counted and summed here, not by the model.
        //
        // "How many in each stage and what are the live ones worth" is the most
        // obvious question anyone asks a CRM, and a language model doing the
        // arithmetic gets it nearly right: asked this, GPT-4.1 mini listed five
        // parcels of the six and reported a total 34 dollars off the rows it had
        // just printed. Arithmetic is not what it is for. The numbers below are
        // computed from the same rows the evidence panel shows, so the answer
        // and the table under it cannot disagree.
        const LIVE = new Set(["identified", "contacted", "negotiating", "under_contract"]);
        const byStage = new Map<string, { stage: string; count: number; assessed_value: number }>();
        for (const row of opportunities) {
          const entry = byStage.get(row.stage) ?? { stage: row.stage, count: 0, assessed_value: 0 };
          entry.count += 1;
          entry.assessed_value += row.assessed_value ?? 0;
          byStage.set(row.stage, entry);
        }
        const live = opportunities.filter((row) => LIVE.has(row.stage));

        return {
          available: true,
          summary: {
            // Stated so an answer can say what it counted rather than implying
            // it saw everything, when a stage filter or the limit cut the set.
            counted: opportunities.length,
            truncated: opportunities.length >= limit,
            by_stage: [...byStage.values()],
            live_stages: [...LIVE],
            live_count: live.length,
            live_assessed_value_total: live.reduce(
              (sum, row) => sum + (row.assessed_value ?? 0),
              0,
            ),
          },
          opportunities,
        };
      },
    }),

    list_alerts: tool({
      description:
        "Recent alerts raised by saved searches, each with the pipeline run that triggered it and which fields changed.",
      inputSchema: z.object({
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      execute: async ({ unread_only, limit }) => {
        const started = Date.now();
        const query = new URLSearchParams({ limit: String(limit) });
        if (unread_only) query.set("unread", "true");
        const body = await crmFetch<{ alerts: AlertListRow[] }>(`/api/alerts?${query.toString()}`);
        if (!body) {
          note(trace, NO_STORE_NOTE);
          record(trace, "list_alerts", { unread_only, limit }, started, 0, "no CRM store attached");
          return { available: false, alerts: [] };
        }
        const rows = body.alerts;
        record(
          trace,
          "list_alerts",
          { unread_only, limit },
          started,
          rows.length,
          `${rows.length} alerts`,
        );
        return {
          available: true,
          alerts: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            property_id: row.propertyId,
            search: row.searchName,
            score: row.score,
            rationale: row.rationale,
            changed_fields: row.changedFields,
            pipeline_run_id: row.pipelineRunId,
            created_at: row.createdAt,
            read: row.readAt !== null,
          })),
        };
      },
    }),

    get_pipeline_status: tool({
      description:
        "How current the data is: the upstream pipeline's recent runs with their per-source inserted / updated / unchanged counts and any limitations declared.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
      execute: async ({ limit }) => {
        const started = Date.now();
        const [runs, info] = await Promise.all([source.listRuns(limit), source.info()]);
        trace.isSample = info.isSample;

        const latest = runs[0];
        trace.freshness = {
          run_id: latest?.runId ?? info.runId,
          finished_at: latest?.finishedAt ?? info.generatedAt,
          is_sample: info.isSample,
        };
        for (const limitation of latest?.limitations ?? []) note(trace, limitation);

        record(
          trace,
          "get_pipeline_status",
          { limit },
          started,
          runs.length,
          `${runs.length} pipeline runs, latest ${latest?.runId ?? "unknown"}`,
        );

        return {
          dataset: {
            label: info.label,
            row_count: info.rowCount,
            is_sample: info.isSample,
            pipeline_run_id: info.runId,
          },
          runs: runs.map((run) => ({
            run_id: run.runId,
            status: run.status,
            started_at: run.startedAt,
            finished_at: run.finishedAt,
            tracks: run.tracks,
            delta: runDelta(run),
            limitations: run.limitations,
            sources: run.sources.map((entry) => ({
              track: entry.track,
              source_system: entry.sourceSystem,
              inserted: entry.inserted,
              updated: entry.updated,
              unchanged: entry.unchanged,
              status: entry.status,
              limitations: entry.limitations,
            })),
          })),
        };
      },
    }),
  };
}

export const TOOL_ORDER = [
  "get_schema",
  "search_properties",
  "run_sql",
  "get_property",
  "list_saved_searches",
  "list_opportunities",
  "list_alerts",
  "get_pipeline_status",
] as const;
