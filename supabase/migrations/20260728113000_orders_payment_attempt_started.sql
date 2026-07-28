ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS payment_attempt_started_at timestamptz,
ADD COLUMN IF NOT EXISTS payment_attempt_source text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_attempt_source_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_attempt_source_check
      CHECK (
        payment_attempt_source IS NULL OR
        payment_attempt_source IN ('terminal_app', 'staff_push')
      );
  END IF;
END $$;
