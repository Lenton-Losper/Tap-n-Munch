-- payment_events: allow NULL initiated_by for sale events (no PIN-verified human actor).

ALTER TABLE public.payment_events
  ALTER COLUMN initiated_by DROP NOT NULL;

-- initiated_by is populated for refund_attempted/refund_succeeded/refund_failed (the manager
-- who authorized it, via privileged_authorization_tokens). It is intentionally NULL for 'sale'
-- events, which have no PIN-verified actor -- terminal_id is the relevant identity for those.
