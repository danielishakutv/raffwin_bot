CREATE TABLE "finance_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raffle_id" uuid,
	"category" text NOT NULL,
	"amount_naira" integer NOT NULL,
	"spent_on" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"created_by_admin_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_admin_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raffle_prizes" ADD COLUMN "cost_naira" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_raffle_id_raffles_id_fk" FOREIGN KEY ("raffle_id") REFERENCES "raffles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_voided_by_admin_id_admin_users_id_fk" FOREIGN KEY ("voided_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_expenses_spent_idx" ON "finance_expenses" USING btree ("spent_on");--> statement-breakpoint
CREATE INDEX "finance_expenses_raffle_idx" ON "finance_expenses" USING btree ("raffle_id");--> statement-breakpoint
ALTER TABLE finance_expenses ADD CONSTRAINT finance_expenses_positive CHECK (amount_naira > 0);
--> statement-breakpoint
ALTER TABLE raffle_prizes ADD CONSTRAINT raffle_prizes_cost_nonnegative CHECK (cost_naira >= 0);
