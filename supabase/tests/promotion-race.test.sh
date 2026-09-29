#!/usr/bin/env bash
# THE DEVICE'S SALE REPORT AND THE VERIFIED SETTLEMENT, IN TWO REAL SESSIONS (20260929130000).
#
# Session A is the device route: it inserts its origin='terminal_device' sale row and holds the
# transaction open. Session B is settle_order_payment for the same reference, started while A's row
# is still uncommitted -- so B's first look cannot see it, and B's INSERT waits on the key. When A
# commits, B's INSERT does nothing; only the SECOND look (a new statement, a new snapshot) finds the
# committed device row and promotes it. Without it the only sale row would stay the device's report.
#
# Mutation MPR4 (one look only) must turn this RED. Throwaway container only -- it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1)

RID=11111111-1111-4111-8111-111111111111
O1=aaaaaaaa-0000-4000-8000-000000000501

echo "=== seeding one order ==="
"${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.payment_tips;
DELETE FROM public.audit_logs;
DELETE FROM public.payment_events;
DELETE FROM public.terminal_payment_intents;
DELETE FROM public.order_lines;
DELETE FROM public.orders;
DELETE FROM public.tabs;
DELETE FROM public.users;
DELETE FROM public.restaurants;
INSERT INTO public.restaurants (id, name) VALUES ('$RID', 'Riviera');
INSERT INTO public.orders
  (id, restaurant_id, order_number, status, payment_status, total, pending_charge_cents)
VALUES ('$O1', '$RID', 501, 'pending', 'pending', 100, 10000);
SQL

echo "=== A: device report held open; B: settlement started meanwhile ==="
"${PSQL[@]}" > /tmp/prom-a.out 2>/tmp/prom-a.err <<SQL &
BEGIN;
INSERT INTO public.payment_events
  (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
   transaction_id, amount, idempotency_key, reason_code, origin, device_amount_check)
VALUES ('$RID', ARRAY['$O1']::uuid[], 'sale', 'MO-PROM', 'MO-PROM', 'TXN-PROM', 1.00, 'MO-PROM',
        'sale', 'terminal_device', 'mismatch_order_totals');
SELECT pg_sleep(3);
COMMIT;
SQL
PID_A=$!
sleep 1
"${PSQL[@]}" -c "SELECT public.settle_order_payment(
  '$RID', ARRAY['$O1']::uuid[], 10000, 10000, 'TXN-PROM', 'MO-PROM', 'card', 'MO-PROM', NULL,
  'promotion_probe', NULL, 0, NULL, ARRAY[]::uuid[], NULL)::text;" > /tmp/prom-b.out 2>/tmp/prom-b.err &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  A(exit $EXIT_A) $(head -c 200 /tmp/prom-a.err)"
echo "  B(exit $EXIT_B): $(head -c 300 /tmp/prom-b.out) $(head -c 200 /tmp/prom-b.err)"

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}

echo "=== assertions ==="
check "both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"
check "the order is paid" \
  "$("${PSQL[@]}" -c "SELECT payment_status FROM public.orders WHERE id='$O1';")" "paid"
check "exactly one sale row" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM public.payment_events WHERE event_type='sale';")" "1"
check "the sale row was promoted to gateway at the verified amount" \
  "$("${PSQL[@]}" -c "SELECT origin || ':' || amount::numeric(12,2) FROM public.payment_events WHERE event_type='sale';")" \
  "gateway:100.00"
check "the device's figure is preserved" \
  "$("${PSQL[@]}" -c "SELECT raw_gateway_response->'promoted'->>'device_reported_amount' FROM public.payment_events WHERE event_type='sale';")" \
  "1.00"
check "the promotion was audited once" \
  "$("${PSQL[@]}" -c "SELECT count(*) FROM public.audit_logs WHERE action='payment.device_row_promoted';")" "1"

if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
