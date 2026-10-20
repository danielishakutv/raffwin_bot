-- Data reset (super admin): the guard triggers stay on for every code path,
-- except a transaction that has said, in so many words, that it is the reset
-- (SET LOCAL raffwin.data_reset = 'on', only in services/data-reset.ts).
-- The audit log and security events are never released: they outlive every reset.
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('raffwin.data_reset', true) = 'on'
     AND TG_TABLE_NAME NOT IN ('audit_log', 'security_events') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- A deleted player's prize keeps its winning ticket (the published draw proof lists it)
-- with no winner left to name: a ticket may stand alone, a winner still needs a ticket.
ALTER TABLE raffle_prizes DROP CONSTRAINT raffle_prizes_winner_ticket;
--> statement-breakpoint
ALTER TABLE raffle_prizes ADD CONSTRAINT raffle_prizes_winner_ticket CHECK ((winner_user_id IS NULL OR winner_ticket IS NOT NULL) AND (winner_ticket IS NULL OR winner_ticket >= 1));
