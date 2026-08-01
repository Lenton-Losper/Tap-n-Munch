-- When the current card attempt was pushed to the terminal.
--
-- Cash settlement refuses an order whose card payment is genuinely in flight, but
-- 'terminal_pending' on its own says only THAT a push happened, never WHEN. Without an
-- explicit start time a stuck or abandoned attempt blocks cash for that order forever, which
-- is precisely the situation staff need a way out of. This column is what the timeout is
-- measured from.
--
-- Deliberately its own column rather than reusing a general updated_at: orders has no
-- updated_at at all, and a general one would be moved by any unrelated write, silently
-- extending or shortening the window.
--
-- NULL means "no push recorded". Rows that predate this migration are treated as expired
-- rather than in-flight -- they were necessarily pushed before this code shipped, so they are
-- older than any timeout, and treating them as in-flight would strand them permanently.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS terminal_pushed_at timestamptz;

COMMENT ON COLUMN public.orders.terminal_pushed_at IS
  'When the current card attempt was pushed to the terminal. Set on push, cleared when the '
  'attempt resolves or is released. Cash settlement is blocked while this is recent and '
  'payment_status is terminal_pending.';

-- Supports the in-flight lookup on the settle and terminal tables paths.
CREATE INDEX IF NOT EXISTS orders_terminal_pushed_at_idx
  ON public.orders (terminal_pushed_at)
  WHERE terminal_pushed_at IS NOT NULL;
