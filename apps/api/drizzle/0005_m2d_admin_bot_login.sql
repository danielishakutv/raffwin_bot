CREATE TABLE "admin_login_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"step" text NOT NULL,
	"username" text,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_tickets" ADD CONSTRAINT "admin_tickets_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_flows_telegram_key" ON "admin_login_flows" USING btree ("telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_tickets_token_key" ON "admin_tickets" USING btree ("token_hash");