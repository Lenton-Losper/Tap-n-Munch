#!/usr/bin/env bash
# TWO SETTLEMENTS AT ONCE, IN TWO REAL SESSIONS.
#
# ==================================================================================================
# WHY THIS CANNOT BE A .sql FILE
# ==================================================================================================
#
# Everything in settlement-rpc.test.sql runs in ONE session, so "call it twice" there proves
# IDEMPOTENCE (the second call sees consumed_at and applies nothing) and nothing about CONCURRENCY.
# The interesting failure is two callers interleaving BEFORE either commits -- a webhook and a
# device callback arriving together, or Finatic retrying while the first delivery is still in
# flight -- and that needs two connections genuinely racing.
#
# `settle_order_payment` closes it with `SELECT ... FROM terminal_payment_intents WHERE id = ...
# FOR UPDATE` as its first act. The second session blocks on that row lock until the first commits,
# then reads consumed_at and applies nothing. Without the lock both would pass the consumed_at
# check, both would claim the orders, and both would try to write a ledger row.
#
# Run by supabase/tests/run-db-tests.mjs against the throwaway container. Never against a real
# database -- like its sibling, it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1)

RID=11111111-1111-4111-8111-111111111111
TAB=22222222-2222-4222-8222-222222222222
O1=aaaaaaaa-0000-4000-8000-000000000154
O2=aaaaaaaa-0000-4000-8000-000000000155
INTENT=33333333-3333-4333-8333-33333333cccc

echo "=== seeding a two-order settlement with an intent ==="
"${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.payment_tips;
DELETE FROM public.audit_logs;
DELETE FROM public.payment_events;
DELETE FROM public.terminal_payment_intents;
DELETE FROM public.orders;
DELETE FROM public.tabs;
DELETE FROM public.users;
DELETE FROM public.restaurants;

INSERT INTO public.restaurants (id, name) VALUES ('$RID', 'Riviera');
INSERT INTO public.tabs (id, restaurant_id, total) VALUES ('$TAB', '$RID', 720);
INSERT INTO public.orders
  (id, restaurant_id, tab_id, order_number, status, payment_status, payment_method, total,
   pending_charge_cents, pending_settlement_id)
VALUES
  ('$O1', '$RID', '$TAB', 154, 'pending', 'pending', 'cash', 220, 22000,
   '44444444-4444-4444-8444-444444444444'),
  ('$O2', '$RID', '$TAB', 155, 'pending', 'pending', 'cash', 500, 50000,
   '44444444-4444-4444-8444-444444444444');
INSERT INTO public.terminal_payment_intents
  (id, restaurant_id, tab_id, merchant_order_no, amount_cents, scope, order_ids, status)
VALUES ('$INTENT', '$RID', '$TAB', 'MO-RACE', 72000, 'orders',
        ARRAY['$O1','$O2']::uuid[], 'launched');
SQL

SETTLE="SELECT public.settle_order_payment(
  '$RID',
  ARRAY['$O1','$O2']::uuid[],
  72000, 72000, 'TXN-RACE', 'MO-RACE', 'card', 'MO-RACE', '$INTENT',
  'concurrency_probe', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.38')::text;"

echo "=== firing two settlements at once ==="
# Both are launched into the background with no ordering between them. Each opens its own session,
# so whichever wins the FOR UPDATE on the intent row decides the outcome.
"${PSQL[@]}" -c "$SETTLE" > /tmp/race-a.out 2>/tmp/race-a.err &
PID_A=$!
"${PSQL[@]}" -c "$SETTLE" > /tmp/race-b.out 2>/tmp/race-b.err &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?

A=$(cat /tmp/race-a.out)
B=$(cat /tmp/race-b.out)
echo "  A(exit $EXIT_A): ${A:-<empty>} $(head -c 200 /tmp/race-a.err)"
echo "  B(exit $EXIT_B): ${B:-<empty>} $(head -c 200 /tmp/race-b.err)"

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}

echo "=== assertions ==="

# Both calls must SUCCEED. A deadlock or an exception would mean the lock ordering is wrong, and a
# thrown settlement is a payment the caller must retry -- correct, but not what should happen here.
check "both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"

APPLIED=$(printf '%s\n%s\n' "$A" "$B" | grep -c '"applied": true' || true)
check "exactly one session applied the settlement" "$APPLIED" "1"

CONSUMED=$(printf '%s\n%s\n' "$A" "$B" | grep -c 'already_consumed' || true)
check "the loser was told it was already consumed" "$CONSUMED" "1"

PAID=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status='paid';")
check "both orders are paid" "$PAID" "2"

# Financial invariant 6. Two sale rows for one gateway transaction is the duplicate-charge shape,
# and the ON CONFLICT plus the unique index are what make it unreachable.
EVENTS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.payment_events WHERE event_type='sale';")
check "exactly one ledger row exists" "$EVENTS" "1"

# One settlement, one audit row. Two would make an auditor believe the customer was charged twice.
AUDITS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.audit_logs WHERE action='payment.settlement_applied';")
check "exactly one settlement audit row" "$AUDITS" "1"

METHOD=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_method <> 'card';")
check "no order was left on its old method" "$METHOD" "0"

if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
