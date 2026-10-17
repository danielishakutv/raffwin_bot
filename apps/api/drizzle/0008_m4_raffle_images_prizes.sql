CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mime" text NOT NULL,
	"bytes" bytea NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raffles" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_sha256_key" ON "media" USING btree ("sha256");--> statement-breakpoint
-- Any number of prizes (1st..nth), numbered from 1; the app allows up to 20
ALTER TABLE raffle_prizes DROP CONSTRAINT raffle_prizes_position;
--> statement-breakpoint
ALTER TABLE raffle_prizes ADD CONSTRAINT raffle_prizes_position CHECK (position BETWEEN 1 AND 50);
--> statement-breakpoint
ALTER TABLE media ADD CONSTRAINT media_size CHECK (size_bytes > 0 AND size_bytes <= 500000 AND mime IN ('image/jpeg', 'image/png', 'image/webp'));
--> statement-breakpoint
-- Uploaded images are kept: a raffle that once showed one can always be explained
CREATE TRIGGER media_no_delete BEFORE DELETE ON media
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
