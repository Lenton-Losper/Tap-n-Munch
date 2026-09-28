#!/usr/bin/env bash
# A MANUAL PAYMENT AND A CARD ATTEMPT IN TWO REAL SESSIONS (Sprint 2026-09-29, 20260929100100).
# Sibling of charge-edit-race.test.sh. Seeds through manual-ledger.test.sql's _ml_seed() /
# _ml_card_attempt() / _ml_mark_paid(), which run-db-tests.mjs defines before calling this.
#
# THE RULING: a manual payment is a fresh charge at the live amount. It never races a card attempt
# that may be running, and it never settles over a stale one.
#
# ROUND 1 (INSIDE the window). prepare-payment is writing a card charge (uncommitted) when staff
#          press Mark-as-Paid. The manual payment must WAIT for the row, then be REFUSED
#          payment_in_flight -- nothing paid, no ledger row.
# ROUND 2 (OUTSIDE the window). Mark-as-Paid is releasing a dead attempt and paying (uncommitted)
#          when the gateway's late claim for that attempt arrives. The claim must WAIT, then match
#          nothing: one payment, recorded once, by the method staff named.
#
# Run by supabase/tests/run-db-tests.mjs against the throwaway container only -- it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1)
TMP=$(mktemp -d)
ORDER=bbbbbbbb-0000-4000-8000-000000000001

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}
q() { "${PSQL[@]}" -c "$1"; }

echo "=== round 1: Mark-as-Paid while a card charge is being prepared ==="
q "SELECT public._ml_seed();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
UPDATE public.orders SET pending_charge_cents = 22000 WHERE id = '$ORDER';
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "SELECT public._ml_mark_paid('$ORDER', 'pending', 22000, 'cash')->>'reason';" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
check "round1 the prepare committed" "$EXIT_A" "0"
check "round1 the manual payment was refused as in flight" "$(tr -d '[:space:]' < "$TMP/b.out")" "payment_in_flight"
check "round1 nothing paid" "$(q "SELECT payment_status FROM public.orders WHERE id = '$ORDER';")" "pending"
check "round1 no ledger row" "$(q "SELECT count(*) FROM public.non_gateway_payment_events;")" "0"
check "round1 the attempt is intact" "$(q "SELECT pending_charge_cents FROM public.orders WHERE id = '$ORDER';")" "22000"

echo "=== round 2: the gateway's late claim for a dead attempt while Mark-as-Paid releases it ==="
q "SELECT public._ml_cleanup(); SELECT public._ml_seed(); SELECT public._ml_card_attempt(interval '10 minutes');" >/dev/null
"${PSQL[@]}" > "$TMP/c.out" 2> "$TMP/c.err" <<SQL &
BEGIN;
SELECT public._ml_mark_paid('$ORDER', 'pending', 22000, 'cash')->>'ok';
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_C=$!
sleep 0.5
# markOrderPaidConfirmed's claim: only a claimable order moves to paid.
q "WITH c AS (UPDATE public.orders SET payment_status = 'paid', payment_method = 'card'
     WHERE id = '$ORDER' AND payment_status IN ('pending', 'terminal_pending') RETURNING 1)
   SELECT count(*) FROM c;" > "$TMP/d.out" 2> "$TMP/d.err" &
PID_D=$!
wait $PID_C; EXIT_C=$?
wait $PID_D; EXIT_D=$?
check "round2 the manual payment committed" "$EXIT_C" "0"
check "round2 the late gateway claim matched nothing" "$(tr -d '[:space:]' < "$TMP/d.out")" "0"
check "round2 paid once, by the method staff named" "$(q "SELECT payment_status || '/' || payment_method FROM public.orders WHERE id = '$ORDER';")" "paid/cash"
check "round2 one ledger row" "$(q "SELECT count(*) FROM public.non_gateway_payment_events;")" "1"
check "round2 the dead attempt was released" "$(q "SELECT count(*) FROM public.orders WHERE id = '$ORDER' AND pending_charge_cents IS NULL;")" "1"
check "round2 its intent expired" "$(q "SELECT status FROM public.terminal_payment_intents WHERE merchant_order_no = 'FT-ML-ATTEMPT';")" "failed"

q "SELECT public._ml_cleanup();" >/dev/null
rm -rf "$TMP"
if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAIL"; fi
