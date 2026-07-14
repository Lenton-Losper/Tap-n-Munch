-- orders.paycloud_transaction_id and orders.payment_trans_no are written by
-- app/api/payments/reconcile/route.ts and lib/supabase/apply-tab-settlement.ts
-- (buildWebhookPaidPatch / buildWebhookTerminalPaidPatch) but were never
-- committed in a migration (#24) — these UPDATEs fail today wherever these
-- columns don't already exist as uncommitted drift.
--
-- orders.updated_at is also missing: markPaidAndAcceptPatch/
-- markPaidAndCompletedPatch (the same webhook patch builders) always include
-- it, so without this column the UPDATE fails regardless of the two columns
-- above. orders never had updated_at in any committed migration (baseline
-- included) — adding it here since it's required for this exact code path
-- to work at all.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paycloud_transaction_id text,
  ADD COLUMN IF NOT EXISTS payment_trans_no text,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
