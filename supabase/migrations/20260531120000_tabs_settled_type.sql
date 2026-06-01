-- Tab settlement source: card_payment (CHARGE TAB) vs manual_close (CLOSE TABLE)
ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS settled_type text DEFAULT NULL;
