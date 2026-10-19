CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"quote_id" uuid NOT NULL,
	"naira_kobo" integer NOT NULL,
	"rate_id" uuid NOT NULL,
	"naira_per_raff_kobo" integer NOT NULL,
	"base_raffs" integer NOT NULL,
	"bonus_raffs" integer NOT NULL,
	"raffs" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"ledger_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_quotes" ALTER COLUMN "stars_per_raff_micro" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_quotes" ALTER COLUMN "base_stars_per_raff_micro" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_quotes" ADD COLUMN "base_naira_per_raff_kobo" integer;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_rate_id_rate_quotes_id_fk" FOREIGN KEY ("rate_id") REFERENCES "rate_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_ledger_id_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_reference_key" ON "purchases" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "purchases_user_idx" ON "purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "purchases_created_idx" ON "purchases" USING btree ("created_at");--> statement-breakpoint
CREATE TRIGGER purchases_append_only BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
ALTER TABLE purchases ADD CONSTRAINT purchases_amounts CHECK (naira_kobo > 0 AND naira_per_raff_kobo > 0 AND base_raffs > 0 AND bonus_raffs >= 0 AND raffs = base_raffs + bonus_raffs);
--> statement-breakpoint
ALTER TABLE purchases ADD CONSTRAINT purchases_source CHECK (source IN ('paystack'));
--> statement-breakpoint
ALTER TABLE rate_quotes ADD CONSTRAINT rate_quotes_naira_positive CHECK (naira_per_raff_kobo > 0 AND (base_naira_per_raff_kobo IS NULL OR base_naira_per_raff_kobo > 0));
