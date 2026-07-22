-- Distinguishes system auto-cancellation (e.g. 'auto_timeout' for abandoned Sale-tab/terminal
-- POS orders) from staff-initiated declines, which leave this null. Nullable, additive only.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
