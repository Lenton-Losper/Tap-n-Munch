-- @env: both
--
-- ONE REFERENCE PER CARD CHARGE, so a tab can be paid by several people.
--
-- ================================================================================================
-- WHAT THIS IS FOR
-- ================================================================================================
--
-- Three people at a table each paying by card for their own items is ordinary, and "card only
-- works on a whole order" is not a sentence a waiter can say to a customer. The reader was never
-- the obstacle: PaymentModule sends WiseCashier {businessOrderNo, paymentScenario, amt, notifyUrl,
-- POSMode} and will charge any amount asked of it. The obstacle was OURS.
--
-- `orders.paycloud_merchant_order_no` is ONE COLUMN PER ORDER, minted once and deliberately never
-- rotated (see lib/payments/terminal-merchant-order.ts, whose no-rotation rule exists to stop
-- orphaned webhooks). So a second card charge against the same order reuses the first charge's
-- reference, and POST /api/webhooks/paycloud — which correlates byte-exact on that value — cannot
-- tell the two settlements apart.
--
-- This table moves the reference off the ORDER and onto the ATTEMPT. Each charge mints its own
-- merchant_order_no, so two people paying for their own items on one order can never collide.
--
-- ================================================================================================
-- IT DOES NOT REPLACE orders.paycloud_merchant_order_no
-- ================================================================================================
--
-- That column keeps its unique partial index, its no-rotation rule, and its meaning: THIS ORDER'S
-- SINGLE WHOLE-ORDER REFERENCE. The whole-order card path is untouched by this feature — every
-- venue's ordinary card payment runs the same code tomorrow as today, and a defect in the split
-- path cannot reach it. Owner's ruling, 2026-09-06: two reference mechanisms coexisting is the
-- correct trade, and migrating a working money path to serve a case it does not have is not.
--
-- NOTHING IS BACKFILLED INTO THIS TABLE. Six orders on production carry a merchant_order_no minted
-- under the old rule (Digi Cofee #18 pending, #19/#28/#29/#39 cancelled, #40 legitimately paid).
-- Writing them here would assert a `scope` and an `amount_cents` no reader was ever asked for —
-- precision that does not exist. They stay resolvable through the resolver's unchanged legs.
--
-- ================================================================================================
-- WHY amount_cents IS HERE AND WHY IT MATTERS BEYOND THIS FEATURE
-- ================================================================================================
--
-- It is WHAT WE ASKED THE READER TO CHARGE. Until now nothing recorded that, which is why
-- POST /api/terminal/payment-events/sale could accept one `amount` against N orders and check it
-- against nothing: the only comparison available was amount-vs-sum-of-order-totals, and that is
-- legitimately wrong for a partial payment or a tip. An intent gives the reconciliation something
-- TRUE to compare against.
--
-- ================================================================================================
-- STATUS, AND THE ONE TRANSITION THAT MUST NEVER BE AUTOMATED
-- ================================================================================================
--
--   launched   the reader was asked; nothing is settled
--   confirmed  the charge is proven, and the allocations (or orders) are settled
--   failed     the gateway said no; whatever this covered is released
--   uncertain  WE DO NOT KNOW
--
-- `uncertain` is reached by an ambiguous device outcome, and E04111 from this gateway means NO
-- RECORD, never NOT PAID. An uncertain intent HOLDS what it covers: not settled, not released.
-- Releasing it would let a second customer pay for the first customer's items while the first
-- customer's card was still settling, and the tab stays open for exactly long enough.
--
-- NOTHING MAY AUTO-RESOLVE AN UNCERTAIN INTENT. No sweeper, no timeout, no cron — a webhook or a
-- human, and nothing else. Auto-settling turns E04111 into a free meal; auto-failing takes a real
-- charge twice. Owner's ruling, 2026-09-06, recorded here because this is the table a future
-- sweeper would be tempted to read.

CREATE TABLE IF NOT EXISTS public.terminal_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  terminal_id uuid,
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,

  -- The businessOrderNo handed to WiseCashier. UNIQUE across the estate: it is the only thing a
  -- webhook has to find this row by.
  merchant_order_no text NOT NULL,

  -- What we asked the reader for, in integer minor units. NOT what any order totals.
  amount_cents integer NOT NULL CHECK (amount_cents > 0),

  -- Exactly one of order_ids / allocation_ids is populated, enforced below.
  scope text NOT NULL CHECK (scope IN ('orders', 'allocations')),
  order_ids uuid[],
  allocation_ids uuid[],

  status text NOT NULL DEFAULT 'launched'
    CHECK (status IN ('launched', 'confirmed', 'failed', 'uncertain')),

  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,

  -- An intent names what it pays for, and only one kind of thing. A row carrying both, or neither,
  -- would leave the webhook guessing what to settle — which is the ambiguity this whole table
  -- exists to remove.
  CONSTRAINT terminal_payment_intents_scope_targets CHECK (
    (scope = 'orders'
       AND order_ids IS NOT NULL AND array_length(order_ids, 1) > 0
       AND allocation_ids IS NULL)
    OR
    (scope = 'allocations'
       AND allocation_ids IS NOT NULL AND array_length(allocation_ids, 1) > 0
       AND order_ids IS NULL)
  )
);

-- The webhook's lookup. UNIQUE because two intents under one reference is precisely the collision
-- this table exists to prevent, and a duplicate must fail at insert rather than at correlation.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_payment_intents_merchant_order_no_key
  ON public.terminal_payment_intents (merchant_order_no);

-- "Is a card live on this allocation?" — the guard that stops cash being taken for items a card is
-- still settling. GIN, because the question is asked of an array.
CREATE INDEX IF NOT EXISTS terminal_payment_intents_allocation_ids_idx
  ON public.terminal_payment_intents USING GIN (allocation_ids)
  WHERE allocation_ids IS NOT NULL;

CREATE INDEX IF NOT EXISTS terminal_payment_intents_tab_idx
  ON public.terminal_payment_intents (tab_id)
  WHERE tab_id IS NOT NULL;

-- Unresolved intents, for the reconciliation surface a human works through. NOT for a job: see the
-- status note above.
CREATE INDEX IF NOT EXISTS terminal_payment_intents_open_idx
  ON public.terminal_payment_intents (restaurant_id, created_at)
  WHERE status IN ('launched', 'uncertain');

COMMENT ON TABLE public.terminal_payment_intents IS
  'One row per card charge asked of a reader. Carries its own merchant_order_no so several people can pay for their own items on one order. orders.paycloud_merchant_order_no is unchanged and still serves the whole-order path.';

COMMENT ON COLUMN public.terminal_payment_intents.amount_cents IS
  'What the reader was asked to charge. The honest figure to reconcile a gateway amount against -- order totals are not, because a settlement is per-payment and may be partial or carry a tip.';

COMMENT ON COLUMN public.terminal_payment_intents.status IS
  'launched | confirmed | failed | uncertain. An uncertain intent HOLDS what it covers and must never be auto-resolved: E04111 means no record, not not-paid.';

ALTER TABLE public.terminal_payment_intents ENABLE ROW LEVEL SECURITY;

-- Read only, and only for staff who can already see orders. Every write goes through the service
-- role in a terminal-authenticated route; nothing client-side may create or resolve an intent.
DROP POLICY IF EXISTS "Authorized staff can read payment intents" ON public.terminal_payment_intents;
CREATE POLICY "Authorized staff can read payment intents"
  ON public.terminal_payment_intents
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'orders:read'));
