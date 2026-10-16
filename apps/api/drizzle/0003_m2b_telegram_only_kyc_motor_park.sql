CREATE TABLE "delivery_points" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"city" text NOT NULL,
	"motor_park" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "telegram_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kyc_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_telegram_id_key" ON "admin_users" USING btree ("telegram_id") WHERE "admin_users"."telegram_id" is not null;