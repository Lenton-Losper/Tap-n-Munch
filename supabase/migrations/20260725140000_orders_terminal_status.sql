-- orders.terminal_status has been referenced by application code since
-- 2026-05-05 (commit 96ad220) but was never actually created by any
-- migration -- an unfinished feature, not a dropped/regressed column.
-- Confirmed intended value set from push-to-terminal/route.ts (the only
-- writer): 'pending' when a payment is pushed to the terminal, 'failed'
-- on error. Success is tracked separately via the pre-existing
-- orders.payment_status = 'paid' (set by the PayCloud webhook), which
-- orders-dashboard.tsx's polling checks first -- terminal_status itself
-- never needs a third "success" value.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS terminal_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_terminal_status_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_terminal_status_check
      CHECK (terminal_status IS NULL OR terminal_status IN ('pending', 'failed'));
  END IF;
END $$;
