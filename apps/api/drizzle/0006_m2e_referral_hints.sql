CREATE TABLE "referral_hints" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
