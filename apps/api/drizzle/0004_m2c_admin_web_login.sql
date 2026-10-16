ALTER TABLE "admin_users" ALTER COLUMN "totp_secret_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "telegram_username" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "username" text;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users" USING btree ("username") WHERE "admin_users"."username" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_telegram_username_key" ON "admin_users" USING btree ("telegram_username") WHERE "admin_users"."telegram_username" is not null;