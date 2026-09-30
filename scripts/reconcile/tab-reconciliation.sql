-- TAB RECONCILIATION -- is every cent on one tab explained? (Sprint 2026-09-30 brief, N)
--
--   psql -v tab_id=<uuid> -f scripts/reconcile/tab-reconciliation.sql
--   node scripts/reconcile/run-tab-reconciliation.mjs --container=<docker> --db=<name> --tab=<uuid>
--
-- READ-ONLY BY CONSTRUCTION. Everything runs inside `BEGIN ... READ ONLY` and ends in ROLLBACK, so
-- it cannot write to whatever database it is pointed at even if a statement below were wrong: a
-- read-only transaction refuses INSERT/UPDATE/DELETE/DDL with 25006. No temp tables, no functions
-- created. REPEATABLE READ: every check reads the same snapshot, so a payment landing mid-run cannot
-- make two checks disagree.
--
-- WHAT IT COMPARES (all integer cents):
--
--   order lines     every orders.items[i] has exactly one order_lines row, and no duplicates
--   projection      the financial projection recomputed IN SQL, independently of
--                   lib/orders/order-financials.ts (same rules: VOIDED_LINE = every owning station
--                   voided; live = total - voided, 0 when cancelled; paid = item settlements +
--                   settled_charge_cents when paid (legacy: max(alloc, total)); outstanding only for
--                   owing statuses; settlement artefacts excluded)
--   ledgers         payment_events 'sale' rows, non_gateway_payment_events, confirmed
--                   allocation-scope terminal_payment_intents, and order_line_allocation_settlements
--   intents         terminal_payment_intents still launched/uncertain; one whose charge is already
--                   settled (orders paid / allocations settled) is a MONEY failure
--   tab             tabs.total vs the projection's outstanding
--   invoice         each live invoice covering the tab: total = live, recorded payments = paid,
--                   balance = outstanding, over exactly the orders it covers
--
-- EVERY ROW: check | severity | ok | expected_cents | actual_cents | delta_cents | detail
--   severity 'money'  must hold at ALL times: a false row is unexplained money.
--   severity 'state'  must hold once the tab is settled (nothing in flight, nothing owed, invoice
--                     refreshed); mid-service a false 'state' row is information, not an error.

