-- NOT A MIGRATION. A local fixture schema for supabase/tests/run-db-tests.mjs.
--
-- It reproduces the columns, types, defaults and CHECK constraints that
-- settle_order_payment() and the integrity migrations actually touch, taken from a read-only
-- introspection of PRODUCTION on 2026-09-19 (information_schema.columns + pg_constraint). It is
-- deliberately NOT the whole schema: unrelated columns and foreign keys are omitted so the fixture
-- stays readable, and anything the functions under test read or write is present exactly.
--
-- It never runs against a real database. `run-db-tests.mjs` refuses any host that is not
-- 127.0.0.1/localhost.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

/**
 * The two tables `close_table_session()` touches besides `tabs`. Present so the REAL function --
 * extracted from the baseline migration by run-db-tests.mjs, never copied -- can run unmodified
 * against this fixture. Only the columns it reads or writes are here.
 */
CREATE TABLE public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_number integer,
  active boolean DEFAULT true,
  status text,
  current_session_version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id uuid,
  active boolean DEFAULT true,
  expires_at timestamptz
);

CREATE TABLE public.tabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_id uuid REFERENCES public.restaurant_tables(id) ON DELETE SET NULL,
  status text,
  total numeric,
  settled_at timestamptz,
  -- Written by close_table_session(). Missing here first time round, which the extracted-not-copied
  -- function surfaced immediately -- a transcription would have quietly dropped the column and the
  -- race test would have passed against a function that was not production's.
  settled_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,
  table_id uuid,
  order_number integer,
  status text,
  payment_status text,
  payment_method text,
  payment_reference text,
  payment_voucher_no text,
  paycloud_merchant_order_no text,
  paycloud_transaction_id text,
  total numeric,
  items jsonb,
  placed_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  terminal_pushed_at timestamptz,
  idempotency_key text,
  channel text NOT NULL DEFAULT 'table',
  pending_charge_cents integer,
  pending_tip_cents integer NOT NULL DEFAULT 0,
  pending_tip_staff_user_id uuid,
  pending_settlement_id uuid,
  is_stress_fixture boolean,
  -- Verbatim from production pg_constraint.
  CONSTRAINT orders_pending_charge_sane CHECK (
    ((pending_charge_cents IS NULL) OR (pending_charge_cents > 0))
    AND (pending_tip_cents >= 0)
    AND ((pending_charge_cents IS NULL) OR (pending_tip_cents < pending_charge_cents))),
  CONSTRAINT orders_pending_tip_needs_staff CHECK (
    (pending_tip_cents = 0) OR (pending_tip_staff_user_id IS NOT NULL))
);

-- Both of production's global partial-unique indexes on idempotency_key, so the F12 migration is
-- exercised against the same starting shape it will meet there.
CREATE UNIQUE INDEX idx_orders_idempotency_key
  ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX orders_idempotency_key_unique
  ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.terminal_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  terminal_id uuid,
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,
  merchant_order_no text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  scope text NOT NULL CHECK (scope IN ('orders', 'allocations')),
  order_ids uuid[],
  allocation_ids uuid[],
  status text NOT NULL DEFAULT 'launched'
    CHECK (status IN ('launched', 'confirmed', 'failed', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  tip_cents integer NOT NULL DEFAULT 0,
  tip_staff_user_id uuid,
  CONSTRAINT terminal_payment_intents_scope_targets CHECK (
    (scope = 'orders'
       AND order_ids IS NOT NULL AND array_length(order_ids, 1) > 0
       AND allocation_ids IS NULL)
    OR
    (scope = 'allocations'
       AND allocation_ids IS NOT NULL AND array_length(allocation_ids, 1) > 0
       AND order_ids IS NULL))
);

CREATE UNIQUE INDEX terminal_payment_intents_merchant_order_no_key
  ON public.terminal_payment_intents (merchant_order_no);

CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  business_order_no text NOT NULL,
  origin_business_order_no text NOT NULL,
  transaction_id text,
  terminal_id text,
  app_version text,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'NAD',
  idempotency_key text NOT NULL,
  initiated_by uuid,
  reason_code text NOT NULL,
  reason_note text,
  gateway_result_code text,
  gateway_result_message text,
  raw_gateway_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  order_ids uuid[] NOT NULL,
  CONSTRAINT payment_events_restaurant_id_idempotency_key_key
    UNIQUE (restaurant_id, idempotency_key)
);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  tip_cents integer NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'card')),
  staff_user_id uuid NOT NULL REFERENCES public.users(id),
  tab_id uuid,
  payment_reference text NOT NULL,
  payment_id uuid,
  allocation_settlement_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  source_item_index integer,
  kitchen_state text,
  bar_state text
);

/**
 * The allocation tables and settle_order_line_allocations() are NOT redefined here. The runner
 * applies the REAL migration (20260829170000_order_line_allocations.sql) on top of this file, so
 * the security assertions in settlement-rpc.test.sql check the function production actually has
 * rather than a copy of it that could drift. A stub would make
 * `security/allocations_rpc_still_locked_down` a false negative -- a check that passes because
 * nothing is there to fail it.
 *
 * That migration needs two things this fixture must supply first: the RLS predicate it references,
 * and `orders.items`, which order_is_fully_paid_by_allocations() reads. `items` is above.
 */
CREATE OR REPLACE FUNCTION public.user_has_permission(p_restaurant_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

COMMENT ON FUNCTION public.user_has_permission(uuid, text) IS
  'FIXTURE STUB. Returns false so the RLS policies in the real migrations can be created. No test '
  'in this suite asserts on RLS row visibility -- the RLS tests run against staging, where the '
  'real predicate exists. Present only so CREATE POLICY parses.';

-- The roles the GRANT/REVOKE statements in the migrations name. Supabase provides these; a bare
-- Postgres does not, and without them the migration's own security assertions would be skipped
-- rather than verified.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
