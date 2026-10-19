CREATE TABLE "buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"photo_url" text,
	"phone" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"quote_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"response" jsonb,
	"refused_code" text,
	"delivered_at" timestamp with time zone,
	"stuck_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"telegram_id" bigint,
	"naira_kobo" integer,
	"detail" text NOT NULL,
	"reported_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"quote_id" uuid,
	"paystack_id" bigint,
	"amount_kobo" integer NOT NULL,
	"currency" text NOT NULL,
	"paystack_status" text NOT NULL,
	"channel" text,
	"paid_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"buyer_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"naira_kobo" integer NOT NULL,
	"rate_id" uuid NOT NULL,
	"naira_per_raff_kobo" integer NOT NULL,
	"base_raffs" integer NOT NULL,
	"bonus_raffs" integer NOT NULL,
	"bonus_percent" integer NOT NULL,
	"package_label" text,
	"reference" text NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"authorization_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"credit_until" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconcile_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"seen" integer DEFAULT 0 NOT NULL,
	"recovered" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"ip_hash" text,
	"buyer_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text,
	"reference" text,
	"signature_ok" boolean NOT NULL,
	"ip_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_telegram_id_key" ON "buyers" USING btree ("telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credits_reference_key" ON "credits" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "credits_due_idx" ON "credits" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flags_reference_kind_key" ON "flags" USING btree ("reference","kind");--> statement-breakpoint
CREATE INDEX "flags_due_idx" ON "flags" USING btree ("reported_at","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_key" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_reference_key" ON "quotes" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "quotes_buyer_idx" ON "quotes" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "security_events_kind_idx" ON "security_events" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_buyer_idx" ON "sessions" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "webhook_events_reference_idx" ON "webhook_events" USING btree ("reference");--> statement-breakpoint
-- Hand-written. History is never rewritten: payments, webhook events and security events are insert-only.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER webhook_events_append_only BEFORE UPDATE OR DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON security_events FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER credits_no_delete BEFORE DELETE ON credits FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER flags_no_delete BEFORE DELETE ON flags FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_amounts CHECK (naira_kobo > 0 AND naira_per_raff_kobo > 0 AND base_raffs > 0 AND bonus_raffs >= 0 AND bonus_percent BETWEEN 0 AND 15);
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_status CHECK (status IN ('awaiting_payment', 'paid', 'late', 'mismatch', 'failed'));
--> statement-breakpoint
ALTER TABLE credits ADD CONSTRAINT credits_status CHECK (status IN ('pending', 'delivered', 'refused'));