\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH
params AS (SELECT :'tab_id'::uuid AS tab_id),
tab AS (
  SELECT t.id, t.restaurant_id, t.status, t.total
    FROM public.tabs t JOIN params p ON t.id = p.tab_id
),
ord AS (
  SELECT o.*
    FROM public.orders o JOIN tab ON o.tab_id = tab.id
   WHERE NULLIF(btrim(COALESCE(o.tab_settlement_for_tab_id::text, '')), '') IS NULL
),
item AS (
  SELECT o.id AS order_id, (i.ord - 1)::int AS idx,
         COALESCE(
           CASE WHEN i.item->>'total' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN round((i.item->>'total')::numeric * 100) END,
           CASE WHEN i.item->>'subtotal' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN round((i.item->>'subtotal')::numeric * 100) END,
           CASE WHEN COALESCE(i.item->>'unitPrice', i.item->>'unit_price') ~ '^-?[0-9]+(\.[0-9]+)?$'
                 AND i.item->>'quantity' ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN round(COALESCE(i.item->>'unitPrice', i.item->>'unit_price')::numeric * (i.item->>'quantity')::numeric * 100) END,
           0)::bigint AS cents
    FROM ord o,
         jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END)
           WITH ORDINALITY AS i(item, ord)
),
line AS (
  SELECT l.id, l.order_id, l.source_item_index,
         ((l.kitchen_state IS NOT NULL OR l.bar_state IS NOT NULL)
           AND COALESCE(l.kitchen_state, 'voided') = 'voided'
           AND COALESCE(l.bar_state, 'voided') = 'voided') AS voided
    FROM public.order_lines l JOIN ord o ON o.id = l.order_id
),
alloc AS (
  SELECT a.id, a.order_id, a.order_line_id
    FROM public.order_line_allocations a JOIN ord o ON o.id = a.order_id
   WHERE a.voided_at IS NULL
),
settlement AS (
  SELECT s.id, s.order_line_allocation_id AS allocation_id, a.order_id, a.order_line_id,
         s.amount_cents::bigint AS cents, s.payment_reference
    FROM public.order_line_allocation_settlements s JOIN alloc a ON a.id = s.order_line_allocation_id
),
per_order AS (
  SELECT o.id, o.status, o.payment_status, o.payment_reference, o.pending_charge_cents,
         round(COALESCE(o.total, 0) * 100)::bigint AS original,
         COALESCE((SELECT sum(it.cents) FROM item it JOIN line l ON l.order_id = it.order_id AND l.source_item_index = it.idx
                    WHERE it.order_id = o.id AND l.voided), 0)::bigint AS voided,
         COALESCE((SELECT sum(s.cents) FROM settlement s WHERE s.order_id = o.id), 0)::bigint AS alloc_settled,
         o.settled_charge_cents::bigint AS settled_charge,
         lower(o.status) = 'cancelled' AS cancelled,
         lower(btrim(COALESCE(o.payment_status, ''))) = 'paid' AS is_paid,
         lower(btrim(COALESCE(o.payment_status, ''))) IN
           ('unpaid', 'pending', 'cash_pending', 'failed', 'terminal_pending', 'amount_mismatch_hold',
            'verification_unavailable_hold') AS owes
    FROM ord o
),
proj AS (
  SELECT p.*,
         CASE WHEN p.cancelled THEN 0 ELSE greatest(0, p.original - p.voided) END AS live,
         CASE WHEN NOT p.is_paid THEN p.alloc_settled
              WHEN p.settled_charge IS NOT NULL THEN p.alloc_settled + greatest(0, p.settled_charge)
              ELSE greatest(p.alloc_settled, p.original) END AS paid
    FROM per_order p
),
proj2 AS (
  SELECT p.*,
         CASE WHEN p.owes AND NOT p.cancelled THEN greatest(0, p.live - p.paid) ELSE 0 END AS outstanding,
         greatest(0, p.paid - p.live) AS overpaid
    FROM proj p
),
tab_orders AS (SELECT array_agg(id) AS ids FROM ord),
-- LEDGERS ----------------------------------------------------------------------------------------
split_intent AS (
  SELECT i.merchant_order_no, i.amount_cents::bigint AS cents, i.status
    FROM public.terminal_payment_intents i JOIN tab ON i.tab_id = tab.id
   WHERE i.scope = 'allocations'
),
sale AS (
  SELECT e.id, e.business_order_no, e.transaction_id, e.order_ids,
         round(e.amount * 100)::bigint
           - COALESCE((SELECT sum(pt.tip_cents) FROM public.payment_tips pt
                        WHERE pt.payment_reference IN (e.business_order_no, COALESCE(e.transaction_id, ''))
                          AND pt.allocation_settlement_id IS NULL), 0)::bigint AS bill_cents,
         EXISTS (SELECT 1 FROM split_intent si WHERE si.merchant_order_no = e.business_order_no) AS for_allocations
    FROM public.payment_events e, tab_orders t
   WHERE e.event_type = 'sale' AND e.order_ids && t.ids
),
ngpe AS (
  SELECT e.id, e.order_ids, e.allocation_ids, e.payment_reference, e.method,
         (e.amount_cents - e.tip_cents)::bigint AS bill_cents
    FROM public.non_gateway_payment_events e, tab_orders t
   WHERE e.order_ids && t.ids
),
-- An item settlement is explained by: the cash ledger row naming its allocation, OR the confirmed
-- split-card intent whose reference it carries, OR a gateway sale row under that reference.
settlement_explained AS (
  SELECT s.*,
         (EXISTS (SELECT 1 FROM ngpe n WHERE n.allocation_ids @> ARRAY[s.allocation_id])
          OR EXISTS (SELECT 1 FROM split_intent si WHERE si.merchant_order_no = s.payment_reference AND si.status = 'confirmed')
          OR EXISTS (SELECT 1 FROM sale x WHERE x.business_order_no = s.payment_reference)) AS explained
    FROM settlement s
),
-- A whole-order ledger event: a sale row not belonging to a split intent, or a non-gateway row
-- that is not an item settlement. Its bill must equal the settled charges of the orders it names.
whole_event AS (
  SELECT 'sale:' || x.id AS event, x.order_ids, x.bill_cents FROM sale x WHERE NOT x.for_allocations
  UNION ALL
  SELECT 'non_gateway:' || n.id, n.order_ids, n.bill_cents FROM ngpe n WHERE n.allocation_ids IS NULL
),
whole_event_check AS (
  SELECT w.event, w.bill_cents,
         COALESCE((SELECT sum(p.settled_charge) FROM proj2 p WHERE p.is_paid AND p.id = ANY (w.order_ids)), 0)::bigint AS charged
    FROM whole_event w
),
paid_orders_unledgered AS (
  SELECT p.id FROM proj2 p
   WHERE p.is_paid AND COALESCE(p.settled_charge, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM whole_event w WHERE p.id = ANY (w.order_ids))
),
split_intent_check AS (
  SELECT si.merchant_order_no, si.cents,
         COALESCE((SELECT sum(s.cents) FROM settlement s WHERE s.payment_reference = si.merchant_order_no), 0)::bigint AS settled
    FROM split_intent si WHERE si.status = 'confirmed'
),
ledger AS (
  SELECT
    COALESCE((SELECT sum(bill_cents) FROM whole_event), 0)::bigint AS whole_cents,
    COALESCE((SELECT sum(cents) FROM settlement_explained WHERE explained), 0)::bigint AS item_cents
),
-- INVOICES ---------------------------------------------------------------------------------------
invoice AS (
  SELECT d.id, d.document_number, d.total, d.balance, d.status,
         COALESCE(d.order_ids, CASE WHEN d.order_id IS NOT NULL THEN ARRAY[d.order_id] END) AS covered
    FROM public.business_documents d, tab, tab_orders t
   WHERE d.document_type = 'invoice' AND d.status <> 'void'
     AND (d.tab_id = tab.id OR d.order_id = ANY (t.ids) OR d.order_ids && t.ids)
),
invoice_check AS (
  SELECT i.document_number,
         round(i.total * 100)::bigint AS total_cents,
         round(i.balance * 100)::bigint AS balance_cents,
         COALESCE((SELECT sum(round(dp.amount * 100)) FROM public.document_payments dp WHERE dp.document_id = i.id), 0)::bigint AS recorded_cents,
         COALESCE((SELECT sum(p.live) FROM proj2 p WHERE p.id = ANY (i.covered)), 0)::bigint AS live_cents,
         COALESCE((SELECT sum(p.paid) FROM proj2 p WHERE p.id = ANY (i.covered)), 0)::bigint AS paid_cents,
         COALESCE((SELECT sum(p.outstanding) FROM proj2 p WHERE p.id = ANY (i.covered)), 0)::bigint AS outstanding_cents
    FROM invoice i
),
tot AS (
  SELECT COALESCE(sum(original), 0)::bigint AS original, COALESCE(sum(voided), 0)::bigint AS voided,
         COALESCE(sum(live), 0)::bigint AS live, COALESCE(sum(paid), 0)::bigint AS paid,
         COALESCE(sum(outstanding), 0)::bigint AS outstanding, COALESCE(sum(overpaid), 0)::bigint AS overpaid,
         COALESCE(sum(alloc_settled), 0)::bigint AS alloc,
         COALESCE(sum(settled_charge) FILTER (WHERE is_paid), 0)::bigint AS whole
    FROM proj2
),
results(ord, check_name, severity, expected_cents, actual_cents, detail) AS (
  SELECT 1, 'tab_found', 'money', 1::bigint, (SELECT count(*) FROM tab)::bigint, 'the tab id resolves to exactly one tab'
  UNION ALL
  SELECT 2, 'items_without_a_line', 'money', 0,
         (SELECT count(*) FROM item it WHERE NOT EXISTS (SELECT 1 FROM line l WHERE l.order_id = it.order_id AND l.source_item_index = it.idx)),
         'every orders.items entry has an order_lines row'
  UNION ALL
  SELECT 3, 'duplicate_lines', 'money', 0,
         (SELECT count(*) FROM (SELECT order_id, source_item_index FROM line GROUP BY 1, 2 HAVING count(*) > 1) d),
         'no item has two lines'
  UNION ALL
  SELECT 4, 'gross_historical_total', 'info', (SELECT original FROM tot), (SELECT original FROM tot),
         'sum(orders.total) as stored -- historical, never the amount charged'
  UNION ALL
  SELECT 5, 'voided_total', 'info', (SELECT voided FROM tot), (SELECT voided FROM tot), 'items voided on the tab'
  UNION ALL
  SELECT 6, 'live_payable', 'info', (SELECT live FROM tot), (SELECT live FROM tot), 'what the tab is worth: original - voided'
  UNION ALL
  SELECT 7, 'live_equals_paid_plus_outstanding', 'money', (SELECT live FROM tot),
         (SELECT paid + outstanding - overpaid FROM tot), 'the projection''s identity over every order'
  UNION ALL
  SELECT 8, 'projection_paid_equals_ledger', 'money', (SELECT paid FROM tot),
         (SELECT whole_cents + item_cents FROM ledger), 'item settlements + settled charges = explained ledger money'
  UNION ALL
  SELECT 9, 'item_settlements_unexplained', 'money', 0,
         (SELECT COALESCE(sum(cents), 0) FROM settlement_explained WHERE NOT explained),
         'each item settlement has a cash ledger row, a confirmed split intent or a sale row'
  UNION ALL
  SELECT 10, 'whole_order_events_mismatched', 'money', 0,
         (SELECT count(*) FROM whole_event_check WHERE bill_cents <> charged),
         COALESCE((SELECT string_agg(event || ' bill ' || bill_cents || ' vs settled ' || charged, '; ') FROM whole_event_check WHERE bill_cents <> charged), 'each ledger event = the settled charges of the orders it names')
  UNION ALL
  SELECT 11, 'paid_orders_without_ledger', 'money', 0, (SELECT count(*) FROM paid_orders_unledgered),
         COALESCE((SELECT string_agg(id::text, ', ') FROM paid_orders_unledgered), 'every whole-order payment has a ledger row')
  UNION ALL
  SELECT 12, 'split_intents_mismatched', 'money', 0,
         (SELECT count(*) FROM split_intent_check WHERE cents <> settled),
         'a confirmed split charge settled exactly its amount'
  UNION ALL
  SELECT 13, 'duplicate_sale_rows', 'money', 0,
         (SELECT count(*) FROM (SELECT business_order_no FROM sale GROUP BY 1 HAVING count(*) > 1) d),
         'one gateway sale row per charge reference'
  UNION ALL
  SELECT 14, 'overpaid', 'money', 0, (SELECT overpaid FROM tot), 'no order paid beyond its live value'
  UNION ALL
  SELECT 15, 'voided_lines_settled', 'money', 0,
         (SELECT COALESCE(sum(s.cents), 0) FROM settlement s JOIN line l ON l.id = s.order_line_id WHERE l.voided),
         'no money settled against a cancelled line'
  UNION ALL
  SELECT 16, 'paid_orders_still_marked_in_flight', 'money', 0,
         (SELECT count(*) FROM proj2 WHERE is_paid AND pending_charge_cents IS NOT NULL),
         'a paid order carries no pending card charge'
  UNION ALL
  SELECT 17, 'invoice_total_equals_live', 'money', (SELECT COALESCE(sum(live_cents), 0) FROM invoice_check),
         (SELECT COALESCE(sum(total_cents), 0) FROM invoice_check),
         COALESCE((SELECT string_agg(document_number || ': total ' || total_cents || ' live ' || live_cents, '; ') FROM invoice_check), 'no invoice')
  UNION ALL
  SELECT 18, 'invoice_payments_equal_ledger', 'state', (SELECT COALESCE(sum(paid_cents), 0) FROM invoice_check),
         (SELECT COALESCE(sum(recorded_cents), 0) FROM invoice_check),
         COALESCE((SELECT string_agg(document_number || ': recorded ' || recorded_cents || ' paid ' || paid_cents, '; ') FROM invoice_check), 'no invoice')
  UNION ALL
  SELECT 19, 'invoice_balance_equals_outstanding', 'state', (SELECT COALESCE(sum(outstanding_cents), 0) FROM invoice_check),
         (SELECT COALESCE(sum(balance_cents), 0) FROM invoice_check),
         COALESCE((SELECT string_agg(document_number || ': balance ' || balance_cents || ' outstanding ' || outstanding_cents, '; ') FROM invoice_check), 'no invoice')
  UNION ALL
  SELECT 20, 'payments_in_flight', 'state', 0,
         (SELECT count(*) FROM public.terminal_payment_intents i JOIN tab ON i.tab_id = tab.id WHERE i.status IN ('launched', 'uncertain')),
         'charges started and not yet resolved'
  UNION ALL
  -- A charge whose money HAS been settled must have resolved its intent: every order an
  -- orders-scope intent names is paid, or every allocation an allocation-scope intent names is
  -- settled, yet the intent still says launched/uncertain. That is a settlement that left its
  -- charge looking in flight -- a money-grade failure, not a state still converging.
  SELECT 20.5, 'paid_charges_left_in_flight', 'money', 0,
         (SELECT count(*) FROM public.terminal_payment_intents i JOIN tab ON i.tab_id = tab.id
           WHERE i.status IN ('launched', 'uncertain')
             AND ((i.scope = 'orders' AND cardinality(COALESCE(i.order_ids, '{}')) > 0
                   AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = ANY (i.order_ids)
                                    AND lower(btrim(COALESCE(o.payment_status, ''))) <> 'paid'))
               OR (i.scope = 'allocations' AND cardinality(COALESCE(i.allocation_ids, '{}')) > 0
                   AND NOT EXISTS (SELECT 1 FROM unnest(i.allocation_ids) AS a(id)
                                    WHERE NOT EXISTS (SELECT 1 FROM public.order_line_allocation_settlements s
                                                       WHERE s.order_line_allocation_id = a.id))))),
         COALESCE((SELECT string_agg(i.merchant_order_no || ' (' || i.scope || ', ' || i.status || ')', '; ')
                     FROM public.terminal_payment_intents i JOIN tab ON i.tab_id = tab.id
                    WHERE i.status IN ('launched', 'uncertain')
                      AND i.scope = 'orders' AND cardinality(COALESCE(i.order_ids, '{}')) > 0
                      AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = ANY (i.order_ids)
                                       AND lower(btrim(COALESCE(o.payment_status, ''))) <> 'paid')),
                  'every settled charge resolved its intent')
  UNION ALL
  SELECT 21, 'outstanding', 'state', 0, (SELECT outstanding FROM tot), 'money still owed on the tab'
  UNION ALL
  SELECT 22, 'tab_stored_total_equals_outstanding', 'state', (SELECT outstanding FROM tot),
         (SELECT round(COALESCE(total, 0) * 100)::bigint FROM tab), 'tabs.total as stored'
  UNION ALL
  SELECT 23, 'ledger_total', 'info', (SELECT whole_cents + item_cents FROM ledger), (SELECT whole_cents + item_cents FROM ledger),
         'whole-order ' || (SELECT whole_cents FROM ledger) || ' + items ' || (SELECT item_cents FROM ledger)
)
SELECT check_name, severity,
       (expected_cents = actual_cents) AS ok,
       expected_cents, actual_cents, actual_cents - expected_cents AS delta_cents, detail
  FROM results
 ORDER BY ord;

ROLLBACK;
