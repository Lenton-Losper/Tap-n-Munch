-- Scheduled report configuration per restaurant.
-- One-to-many: a restaurant can have multiple schedules
-- (e.g. daily sales to owner, weekly summary to accountant).
-- Kept as a dedicated table rather than columns on restaurant_settings
-- because reporting is naturally a one-to-many domain.

CREATE TABLE IF NOT EXISTS public.report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  email text NOT NULL,
  format text NOT NULL DEFAULT 'pdf'
    CHECK (format IN ('pdf', 'csv')),
  send_time time NOT NULL DEFAULT '20:00',
  timezone text NOT NULL DEFAULT 'Africa/Windhoek',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_schedules_restaurant_id_idx
  ON public.report_schedules (restaurant_id);

ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

-- Restaurant owners can manage their own schedules.
CREATE POLICY "Owners can manage their report schedules"
  ON public.report_schedules
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.restaurants
      WHERE restaurants.id = report_schedules.restaurant_id
        AND restaurants.owner_id = auth.uid()
    )
  );
