-- @env: both
--
-- Gratuities: capture what passes through the terminal, attributed to the person who took the
-- money, OUTSIDE the VAT base and OUTSIDE revenue.
--
-- ============================================================================================
-- THE TAX CONSTRAINT. READ THIS BEFORE CHANGING ANYTHING HERE.
-- ============================================================================================
--
-- A FREELY GIVEN GRATUITY IS NOT CONSIDERATION FOR THE SUPPLY. The customer is not paying it in
-- exchange for the meal; they are free not to pay it at all, and the meal is the same either way.
-- It therefore sits OUTSIDE the VAT base, and that is why this is a separate table rather than a
-- column on the order: keeping it out of `orders.total` keeps it out of the VAT base BY
-- CONSTRUCTION, not by a filter somebody can later remove.
--
-- A COMPULSORY SERVICE CHARGE IS THE OPPOSITE. If a venue adds it whether or not the customer
-- agrees, it IS consideration for the supply: it is part of the price, it is taxable at the
-- meal's own rate, and it MUST go inside the order total. IT CANNOT USE THIS TABLE.
--
-- SO: NO COLUMN, FLAG OR CONFIG ON THIS TABLE MAY EVER MAKE A TIP MANDATORY. There is deliberately
-- nowhere to record "this one was compulsory", because a row here is a claim that the payment was
-- voluntary, and a mandatory charge recorded here would be untaxed consideration. If a venue asks
-- for a mandatory service charge, that is a SEPARATE FEATURE that prices into the order and goes
-- through `calculate-order-pricing.ts` -- not a toggle on this one.
--
-- PROVENANCE, STATED HONESTLY: no NamRA guidance specific to gratuities was found. This follows the
-- GENERAL CONSIDERATION PRINCIPLE (is the payment given in exchange for the supply?), which is the
-- ordinary basis for the distinction, and NOT a Namibian ruling on tips. A venue's own accountant
-- should confirm the treatment for that venue. If that advice ever contradicts this, the fix is to
-- change the design deliberately -- not to start writing service charges into these rows.
--
-- ============================================================================================
-- SHAPE
-- ============================================================================================
--
-- APPEND-ONLY. A tip is a financial record: it is written once, at settle, and never edited. There
-- is no updated_at and nothing here is meant to be UPDATEd.
--
-- INTEGER CENTS, matching `order_line_allocation_settlements.amount_cents`. NOT numeric, which is
-- what `payments.amount` uses -- a money join across the two representations is the coupling that
-- has bitten this codebase before, and the allocations ledger is the one this must reconcile with.
--
-- staff_user_id IS NOT NULL, and it is THE SETTLER -- the person the authorization token
-- identified, who actually took the money -- not the waiter who opened the table. Ruled 2026-09-05:
-- it is already how the allocations path attributes, and it keeps FlashTap out of having an opinion
-- on how a venue divides tips. POOLING IS A PAYROLL DECISION AND IS NOT MODELLED HERE.
--
-- TWO NULLABLE PARENTS, ONE REQUIRED. There are two settlement paths and they are not
-- interchangeable: the whole-tab path writes `payments`, the split path writes
-- `order_line_allocation_settlements`. A tip belongs to whichever settled it, so each is a nullable
-- FK and a CHECK requires at least one. Modelling it as a single parent would mean inventing a
-- shared settlement id that does not exist.

CREATE TABLE IF NOT EXISTS public.payment_tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

  -- Positive only. A zero tip is "no tip" and is represented by the absence of a row, not by a row
  -- claiming nothing; a negative one would be a refund, which is a different record entirely.
  tip_cents integer NOT NULL CHECK (tip_cents > 0),

  -- Same vocabulary as the settlement ledgers. A tip is taken by the same instrument as the bill.
  method text NOT NULL CHECK (method IN ('cash', 'card')),

  -- The settler. NOT NULL: money with no name attached is what this table exists to stop.
  staff_user_id uuid NOT NULL REFERENCES public.users(id),

  -- Convenience for reporting; the tab a tip was taken on. Nullable because a counter/POS sale has
  -- no tab, and SET NULL rather than CASCADE because deleting a tab must not delete money records.
  tab_id uuid REFERENCES public.tabs(id) ON DELETE SET NULL,

  -- Exactly one of these is the settlement this tip rode on. See the note above.
  payment_id uuid REFERENCES public.payments(id),
  allocation_settlement_id uuid REFERENCES public.order_line_allocation_settlements(id),

  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_tips_has_a_settlement
    CHECK (payment_id IS NOT NULL OR allocation_settlement_id IS NOT NULL)
);

-- The two questions this table exists to answer: "what did this staff member earn over a period"
-- and "what tips did this venue take". Both are staff/venue + time.
CREATE INDEX IF NOT EXISTS payment_tips_restaurant_recorded_idx
  ON public.payment_tips (restaurant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS payment_tips_staff_recorded_idx
  ON public.payment_tips (restaurant_id, staff_user_id, recorded_at DESC);

-- One tip per settlement. A retry that re-posts a settle must not double-count a gratuity, and a
-- partial unique index is what makes that a database property rather than a hope. Two indexes
-- because either parent may be null.
CREATE UNIQUE INDEX IF NOT EXISTS payment_tips_one_per_payment
  ON public.payment_tips (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_tips_one_per_allocation_settlement
  ON public.payment_tips (allocation_settlement_id) WHERE allocation_settlement_id IS NOT NULL;

ALTER TABLE public.payment_tips ENABLE ROW LEVEL SECURITY;

-- No anon policy, deliberately: a customer never reads tip records, and the routes that write them
-- run service-role. Adding a policy here later is a decision, not a formality.
COMMENT ON TABLE public.payment_tips IS
  'Voluntary gratuities taken through the terminal. Outside the VAT base and outside revenue: a '
  'freely given gratuity is not consideration for the supply. A COMPULSORY service charge is '
  'consideration, is taxable, and belongs in the order total -- never in this table. Follows the '
  'general consideration principle, not a Namibian ruling; confirm with the venue accountant.';
