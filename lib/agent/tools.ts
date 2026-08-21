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
import { displayAddress } from "@/lib/data/map";
import { runDelta } from "@/lib/data/runs";
import type { PropertyDataSource } from "@/lib/data/types";
import type { Overlay } from "@/lib/data/overlay";
import { loadOverlay } from "@/lib/crm/overlay";
import { tryDb } from "@/lib/crm/db";
import { listAlerts, listOpportunities, listSavedSearches } from "@/lib/crm/repo";
import type {
  AgentDataFreshness,
  AgentEvidenceRow,
  AgentToolCall,
} from "@/lib/oracle/agent/types";

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

export async function createToolContext(source: PropertyDataSource): Promise<ToolContext> {
  const overlay = await loadOverlay();
  return {
    source,
    overlay: overlay.overlay,
    courtDataAvailable: overlay.courtDataAvailable,
  };
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
        "Find parcels matching an acquisition criteria set. Takes the same criteria object the app's filter panel produces and returns a ranked list with a per-parcel rationale, using the same scoring the UI shows.",
      inputSchema: z.object({
        criteria: criteriaSetSchema,
        limit: z.number().int().min(1).max(50).default(15),
        orderBy: z.enum(["score", "assessed_value", "roof_age", "tenure"]).default("score"),
      }),
      execute: async ({ criteria, limit, orderBy }) => {
        const started = Date.now();
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
          fetched_at: row.property.provenance.fetchedAt,
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
          record(trace, "run_sql", { sql, limit }, started, 0, "the statement was rejected", message);
          return { error: message, rows: [], row_count: 0 };
        }
      },
    }),

    get_property: tool({
      description: "The full published record for one parcel, including every column and its provenance.",
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
              fetched_at: property.provenance.fetchedAt,
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
        if (!tryDb()) {
          note(trace, NO_STORE_NOTE);
          record(trace, "list_saved_searches", {}, started, 0, "no CRM store attached");
          return { available: false, searches: [] };
        }
        const searches = await listSavedSearches();
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
        "Opportunities the team is working, with stage, assignee, match score and owner. Use this to tell a parcel nobody has touched from one already in play.",
      inputSchema: z.object({
        stage: z
          .array(z.enum(["identified", "contacted", "negotiating", "under_contract", "closed", "dead"]))
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: async ({ stage, limit }) => {
        const started = Date.now();
        if (!tryDb()) {
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
        const rows = await listOpportunities({ stages: stage, limit });
        record(
          trace,
          "list_opportunities",
          { stage: stage ?? null, limit },
          started,
          rows.length,
          `${rows.length} opportunities`,
        );
        return {
          available: true,
          opportunities: rows.map((row) => ({
            id: row.opportunity.id,
            property_id: row.opportunity.propertyId,
            address: row.opportunity.addressLine,
            stage: row.opportunity.stage,
            match_score: row.opportunity.matchScore,
            owner_name: row.owner?.name ?? row.opportunity.ownerNameSnapshot,
            assignee: row.assignee?.name ?? null,
            asking_price: row.opportunity.askingPrice,
            offer_price: row.opportunity.offerPrice,
            next_step: row.opportunity.nextStep,
            from_search: row.searchName,
          })),
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
        if (!tryDb()) {
          note(trace, NO_STORE_NOTE);
          record(trace, "list_alerts", { unread_only, limit }, started, 0, "no CRM store attached");
          return { available: false, alerts: [] };
        }
        const rows = await listAlerts({ unreadOnly: unread_only, limit });
        record(trace, "list_alerts", { unread_only, limit }, started, rows.length, `${rows.length} alerts`);
        return {
          available: true,
          alerts: rows.map((row) => ({
            id: row.alert.id,
            kind: row.alert.kind,
            property_id: row.alert.propertyId,
            search: row.searchName,
            score: row.alert.score,
            rationale: row.alert.rationale,
            changed_fields: row.alert.changedFields,
            pipeline_run_id: row.alert.pipelineRunId,
            created_at: row.alert.createdAt,
            read: row.alert.readAt !== null,
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
