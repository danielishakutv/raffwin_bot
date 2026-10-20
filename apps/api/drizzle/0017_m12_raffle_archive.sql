ALTER TABLE "raffles" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "raffles" ADD COLUMN "archived_by_admin_id" uuid;