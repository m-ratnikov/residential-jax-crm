/**
 * The CRM store.
 *
 * What is here and what is deliberately not here is the whole design. Property
 * records are NOT here: 404,023 parcels stay in the published parquet and are
 * read with DuckDB. Postgres holds only what a team creates - saved searches,
 * alerts, opportunities, outreach, tasks - which is thousands of rows, not
 * hundreds of thousands. That is what makes "no ongoing hosted-database cost
 * beyond the existing pipeline + DuckDB / IPFS pattern" true rather than
 * aspirational.
 *
 * Where a property is referenced, the parcel id is stored alongside a small
 * snapshot of the fields worth showing in a list (address, owner, value at the
 * time). The snapshot is not a cache to query against - every search still hits
 * the parquet - it is there so an opportunity created six months ago still
 * renders if the parcel later leaves the roll, and so an alert can show what
 * the record looked like when it fired.
 */

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Enumerations                                                         */
/* ------------------------------------------------------------------ */

export const acquisitionStageEnum = pgEnum("acquisition_stage", [
  "identified",
  "contacted",
  "negotiating",
  "under_contract",
  "closed",
  "dead",
]);

export const outreachChannelEnum = pgEnum("outreach_channel", ["email", "sms", "direct_mail"]);

/**
 * The simulated message lifecycle. Ordered from earliest to latest so a status
 * regression can be rejected: a delivered message cannot go back to queued.
 * `returned` is the direct-mail equivalent of `bounced`.
 */
export const outreachStatusEnum = pgEnum("outreach_status", [
  "queued",
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "returned",
  "failed",
]);

export const alertKindEnum = pgEnum("alert_kind", ["new_match", "updated_match", "left_match"]);

export const taskStatusEnum = pgEnum("task_status", ["open", "done", "cancelled"]);

export const notifyChannelEnum = pgEnum("notify_channel", ["in_app", "email", "sms", "push"]);

/* ------------------------------------------------------------------ */
/* Team                                                                 */
/* ------------------------------------------------------------------ */

export const teamMembers = pgTable("team_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("acquisitions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Saved searches                                                       */
/* ------------------------------------------------------------------ */

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    /** A CriteriaSet, validated by zod on the way in and on the way out. */
    criteria: jsonb("criteria").notNull(),
    ownerId: uuid("owner_id").references(() => teamMembers.id, { onDelete: "set null" }),

    notifyInApp: boolean("notify_in_app").notNull().default(true),
    notifyEmail: boolean("notify_email").notNull().default(false),
    notifySms: boolean("notify_sms").notNull().default(false),
    /** Off means the matcher skips it entirely; the search still runs on demand. */
    active: boolean("active").notNull().default(true),

    /**
     * Do not raise more than this many alerts for one search in one matcher
     * pass. A criteria set that matches forty thousand parcels is a legitimate
     * thing to save and a terrible thing to be notified about one row at a
     * time; the pass records how many it suppressed.
     */
    alertLimitPerRun: integer("alert_limit_per_run").notNull().default(25),

    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** The pipeline run this search was last evaluated against. */
    lastPipelineRunId: text("last_pipeline_run_id"),
    lastMatchCount: integer("last_match_count"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("saved_searches_active_idx").on(table.active)],
);

/**
 * What the matcher saw last time, one row per (search, property). This is the
 * snapshot half of the diff: without it the matcher cannot tell a parcel that
 * is new to a search from one it alerted on yesterday.
 */
export const searchMatches = pgTable(
  "search_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    savedSearchId: uuid("saved_search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    /** Fingerprint of the material fields, from matchHashOf(). */
    matchHash: text("match_hash").notNull(),
    /** The material field values behind that hash, so a diff can name them. */
    snapshot: jsonb("snapshot").notNull(),
    score: doublePrecision("score").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** The pipeline run in which this property was last observed matching. */
    lastRunId: text("last_run_id"),
  },
  (table) => [
    uniqueIndex("search_matches_search_property_idx").on(table.savedSearchId, table.propertyId),
    index("search_matches_search_idx").on(table.savedSearchId),
  ],
);

/* ------------------------------------------------------------------ */
/* Matcher evidence                                                     */
/* ------------------------------------------------------------------ */

/**
 * One immutable record per matcher pass, whether or not it raised anything.
 * A notification history that only records the passes that fired cannot answer
 * "why did nothing arrive last night", which is the question actually asked.
 */
