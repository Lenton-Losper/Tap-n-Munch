-- Ensure staff dashboard Realtime receives INSERT/UPDATE events for kitchen queues.
-- Idempotent: only ADD TABLE when not already in supabase_realtime.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'order_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_requests;
  END IF;
END $$;
