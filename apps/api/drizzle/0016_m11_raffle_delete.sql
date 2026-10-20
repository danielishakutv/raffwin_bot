ALTER TABLE "raffles" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raffles" ADD COLUMN "deleted_by_admin_id" uuid;--> statement-breakpoint
-- "Delete" in the admin only ever sets deleted_at: a raffle row is history (entries, refunds, winners point at it)
CREATE TRIGGER raffles_no_delete BEFORE DELETE ON raffles
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
