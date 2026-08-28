-- ADR-005 §5 -- put order_lines and order_line_events on the realtime publication.
--
-- ============================================================================================
-- THE GAP THIS CLOSES, AND WHY IT WAS INVISIBLE
-- ============================================================================================
--
-- ADR-005 §5 promises the station screens reuse #350's realtime handling -- connection state,
-- refetch on reconnect, visibility listener, 60s polling FALLBACK. The word doing the work there
-- is "fallback": the poll exists to cover a dropped socket, not to be the transport.
--
-- `orders` and `order_requests` were added to `supabase_realtime` by 20260726110000.
-- order_lines and order_line_events never were, because they did not exist yet. So a station
-- screen subscribing to them received NOTHING, silently -- no error, no failed subscription, just
-- a channel that never fires -- and every update arrived on the 60s poll instead.
--
-- That is the difference between a kitchen seeing a new ticket when it is rung up and seeing it up
-- to a minute later. On a busy pass a minute is a table's whole starter course.
--
-- NOTHING IN THE APPLICATION REPORTS THIS. A Postgres publication that omits a table is not an
-- error condition; the subscriber simply waits. It was found by reading pg_publication_tables on
-- staging, which is the only place the truth lives.
--
-- ============================================================================================
-- BOTH TABLES, NOT JUST order_lines
-- ============================================================================================
--
-- order_lines carries the denormalised current state and is what a screen renders. But a screen
-- that wants to show WHO bumped a line, or to reconcile an undo it did not initiate, reads
-- order_line_events. Adding one and not the other would leave the audit surface on the poll while
-- the state surface was live, and the two would visibly disagree for up to a minute.
--
-- ============================================================================================
-- IDEMPOTENT, BECAUSE ALTER PUBLICATION ... ADD TABLE IS NOT
-- ============================================================================================
--
-- Re-adding a table already in a publication is an ERROR, not a no-op, so this follows
-- 20260726110000 exactly: check pg_publication_tables first. That makes the migration safe to
-- re-run against an environment where a human already added the table by hand -- which is exactly
-- how staging and production drift apart in this repo.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'order_lines'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_lines;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'order_line_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_line_events;
  END IF;
END $$;

-- REPLICA IDENTITY FULL on order_lines, and this is not optional for the station screens.
--
-- The default (REPLICA IDENTITY DEFAULT) sends only the primary key in the OLD image of an UPDATE.
-- A screen receiving a bump would therefore see the new row but could not tell WHICH state
-- changed -- kitchen or bar -- without re-reading. For a 'both' line, where the whole point is
-- that the two states move independently, that is the one fact the event has to carry.
--
-- order_line_events is append-only: it only ever emits INSERTs, whose payload is complete, so it
-- does not need this.
ALTER TABLE public.order_lines REPLICA IDENTITY FULL;
