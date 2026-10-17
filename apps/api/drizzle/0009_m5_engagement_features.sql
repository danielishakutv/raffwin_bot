CREATE TABLE "admin_web_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"open_button" boolean DEFAULT true NOT NULL,
	"audience" jsonb NOT NULL,
	"status" text DEFAULT 'fanning_out' NOT NULL,
	"cursor_user_id" uuid,
	"total" integer DEFAULT 0 NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comeback_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"raffs" integer NOT NULL,
	"spell_started_at" timestamp with time zone NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"ledger_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"streak" integer NOT NULL,
	"raffs" integer NOT NULL,
	"ledger_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"note" text NOT NULL,
	"created_by_admin_id" uuid,
	"cleared_at" timestamp with time zone,
	"cleared_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"template_key" text,
	"text" text NOT NULL,
	"buttons" jsonb,
	"broadcast_id" uuid,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raffs_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"raffs" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"out_ledger_id" uuid NOT NULL,
	"in_ledger_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "channel" text DEFAULT 'telegram' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminders_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "next_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminders_since_open" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_web_logins" ADD CONSTRAINT "admin_web_logins_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comeback_offers" ADD CONSTRAINT "comeback_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comeback_offers" ADD CONSTRAINT "comeback_offers_ledger_id_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_checkins" ADD CONSTRAINT "daily_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_checkins" ADD CONSTRAINT "daily_checkins_ledger_id_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_cleared_by_admin_id_admin_users_id_fk" FOREIGN KEY ("cleared_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffs_transfers" ADD CONSTRAINT "raffs_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffs_transfers" ADD CONSTRAINT "raffs_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffs_transfers" ADD CONSTRAINT "raffs_transfers_out_ledger_id_ledger_id_fk" FOREIGN KEY ("out_ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffs_transfers" ADD CONSTRAINT "raffs_transfers_in_ledger_id_ledger_id_fk" FOREIGN KEY ("in_ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_web_logins_admin_idx" ON "admin_web_logins" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comeback_offers_spell_key" ON "comeback_offers" USING btree ("user_id","spell_started_at");--> statement-breakpoint
CREATE INDEX "comeback_offers_user_idx" ON "comeback_offers" USING btree ("user_id","offered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_checkins_user_day_key" ON "daily_checkins" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_overrides_live_key" ON "feature_flag_overrides" USING btree ("flag_key","user_id") WHERE "feature_flag_overrides"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "feature_flag_overrides_user_idx" ON "feature_flag_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_broadcast_idx" ON "notifications" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "raffs_transfers_idempotency_key" ON "raffs_transfers" USING btree ("from_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "raffs_transfers_from_idx" ON "raffs_transfers" USING btree ("from_user_id","created_at");--> statement-breakpoint
CREATE INDEX "raffs_transfers_to_idx" ON "raffs_transfers" USING btree ("to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "users_next_reminder_idx" ON "users" USING btree ("next_reminder_at") WHERE "users"."next_reminder_at" is not null;--> statement-breakpoint
CREATE INDEX "users_last_seen_idx" ON "users" USING btree ("last_seen_at");--> statement-breakpoint
-- Hand-written below: rules the schema file cannot express
ALTER TABLE raffs_transfers ADD CONSTRAINT raffs_transfers_valid CHECK (raffs > 0 AND from_user_id <> to_user_id);
--> statement-breakpoint
ALTER TABLE daily_checkins ADD CONSTRAINT daily_checkins_valid CHECK (streak >= 1 AND raffs >= 0);
--> statement-breakpoint
-- "max 1 Raff" (owner, 17 Oct): a come-back offer is never worth more than one Raff
ALTER TABLE comeback_offers ADD CONSTRAINT comeback_offers_valid CHECK (raffs BETWEEN 1 AND 1);
--> statement-breakpoint
ALTER TABLE notifications ADD CONSTRAINT notifications_attempts CHECK (attempts >= 0);
--> statement-breakpoint
-- Money movements and claims are insert-only, like the ledger
CREATE TRIGGER raffs_transfers_append_only BEFORE UPDATE OR DELETE ON raffs_transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER daily_checkins_append_only BEFORE UPDATE OR DELETE ON daily_checkins
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
-- History the admin reads is never removed (rows may still be updated: status, cleared_at, claimed_at)
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER broadcasts_no_delete BEFORE DELETE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER comeback_offers_no_delete BEFORE DELETE ON comeback_offers
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER feature_flag_overrides_no_delete BEFORE DELETE ON feature_flag_overrides
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
-- Existing players get their first reminder 6-10 h after their last open; anyone
-- already past that is spread over the next two hours instead of all at once.
-- Only players whose last open is inside one reminder spell (8 reminders x 10 h,
-- the defaults) get a schedule: anyone away longer would have had all 8 by now,
-- so they get none here, only the single come-back offer, and their next open
-- starts the schedule again (services/engagement.ts)
UPDATE users
   SET next_reminder_at = greatest(
         coalesce(last_seen_at, created_at) + (6 + random() * 4) * interval '1 hour',
         now() + random() * interval '2 hours')
 WHERE status = 'active'
   AND coalesce(last_seen_at, created_at) > now() - interval '80 hours';
