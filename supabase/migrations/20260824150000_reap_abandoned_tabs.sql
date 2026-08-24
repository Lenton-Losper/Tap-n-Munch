-- @env: both
--
-- #333 — AN ABANDONED TAB HOLDS THE TABLE FOREVER.
--
-- WHAT #333 GETS WRONG, and it changes the design. The issue says "There is no expiry, no TTL, and
-- no reaper." Two of those three are false. `issueSessionToken` (lib/session-token.ts) sets
-- `customer_sessions.expires_at = now() + 24h`, and `validateSessionToken` enforces it --
-- "Session has expired" -- on all nine token-guarded routes, POST /api/orders among them. So a
-- customer's ABILITY TO ORDER already ends on its own. Measured on staging 2026-08-24: 8 session
-- rows sit past `expires_at` on tabs that are still open.
--
-- What never ends is the TAB and the TABLE:
--   * `tabs.status` stays 'open' forever, so `idx_tabs_one_open_per_table` keeps rejecting a new
--     tab at that table. The next customer to scan is routed down the 23505 branch in
--     app/api/tabs/route.ts, which hands over the EXISTING tab with a fresh session token and no
--     PIN check. #211's 12h landing cutoff hides that tab from the UI; it does not stop the insert
--     from colliding.
--   * `restaurant_tables.status` stays 'occupied', which is what
--     app/api/terminal/tables/route.ts filters the payment terminal's table list on.
--   * `current_session_version` is never bumped, so the boundary every read filter depends on
--     never moves.
--
-- So this reaps TABS. It is not a session expiry -- that already exists.
--
-- ============================================================================================
-- WHAT IT REFUSES TO DO, and why that is the whole point
-- ============================================================================================
--
-- `close_table_session` settles tabs with `settled_type = 'manual_close'`. That value means a
-- human closed the table. Writing it from a cron would put a fabricated settlement in the record,
-- and on a tab that still owes money it would state that money was collected when nobody
-- collected anything. Measured on staging: 4 of the 10 open tabs carry unpaid orders (N$240).
--
-- Therefore:
--   * a tab that owes money is NEVER reaped. It is left exactly as it is and an audit row is
--     written so staff can see it. Surface first, block second -- the same posture as #146.
--   * a tab with a request still awaiting staff review is NEVER reaped. Someone is waiting.
--   * what IS reaped settles as `settled_type = 'abandoned'`, never 'manual_close', so no record
--     ever claims a person did this.
--
-- Both guards live INSIDE this function, not in the caller's WHERE clause. The cron re-checks
-- nothing and can skip nothing: if it names a tab that owes money, the answer is a refusal. A
-- selection bug upstream cannot turn into a fabricated settlement. Same reason
-- return_transfer_stock_to_source is shared by both transfer exits (#335) -- the omission has to
-- be unexpressible, not merely remembered.
--
-- The audit row is written in the same statement block as the reap, so a tab cannot be closed
-- without its record existing.
--
-- ============================================================================================
-- THE ACTIVITY SIGNAL, stated plainly, INCLUDING WHAT IT CANNOT SEE
-- ============================================================================================
--
-- Inactivity is measured as the newest of every timestamp that evidences ANYTHING happening on
-- the tab:
--     tabs.created_at, tabs.ready_to_pay_at
--     orders.placed_at / accepted_at / preparing_at / ready_at / completed_at / paid_at
--     order_requests.placed_at / decided_at
--     customer_sessions.created_at   (a token is issued per scan, so this is "someone scanned")
--
-- STAFF timestamps are deliberately included alongside customer ones. The question this answers is
-- not "is the customer engaged", it is "is there any evidence this table is still in use". Every
-- extra signal can only make the tab look MORE alive, so including them can only reduce reaping.
-- That is the safe direction for a destructive-ish action.
--
-- THE GAP, named rather than papered over: BROWSING IS INVISIBLE. Opening the menu, scrolling it,
-- adding to a cart and not submitting -- none of it is recorded anywhere. A party that scans, reads
-- for four hours and orders nothing is indistinguishable from a party that left.
--
-- `customer_sessions.last_seen_at` exists and is exactly the column that would close that gap. It
-- is NOT usable today: nothing in the codebase ever writes it (every `last_seen_at` hit in app code
-- is the `restaurant_terminals` table), so it is frozen at its insert default. Verified on staging
-- 2026-08-24: 0 of 8 session rows on open tabs differ from their own `created_at`. It looks like an
-- activity signal and is not one. Making it real means touching it on customer reads, which is a
-- write on a read path and its own decision -- not smuggled in here.
--
-- Four hours is chosen against that blind spot, not against a measurement of real diners: it is
-- long enough that a table sitting idle that long with no order, no scan and no staff action is
-- abandoned under any reading, and every doubtful case is protected by the money guard anyway.
--
-- Forward-only and additive: one new function and one replaced-by-addition vocabulary value that
-- has no CHECK constraint to widen. Rolling back means dropping the function; nothing else reads
-- it. `settled_type = 'abandoned'` falls into the same branch 'manual_close' already falls into
-- everywhere it is read -- lib/tab-session.ts only discriminates 'card_payment' -- so no customer
-- screen changes behaviour.

CREATE OR REPLACE FUNCTION "public"."reap_abandoned_tab"(p_tab_id uuid, p_inactive_hours integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tab           public.tabs%ROWTYPE;
    v_last_activity timestamptz;
    v_cutoff        timestamptz;
    v_unpaid        integer;
    v_awaiting      integer;
    v_sessions      integer;
    v_new_version   integer;
BEGIN
    IF p_inactive_hours IS NULL OR p_inactive_hours < 1 THEN
        RAISE EXCEPTION 'p_inactive_hours must be at least 1 (got %)', p_inactive_hours;
    END IF;
    v_cutoff := now() - make_interval(hours => p_inactive_hours);

    -- FOR UPDATE: a customer placing an order at this exact moment must not race the close.
    SELECT * INTO v_tab FROM public.tabs WHERE id = p_tab_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('reaped', false, 'reason', 'not_found');
    END IF;

    IF v_tab.status <> 'open' THEN
        RETURN jsonb_build_object('reaped', false, 'reason', 'not_open', 'status', v_tab.status);
    END IF;

    -- ---------------------------------------------------------------- is it actually idle
    -- Re-derived here rather than trusted from the caller. GREATEST ignores NULLs, so a tab with
    -- no orders falls back to its own created_at.
    SELECT GREATEST(
             v_tab.created_at,
             v_tab.ready_to_pay_at,
             (SELECT max(GREATEST(o.placed_at, o.accepted_at, o.preparing_at, o.ready_at,
                                  o.completed_at, o.paid_at))
                FROM public.orders o WHERE o.tab_id = p_tab_id),
             (SELECT max(GREATEST(r.placed_at, r.decided_at))
                FROM public.order_requests r WHERE r.tab_id = p_tab_id),
             (SELECT max(s.created_at)
                FROM public.customer_sessions s WHERE s.tab_id = p_tab_id)
           )
      INTO v_last_activity;

    IF v_last_activity IS NULL OR v_last_activity > v_cutoff THEN
        RETURN jsonb_build_object(
            'reaped', false, 'reason', 'still_active',
            'last_activity_at', v_last_activity);
    END IF;

    -- ---------------------------------------------------------------- does anyone owe anything
    SELECT count(*) INTO v_unpaid
    FROM public.orders o
    WHERE o.tab_id = p_tab_id
      AND lower(coalesce(o.payment_status, '')) <> 'paid'
      AND lower(coalesce(o.status, '')) NOT IN ('cancelled', 'canceled');

    SELECT count(*) INTO v_awaiting
    FROM public.order_requests r
    WHERE r.tab_id = p_tab_id
      AND r.status IN ('waiting_review', 'accepting');

    IF v_unpaid > 0 OR v_awaiting > 0 THEN
        -- LEFT ALONE ON PURPOSE. Money owed is a thing for a person to settle, and a request in
        -- review has someone waiting on the other end. Recorded so it is visible rather than
        -- silently skipped every two minutes forever.
        INSERT INTO public.audit_logs (restaurant_id, entity_type, entity_id, action, metadata)
        VALUES (
            v_tab.restaurant_id, 'tab', p_tab_id::text, 'tab.abandoned_needs_attention',
            jsonb_build_object(
                'source', 'reap_abandoned_tabs_cron',
                'table_number', v_tab.table_number,
                'last_activity_at', v_last_activity,
                'inactive_hours_threshold', p_inactive_hours,
                'unpaid_orders', v_unpaid,
                'requests_awaiting_review', v_awaiting,
                'tab_total', v_tab.total,
                'note', 'left open deliberately: a cron must not record a settlement nobody made'));

        RETURN jsonb_build_object(
            'reaped', false, 'reason', 'money_or_review_outstanding',
            'unpaid_orders', v_unpaid, 'requests_awaiting_review', v_awaiting,
            'last_activity_at', v_last_activity);
    END IF;

    -- ---------------------------------------------------------------- reap
    -- Same three steps close_table_session takes, with one deliberate difference: settled_type.
    UPDATE public.tabs
       SET status = 'settled', settled_at = now(), settled_type = 'abandoned'
     WHERE id = p_tab_id;

    UPDATE public.customer_sessions
       SET active = false, expires_at = now()
     WHERE tab_id = p_tab_id AND active IS DISTINCT FROM false;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;

    IF v_tab.table_id IS NOT NULL THEN
        UPDATE public.restaurant_tables
           SET current_session_version = current_session_version + 1,
               status = 'available'
         WHERE id = v_tab.table_id
        RETURNING current_session_version INTO v_new_version;
    END IF;

    INSERT INTO public.audit_logs (restaurant_id, entity_type, entity_id, action, metadata)
    VALUES (
        v_tab.restaurant_id, 'tab', p_tab_id::text, 'tab.reaped_abandoned',
        jsonb_build_object(
            'source', 'reap_abandoned_tabs_cron',
            'table_number', v_tab.table_number,
            'table_id', v_tab.table_id,
            'last_activity_at', v_last_activity,
            'inactive_hours_threshold', p_inactive_hours,
            'sessions_expired', v_sessions,
            'new_session_version', v_new_version,
            'tab_total', v_tab.total,
            'settled_type', 'abandoned'));

    RETURN jsonb_build_object(
        'reaped', true,
        'last_activity_at', v_last_activity,
        'sessions_expired', v_sessions,
        'new_session_version', v_new_version);
END;
$$;

REVOKE ALL ON FUNCTION "public"."reap_abandoned_tab"(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."reap_abandoned_tab"(uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."reap_abandoned_tab"(uuid, integer) TO service_role;

COMMENT ON FUNCTION "public"."reap_abandoned_tab"(uuid, integer) IS
  'Closes a tab abandoned for p_inactive_hours, freeing the table and bumping its session version. '
  'REFUSES any tab that owes money or has a request awaiting review, and records an audit row '
  'either way. Settles as settled_type=''abandoned'', never ''manual_close'' -- no record may claim '
  'a person closed this. See #333.';
