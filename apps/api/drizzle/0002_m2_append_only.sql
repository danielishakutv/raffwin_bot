-- Append-only tables and money invariants, enforced by the database itself so
-- that no code path (or console session) can quietly rewrite history.

CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
ALTER TABLE entries ADD CONSTRAINT entries_qty_positive CHECK (qty > 0 AND raffs_spent > 0);
--> statement-breakpoint
ALTER TABLE entries ADD CONSTRAINT entries_ticket_range CHECK (ticket_from >= 1 AND ticket_to = ticket_from + qty - 1);
--> statement-breakpoint
ALTER TABLE raffles ADD CONSTRAINT raffles_within_target CHECK (entries_count >= 0 AND entries_count <= entries_target);
--> statement-breakpoint
ALTER TABLE raffles ADD CONSTRAINT raffles_positive_prices CHECK (entry_price_raffs > 0 AND entries_target > 0 AND market_price_naira >= 0);
--> statement-breakpoint
ALTER TABLE raffle_prizes ADD CONSTRAINT raffle_prizes_position CHECK (position BETWEEN 1 AND 3);
--> statement-breakpoint
ALTER TABLE rate_quotes ADD CONSTRAINT rate_quotes_positive CHECK (stars_per_raff_micro > 0 AND base_stars_per_raff_micro > 0);
--> statement-breakpoint
ALTER TABLE referral_earnings ADD CONSTRAINT referral_earnings_positive CHECK (raffs > 0);
--> statement-breakpoint
ALTER TABLE approvals ADD CONSTRAINT approvals_two_people CHECK (decided_by_admin_id IS NULL OR decided_by_admin_id <> requested_by_admin_id);