export const matcherRuns = pgTable(
  "matcher_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** How this pass was started: cron, manual, or the demo simulation. */
    trigger: text("trigger").notNull().default("cron"),
    /** The upstream pipeline run this pass evaluated against. */
    pipelineRunId: text("pipeline_run_id"),
    pipelineRunStartedAt: timestamp("pipeline_run_started_at", { withTimezone: true }),
    /** Whether the upstream run was new to the CRM since the previous pass. */
    pipelineRunIsNew: boolean("pipeline_run_is_new").notNull().default(false),

    dataSourceKind: text("data_source_kind"),
    dataSourceLocation: text("data_source_location"),
    dataSourceRowCount: integer("data_source_row_count"),
    dataSourceIsSample: boolean("data_source_is_sample"),

    searchesEvaluated: integer("searches_evaluated").notNull().default(0),
    propertiesEvaluated: integer("properties_evaluated").notNull().default(0),
    alertsCreated: integer("alerts_created").notNull().default(0),
    alertsSuppressed: integer("alerts_suppressed").notNull().default(0),
    notificationsSent: integer("notifications_sent").notNull().default(0),

    /** Per search counts and the upstream track deltas, for the evidence page. */
    detail: jsonb("detail"),
    error: text("error"),
  },
  (table) => [index("matcher_runs_started_idx").on(table.startedAt)],
);

/* ------------------------------------------------------------------ */
/* Alerts                                                               */
/* ------------------------------------------------------------------ */

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    savedSearchId: uuid("saved_search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    matcherRunId: uuid("matcher_run_id").references(() => matcherRuns.id, { onDelete: "set null" }),

    kind: alertKindEnum("kind").notNull(),
    propertyId: text("property_id").notNull(),
    /** What the parcel looked like when the alert fired. */
    propertySnapshot: jsonb("property_snapshot").notNull(),
    score: doublePrecision("score").notNull(),
    rationale: text("rationale").notNull(),
    /** Material fields that moved. Empty for a new match. */
    changedFields: jsonb("changed_fields").notNull().default([]),

    /** The upstream pipeline run that produced the data behind this alert. */
    pipelineRunId: text("pipeline_run_id"),

    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** Set when the alert has been turned into an opportunity. */
    opportunityId: uuid("opportunity_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One alert per search, property and matcher pass. The matcher is safe to
    // re-run: a retry after a timeout must not double notify.
    uniqueIndex("alerts_dedupe_idx").on(table.savedSearchId, table.propertyId, table.matcherRunId),
    index("alerts_created_idx").on(table.createdAt),
    index("alerts_unread_idx").on(table.readAt),
  ],
);

/**
 * A notification is the delivery of an alert down one channel. Separating it
 * from the alert is what lets the same alert appear in-app immediately and as a
 * mocked email a moment later, each with its own status.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    channel: notifyChannelEnum("channel").notNull(),
    recipient: text("recipient"),
    status: outreachStatusEnum("status").notNull().default("queued"),
    /** Provider's id for the simulated send, used to correlate status events. */
    providerMessageId: text("provider_message_id"),
    subject: text("subject"),
    body: text("body"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notifications_alert_idx").on(table.alertId)],
);

/* ------------------------------------------------------------------ */
/* Owners and opportunities                                             */
/* ------------------------------------------------------------------ */

export const owners = pgTable(
  "owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owner of record, as published on the roll. */
    name: text("name").notNull(),
    mailingAddress: text("mailing_address"),
    mailingCity: text("mailing_city"),
    mailingState: text("mailing_state"),
    mailingZip: text("mailing_zip"),
    /** Contact details a team adds by hand. Never from the county roll. */
    email: text("email"),
    phone: text("phone"),
    /** Where the owner of record came from, kept for provenance. */
    sourceSystem: text("source_system"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("owners_name_idx").on(table.name)],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: text("property_id").notNull(),
    parcelIdentifier: text("parcel_identifier"),

    /** List-view snapshot, taken when the opportunity was created. */
    addressLine: text("address_line").notNull(),
    addressCity: text("address_city"),
    addressZip: text("address_zip"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    assessedValue: doublePrecision("assessed_value"),
    ownerNameSnapshot: text("owner_name_snapshot"),
    propertySnapshot: jsonb("property_snapshot"),

    ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "set null" }),
    stage: acquisitionStageEnum("stage").notNull().default("identified"),

    /** Why this parcel is here: the search that surfaced it and how well it fit. */
    savedSearchId: uuid("saved_search_id").references(() => savedSearches.id, {
      onDelete: "set null",
    }),
    alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "set null" }),
    matchScore: doublePrecision("match_score"),
    matchRationale: text("match_rationale"),

    assigneeId: uuid("assignee_id").references(() => teamMembers.id, { onDelete: "set null" }),
    ownerInterest: text("owner_interest"),
    askingPrice: doublePrecision("asking_price"),
    offerPrice: doublePrecision("offer_price"),
    nextStep: text("next_step"),
    nextStepDueAt: timestamp("next_step_due_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    // One live opportunity per parcel. Two analysts working the same list must
    // not create two records for the same house.
    uniqueIndex("opportunities_property_idx").on(table.propertyId),
    index("opportunities_stage_idx").on(table.stage),
    index("opportunities_assignee_idx").on(table.assigneeId),
  ],
);

