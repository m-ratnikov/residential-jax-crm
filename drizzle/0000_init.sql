CREATE TYPE "public"."acquisition_stage" AS ENUM('identified', 'contacted', 'negotiating', 'under_contract', 'closed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('new_match', 'updated_match', 'left_match');--> statement-breakpoint
CREATE TYPE "public"."notify_channel" AS ENUM('in_app', 'email', 'sms', 'push');--> statement-breakpoint
CREATE TYPE "public"."outreach_channel" AS ENUM('email', 'sms', 'direct_mail');--> statement-breakpoint
CREATE TYPE "public"."outreach_status" AS ENUM('queued', 'sent', 'delivered', 'opened', 'replied', 'bounced', 'returned', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"matcher_run_id" uuid,
	"kind" "alert_kind" NOT NULL,
	"property_id" text NOT NULL,
	"property_snapshot" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"rationale" text NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pipeline_run_id" text,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"opportunity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" text,
	"parcel_identifier" text,
	"case_number" text NOT NULL,
	"case_type" text NOT NULL,
	"filed_date" timestamp with time zone,
	"party_name" text,
	"amount" double precision,
	"status" text,
	"source_system" text NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matcher_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"trigger" text DEFAULT 'cron' NOT NULL,
	"pipeline_run_id" text,
	"pipeline_run_started_at" timestamp with time zone,
	"pipeline_run_is_new" boolean DEFAULT false NOT NULL,
	"data_source_kind" text,
	"data_source_location" text,
	"data_source_row_count" integer,
	"data_source_is_sample" boolean,
	"searches_evaluated" integer DEFAULT 0 NOT NULL,
	"properties_evaluated" integer DEFAULT 0 NOT NULL,
	"alerts_created" integer DEFAULT 0 NOT NULL,
	"alerts_suppressed" integer DEFAULT 0 NOT NULL,
	"notifications_sent" integer DEFAULT 0 NOT NULL,
	"detail" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel" "notify_channel" NOT NULL,
	"recipient" text,
	"status" "outreach_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"subject" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" text NOT NULL,
	"parcel_identifier" text,
	"address_line" text NOT NULL,
	"address_city" text,
	"address_zip" text,
	"latitude" double precision,
	"longitude" double precision,
	"assessed_value" double precision,
	"owner_name_snapshot" text,
	"property_snapshot" jsonb,
	"owner_id" uuid,
	"stage" "acquisition_stage" DEFAULT 'identified' NOT NULL,
	"saved_search_id" uuid,
	"alert_id" uuid,
	"match_score" double precision,
	"match_rationale" text,
	"assignee_id" uuid,
	"owner_interest" text,
	"asking_price" double precision,
	"offer_price" double precision,
	"next_step" text,
	"next_step_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outreach_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" "outreach_channel" NOT NULL,
	"template_id" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"status" "outreach_status" NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid,
	"opportunity_id" uuid NOT NULL,
	"channel" "outreach_channel" NOT NULL,
	"template_id" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"status" "outreach_status" DEFAULT 'queued' NOT NULL,
	"status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mailing_address" text,
	"mailing_city" text,
	"mailing_state" text,
	"mailing_zip" text,
	"email" text,
	"phone" text,
	"source_system" text,
	"source_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb NOT NULL,
	"owner_id" uuid,
	"notify_in_app" boolean DEFAULT true NOT NULL,
	"notify_email" boolean DEFAULT false NOT NULL,
	"notify_sms" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"alert_limit_per_run" integer DEFAULT 25 NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"last_pipeline_run_id" text,
	"last_match_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"property_id" text NOT NULL,
	"match_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" text
);
--> statement-breakpoint
CREATE TABLE "simulated_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" text NOT NULL,
	"run_id" text NOT NULL,
	"column" text NOT NULL,
	"value" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_stage" "acquisition_stage",
	"to_stage" "acquisition_stage" NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_id" uuid,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'acquisitions' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_matcher_run_id_matcher_runs_id_fk" FOREIGN KEY ("matcher_run_id") REFERENCES "public"."matcher_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_team_members_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_assignee_id_team_members_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_created_by_id_team_members_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_message_id_outreach_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."outreach_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_campaign_id_outreach_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_created_by_id_team_members_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_owner_id_team_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_matches" ADD CONSTRAINT "search_matches_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_actor_id_team_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_team_members_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_idx" ON "alerts" USING btree ("saved_search_id","property_id","matcher_run_id");--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "alerts_unread_idx" ON "alerts" USING btree ("read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "court_records_case_idx" ON "court_records" USING btree ("case_number","case_type");--> statement-breakpoint
CREATE INDEX "court_records_property_idx" ON "court_records" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "matcher_runs_started_idx" ON "matcher_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "notes_opportunity_idx" ON "notes" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "notifications_alert_idx" ON "notifications" USING btree ("alert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_property_idx" ON "opportunities" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "opportunities_assignee_idx" ON "opportunities" USING btree ("assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_events_provider_idx" ON "outreach_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "outreach_events_message_idx" ON "outreach_events" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_messages_provider_idx" ON "outreach_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "outreach_messages_opportunity_idx" ON "outreach_messages" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "owners_name_idx" ON "owners" USING btree ("name");--> statement-breakpoint
CREATE INDEX "saved_searches_active_idx" ON "saved_searches" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "search_matches_search_property_idx" ON "search_matches" USING btree ("saved_search_id","property_id");--> statement-breakpoint
CREATE INDEX "search_matches_search_idx" ON "search_matches" USING btree ("saved_search_id");--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_changes_property_column_idx" ON "simulated_changes" USING btree ("property_id","column");--> statement-breakpoint
CREATE INDEX "simulated_changes_run_idx" ON "simulated_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "stage_events_opportunity_idx" ON "stage_events" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "tasks_opportunity_idx" ON "tasks" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");