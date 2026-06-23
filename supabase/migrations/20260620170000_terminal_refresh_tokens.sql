-- Terminal two-token auth: refresh token hash storage

ALTER TABLE public.restaurant_terminals
ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT,
ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS restaurant_terminals_refresh_token_hash_idx
  ON public.restaurant_terminals (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
