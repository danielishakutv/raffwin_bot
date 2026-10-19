CREATE TABLE "voucher_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"value_raffs" integer NOT NULL,
	"code_count" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"approval_id" uuid,
	"requested_by_admin_id" uuid NOT NULL,
	"codes_issued_at" timestamp with time zone,
	"codes_issued_by_admin_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_admin_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_tail" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"redeemed_by_user_id" uuid,
	"redeemed_at" timestamp with time zone,
	"ledger_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_requested_by_admin_id_admin_users_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_codes_issued_by_admin_id_admin_users_id_fk" FOREIGN KEY ("codes_issued_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_batches" ADD CONSTRAINT "voucher_batches_voided_by_admin_id_admin_users_id_fk" FOREIGN KEY ("voided_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_id_voucher_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "voucher_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_ledger_id_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_voided_by_admin_id_admin_users_id_fk" FOREIGN KEY ("voided_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_batches_created_idx" ON "voucher_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_code_hash_key" ON "vouchers" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "vouchers_batch_idx" ON "vouchers" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "vouchers_redeemed_by_idx" ON "vouchers" USING btree ("redeemed_by_user_id");--> statement-breakpoint
ALTER TABLE voucher_batches ADD CONSTRAINT voucher_batches_amounts CHECK (value_raffs > 0 AND code_count > 0 AND code_count <= 5000);
--> statement-breakpoint
ALTER TABLE vouchers ADD CONSTRAINT vouchers_status CHECK (status IN ('active', 'redeemed', 'void'));
--> statement-breakpoint
ALTER TABLE vouchers ADD CONSTRAINT vouchers_redeemed_complete CHECK ((status = 'redeemed') = (redeemed_by_user_id IS NOT NULL AND redeemed_at IS NOT NULL AND ledger_id IS NOT NULL));
--> statement-breakpoint
-- Hand-written. Batches and codes are voided, never removed, so redemptions keep their history.
CREATE TRIGGER voucher_batches_no_delete BEFORE DELETE ON voucher_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER vouchers_no_delete BEFORE DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
