CREATE TABLE "admin_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text NOT NULL,
	"user_agent" text,
	"ip_hash" text,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "risk_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "risk_reason" text;--> statement-breakpoint
ALTER TABLE "raffles" ADD COLUMN "draw_seed" text;--> statement-breakpoint
ALTER TABLE "admin_devices" ADD CONSTRAINT "admin_devices_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_devices_secret_key" ON "admin_devices" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "admin_devices_admin_idx" ON "admin_devices" USING btree ("admin_id","created_at");--> statement-breakpoint
-- Hand-written. A device is revoked, never removed, so the list keeps its history.
CREATE TRIGGER admin_devices_no_delete BEFORE DELETE ON admin_devices
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
ALTER TABLE admin_devices ADD CONSTRAINT admin_devices_channel CHECK (channel IN ('telegram', 'browser'));
--> statement-breakpoint
-- A winner is a ticket that was sold: the draw writes both together
ALTER TABLE raffle_prizes ADD CONSTRAINT raffle_prizes_winner_ticket CHECK ((winner_user_id IS NULL) = (winner_ticket IS NULL) AND (winner_ticket IS NULL OR winner_ticket >= 1));
