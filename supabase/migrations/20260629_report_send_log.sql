-- Durable log of every scheduled report send attempt.
-- One row per attempt — never updated, only inserted.
-- Provides observability for debugging, support, and future "resend" features.

-- Add last_sent_at to report_schedules for deduplication
ALTER TABLE public.report_schedules
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

-- Log table
CREATE TABLE IF NOT EXISTS public.report_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.report_schedules(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  report_period date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_send_log_schedule_id_idx
  ON public.report_send_log (schedule_id);

CREATE INDEX IF NOT EXISTS report_send_log_restaurant_id_idx
  ON public.report_send_log (restaurant_id);

ALTER TABLE public.report_send_log ENABLE ROW LEVEL SECURITY;

-- Restaurant owners can read their own send logs.
CREATE POLICY "Owners can read their report send logs"
  ON public.report_send_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.restaurants
      WHERE restaurants.id = report_send_log.restaurant_id
        AND restaurants.owner_id = auth.uid()
    )
  );
