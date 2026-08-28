-- ADR-005 §1 -- every state transition of a fulfilment line, with an actor and a timestamp.
--
-- NOT APPLIED BY THE AUTHORING AGENT. Written, committed, left for the deploy path to apply.
--
-- ============================================================================================
-- WHY AN EVENT TABLE AND NOT done_at / done_by COLUMNS ON order_lines
-- ============================================================================================
--
-- Columns were the obvious answer, and they are wrong for one specific reason: UNDO.
--
-- ADR-005 event Q asks what someone in the kitchen can break by pressing the wrong thing. A
-- kitchen screen with no undo answers that question badly -- a mis-bumped line disappears from
-- the pass and the food never gets made. So undo has to exist.
--
-- The moment undo exists, outstanding -> done -> outstanding -> done is a real sequence a real
-- line will travel on a real Tuesday. A single done_at/done_by pair records exactly one of those
-- transitions and silently overwrites the rest, which means the audit trail is wrong precisely in
-- the cases anyone would ever want to read it: the disputed ones.
--
-- So: order_lines.kitchen_state / bar_state are the DENORMALISED CURRENT VALUES, kept for query
-- speed and for the partial indexes the station screens live on. THIS TABLE IS THE TRUTH.
--
-- ============================================================================================
-- ONE EVENT PER (LINE, STATION)
-- ============================================================================================
--
-- A line routed 'both' is ONE row in order_lines carrying two independent states, so an event
-- has to say WHICH state moved. `station` is that column, and it is NOT NULL: there is no such
-- thing as a transition that belongs to no station.
--
-- A 'both' line therefore gets TWO creation events, one per station it owns, and each later bump
-- records only its own. Reading the history of a plate means filtering by station; reading
-- whether the whole plate is ready means the isLineReady predicate over the line's two columns.
--
-- ============================================================================================
-- REAL COLUMNS, NOT JSON
-- ============================================================================================
--
-- Ruled: every state transition records actor and timestamp as real columns. Not a JSONB history
-- blob on the line. The reason is the same reason order_lines exists at all -- orders.items has
-- 17 keys and not one of them is queryable as state. A JSON audit trail would reproduce that
-- defect one level down, and "who bumped this and when" is a question that gets asked under
-- pressure, by someone who needs an answer rather than a document.
--
-- ============================================================================================
-- APPEND ONLY
-- ============================================================================================
--
-- No UPDATE policy and no DELETE policy, for anyone, ever. There is no updated_at because a row
-- here does not change. An event that was recorded wrongly is corrected by recording the
-- correcting event, which is also what happened in the kitchen.
--
-- actor_user_id IS NULLABLE, and that is not laziness. A 'system' actor -- the void cascade when
-- an order is cancelled -- has no staff member behind it, and refusing that row would mean losing
-- the record of a cancellation to preserve a constraint about attribution. The FK is
-- ON DELETE SET NULL for the same reason: a staff member who leaves in November must not take
-- September's audit trail with them.

CREATE TABLE IF NOT EXISTS public.order_line_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  order_line_id uuid NOT NULL REFERENCES public.order_lines(id) ON DELETE CASCADE,

  -- WHICH station's state moved. NOT NULL -- a transition that belongs to no station does not
  -- exist. 'unrouted' is deliberately NOT a value here: an unrouted LINE is owned by both
  -- stations, so its events are recorded as 'kitchen' or 'bar' like any other.
  station text NOT NULL CHECK (station IN ('kitchen', 'bar')),

  -- NULL on the creation event -- the line came from nowhere. Not a special sentinel string,
  -- because 'created' is not a state a line can be in and putting it here would corrupt the
  -- vocabulary shared with order_lines.kitchen_state / bar_state.
  from_state text CHECK (from_state IN ('outstanding', 'done', 'voided')),

  to_state text NOT NULL CHECK (to_state IN ('outstanding', 'done', 'voided')),

  -- 'station' -- someone bumped or un-bumped at the kitchen or bar screen.
  -- 'terminal' -- the waiter's P5 created, amended or cancelled.
  -- 'system'   -- a cascade: cancelling an order voids its outstanding lines.
  actor_kind text NOT NULL CHECK (actor_kind IN ('station', 'terminal', 'system')),

  -- NULL for 'system', and nullable for the others too -- see the header. An unattributed event is
  -- still evidence that the transition happened.
  --
  -- FK TARGET CONFIRMED 2026-08-27, AND IT IS NOT staff_members.
  --
  -- The terminal PIN path resolves to a users.id and nothing else: POST /api/terminal/authorize
  -- takes a user_id, checks membership in restaurant_users, checks permission through
  -- authorize(userId, ...), and verifies the PIN against
  -- terminal_authorization_credentials.user_id -> users(id).
  --
  -- staff_members is a separate, email-keyed table that the PIN flow never touches. Pointing this
  -- column there would have created exactly the defect the earlier draft warned about: two
  -- parallel notions of "who did this", joinable to each other by nothing.
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.order_line_events IS
  'ADR-005: append-only history of every order_lines state transition, with station, actor and timestamp as real columns. This is the truth; order_lines.kitchen_state/bar_state are denormalised caches of the latest row per station. Exists rather than done_at/done_by columns because undo makes outstanding->done->outstanding a real sequence a column pair cannot record.';

COMMENT ON COLUMN public.order_line_events.station IS
  'Which of the line''s two states moved. NOT NULL -- a transition belongs to a station. A ''both'' line gets one creation event per station and each later bump records only its own.';

COMMENT ON COLUMN public.order_line_events.from_state IS
  'NULL on the creation event. Not a ''created'' sentinel -- that is not a state a line can be in, and adding it would corrupt the vocabulary shared with order_lines.kitchen_state / bar_state.';

COMMENT ON COLUMN public.order_line_events.actor_user_id IS
  'users.id -- the identity the terminal PIN flow actually produces (terminal_authorization_credentials.user_id), NOT staff_members.id. Nullable on purpose: a ''system'' cascade has no person behind it, and an unattributed event is still evidence the transition happened. ON DELETE SET NULL so someone leaving does not take the audit trail with them.';

-- The audit read: this line's history, oldest first.
CREATE INDEX IF NOT EXISTS order_line_events_line_idx
  ON public.order_line_events (order_line_id, occurred_at);

-- "What did this person do on this shift" -- the question tip disputes and bump disputes both
-- reduce to. Partial: the system rows have no actor and would only bloat it.
CREATE INDEX IF NOT EXISTS order_line_events_actor_idx
  ON public.order_line_events (restaurant_id, actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: staff with orders:read may read. Every write is service role. Nothing may update or delete.
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_line_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized staff can read order line events" ON public.order_line_events;
CREATE POLICY "Authorized staff can read order line events"
  ON public.order_line_events
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));

-- No INSERT policy: writes are service role only, alongside the line transition itself.
-- No UPDATE or DELETE policy for any role, deliberately. Append only.