export const stageEvents = pgTable(
  "stage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    fromStage: acquisitionStageEnum("from_stage"),
    toStage: acquisitionStageEnum("to_stage").notNull(),
    actorId: uuid("actor_id").references(() => teamMembers.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("stage_events_opportunity_idx").on(table.opportunityId)],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => teamMembers.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notes_opportunity_idx").on(table.opportunityId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    assigneeId: uuid("assignee_id").references(() => teamMembers.id, { onDelete: "set null" }),
    status: taskStatusEnum("status").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tasks_opportunity_idx").on(table.opportunityId),
    index("tasks_assignee_idx").on(table.assigneeId),
  ],
);

/* ------------------------------------------------------------------ */
/* Mocked outreach                                                      */
/* ------------------------------------------------------------------ */

/**
 * A batch of mocked messages sent together, so "I launched a campaign" is one
 * object rather than a loose set of sends.
 */
export const outreachCampaigns = pgTable("outreach_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  channel: outreachChannelEnum("channel").notNull(),
  templateId: text("template_id").notNull(),
  createdById: uuid("created_by_id").references(() => teamMembers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => outreachCampaigns.id, {
      onDelete: "set null",
    }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    channel: outreachChannelEnum("channel").notNull(),
    templateId: text("template_id").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),

    /**
     * The simulated provider's own id. Every status event carries it, and the
     * correlation from provider id back to this row is the same shape a real
     * provider adapter would need.
     */
    providerMessageId: text("provider_message_id").notNull(),
    status: outreachStatusEnum("status").notNull().default("queued"),
    statusAt: timestamp("status_at", { withTimezone: true }).notNull().defaultNow(),

    createdById: uuid("created_by_id").references(() => teamMembers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("outreach_messages_provider_idx").on(table.providerMessageId),
    index("outreach_messages_opportunity_idx").on(table.opportunityId),
  ],
);

/**
 * Normalised provider feedback. Written idempotently on `providerEventId`, so
 * a redelivered webhook cannot advance a lifecycle twice - the shape the kit's
 * communication-activity guidance calls for, with the provider replaced by a
 * simulator.
 */
export const outreachEvents = pgTable(
  "outreach_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => outreachMessages.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id").notNull(),
    status: outreachStatusEnum("status").notNull(),
    detail: text("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("outreach_events_provider_idx").on(table.providerEventId),
    index("outreach_events_message_idx").on(table.messageId),
  ],
);

/* ------------------------------------------------------------------ */
/* Simulated pipeline updates                                           */
/* ------------------------------------------------------------------ */

/**
 * A property change that did not come from the county roll.
 *
 * The assignment asks for a demonstration of a new or changed property matching
 * saved criteria. Rather than fake the notification, the demo writes a real row
 * here - a reassessment, a roof permit, an owner change - and the matcher picks
 * it up through exactly the same diff a real county refresh goes through.
 *
 * Every row carries the synthetic run id it belongs to, and every surface that
 * shows an affected parcel says the value is simulated. Deleting the rows
 * restores the published values with no other cleanup.
 */
export const simulatedChanges = pgTable(
  "simulated_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: text("property_id").notNull(),
    /** Synthetic pipeline run id. Always prefixed `sim-` so it cannot be confused with a real one. */
    runId: text("run_id").notNull(),
    /** Column name to override, restricted to OVERRIDABLE_COLUMNS at the API boundary. */
    column: text("column").notNull(),
    /** Serialised value; cast to the column's type when the overlay is built. */
    value: text("value"),
    /** What a reader should be told this represents, e.g. "roof permit pulled". */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("simulated_changes_property_column_idx").on(table.propertyId, table.column),
    index("simulated_changes_run_idx").on(table.runId),
  ],
);

/* ------------------------------------------------------------------ */
/* Court records                                                        */
/* ------------------------------------------------------------------ */

/**
 * Court-derived distress signals, when a source is loaded. Kept in Postgres
 * rather than in the parquet because unlike the appraisal roll these arrive
 * continuously and are small.
 */
export const courtRecords = pgTable(
  "court_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: text("property_id"),
    parcelIdentifier: text("parcel_identifier"),
    caseNumber: text("case_number").notNull(),
    caseType: text("case_type").notNull(),
    filedDate: timestamp("filed_date", { withTimezone: true }),
    partyName: text("party_name"),
    amount: doublePrecision("amount"),
    status: text("status"),
    sourceSystem: text("source_system").notNull(),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("court_records_case_idx").on(table.caseNumber, table.caseType),
    index("court_records_property_idx").on(table.propertyId),
  ],
);
