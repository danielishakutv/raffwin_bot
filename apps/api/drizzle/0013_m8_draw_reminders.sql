CREATE TABLE "raffle_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raffle_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"entrants_told" integer,
	"broadcast_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raffle_reminders" ADD CONSTRAINT "raffle_reminders_raffle_id_raffles_id_fk" FOREIGN KEY ("raffle_id") REFERENCES "raffles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raffle_reminders" ADD CONSTRAINT "raffle_reminders_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "raffle_reminders_once_key" ON "raffle_reminders" USING btree ("raffle_id","stage","deadline");--> statement-breakpoint
ALTER TABLE raffle_reminders ADD CONSTRAINT raffle_reminders_stage CHECK (stage IN (60, 30, 5));
