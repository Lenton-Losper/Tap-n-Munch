#!/usr/bin/env bash
# A CARD CHARGE AND AN ORDER EDIT IN TWO REAL SESSIONS (Sprint 2026-09-29 brief, task 5).
# Sibling of amend-race.test.sh -- see concurrency.test.sh for why a race cannot be tested from one
# psql pipe. Seeds through amend-rpc.test.sql's _seed_amend() (order #160, N$400) and uses the
# helpers charge-edit-race.test.sql defines.
#
# THE INVARIANT: a payment charges and settles against the same version of the order. Every round
# ends by asserting that nothing was ever paid at a figure the order does not have.
#
# ROUND 1. prepare-payment has written the expectation (uncommitted) when the guest's edit arrives.
#          The edit must wait for the row and then be REFUSED (FTINF), and the charge settles at the
#          order's figure.
# ROUND 2. The guest's edit is committing when prepare-payment writes the figure it computed from
#          the order BEFORE the edit. The write must wait and then be REFUSED (FTCHG): the reader is
#          never launched for the stale figure.
# ROUND 3. prepare-payment has written the expectation (uncommitted) when a waiter voids a line.
#          amend_order_lines must wait and refuse 'payment_in_flight'.
# ROUND 4. A void is committing when prepare-payment writes its pre-void figure: REFUSED (FTCHG).
# ROUND 5. The in-flight window has lapsed and a guest edit is committing when the gateway's late
#          confirmation of the OLD figure lands. The settlement must wait and then HOLD, not pay.
#
# Run by supabase/tests/run-db-tests.mjs against the throwaway container only -- it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1 -v VERBOSITY=verbose)
TMP=$(mktemp -d)

RID=11111111-1111-4111-8111-111111111111
TAB=22222222-2222-4222-8222-222222222222
ORDER=bbbbbbbb-0000-4000-8000-000000000160
LINE=cccccccc-0000-4000-8000-000000000001

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}
q() { "${PSQL[@]}" -c "$1"; }

GUEST_EDIT="UPDATE public.orders
   SET items = items || '[{\"name\":\"Dessert\",\"quantity\":1,\"price\":50,\"total\":50}]'::jsonb,
       total = total + 50
 WHERE id = '$ORDER';"
PREPARE_40000="UPDATE public.orders SET pending_charge_cents = 40000,
       pending_settlement_id = '44444444-4444-4444-8444-444444444160' WHERE id = '$ORDER';"
VOID_PASTA="SELECT public.amend_order_lines('$RID', '$TAB', 950, 'terminal', NULL,
    '[{\"line_id\":\"$LINE\",\"new_quantity\":0}]'::jsonb)::text;"

# Never paid at a figure the order does not have: a paid order's charged figure equals its total.
no_wrong_paid() {
  q "SELECT count(*) FROM public.orders WHERE id = '$ORDER' AND payment_status = 'paid'
       AND (SELECT count(*) FROM public.order_lines WHERE order_id = '$ORDER' AND kitchen_state = 'voided') = 0
       AND round(total * 100) <> 40000;"
}

echo "=== round 1: guest edit while the charge is being prepared ==="
q "SELECT public._seed_amend();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$PREPARE_40000
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "$GUEST_EDIT" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  prepare(exit $EXIT_A) $(head -c 200 "$TMP/a.err")"
echo "  edit(exit $EXIT_B) $(head -c 200 "$TMP/b.err")"
check "round1 the prepare committed" "$EXIT_A" "0"
check "round1 the edit was refused FTINF" "$(grep -c 'FTINF' "$TMP/b.err")" "1"
check "round1 the total did not move" "$(q "SELECT total FROM public.orders WHERE id = '$ORDER';")" "400"
R=$(q "SELECT public._cr_settle(40000)->>'ok';")
check "round1 the charge settles at the order's figure" "$R" "true"
check "round1 never paid at a figure the order does not have" "$(no_wrong_paid)" "0"

echo "=== round 2: prepare writes a figure read before a committing guest edit ==="
q "SELECT public._seed_amend();" >/dev/null
BASIS=$(q "SELECT public.charge_basis(o) FROM public.orders o WHERE o.id = '$ORDER';")
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$GUEST_EDIT
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "UPDATE public.orders SET pending_charge_cents = 40000, pending_charge_read_basis = '$BASIS' WHERE id = '$ORDER';" \
  > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  edit(exit $EXIT_A) $(head -c 200 "$TMP/a.err")"
echo "  prepare(exit $EXIT_B) $(head -c 200 "$TMP/b.err")"
check "round2 the edit committed" "$EXIT_A" "0"
check "round2 the stale prepare was refused FTCHG" "$(grep -c 'FTCHG' "$TMP/b.err")" "1"
check "round2 no expectation was recorded" \
  "$(q "SELECT COALESCE(pending_charge_cents::text, 'null') FROM public.orders WHERE id = '$ORDER';")" "null"

echo "=== round 3: staff void while the charge is being prepared ==="
q "SELECT public._seed_amend();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$PREPARE_40000
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "$VOID_PASTA" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  prepare(exit $EXIT_A)  void(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 300) $(head -c 200 "$TMP/b.err")"
check "round3 both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"
check "round3 the void was refused payment_in_flight" \
  "$(grep -o '"reason": "payment_in_flight"' "$TMP/b.out" | wc -l | tr -d ' ')" "1"
check "round3 the line is still live" \
  "$(q "SELECT kitchen_state FROM public.order_lines WHERE id = '$LINE';")" "outstanding"
R=$(q "SELECT public._cr_settle(40000)->>'ok';")
check "round3 the charge settles at the order's figure" "$R" "true"
check "round3 never paid at a figure the order does not have" "$(no_wrong_paid)" "0"

echo "=== round 4: prepare writes a figure read before a committing void ==="
q "SELECT public._seed_amend();" >/dev/null
BASIS=$(q "SELECT public.charge_basis(o) FROM public.orders o WHERE o.id = '$ORDER';")
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$VOID_PASTA
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "UPDATE public.orders SET pending_charge_cents = 40000, pending_charge_read_basis = '$BASIS' WHERE id = '$ORDER';" \
  > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  void(exit $EXIT_A) $(head -c 200 "$TMP/a.err")"
echo "  prepare(exit $EXIT_B) $(head -c 200 "$TMP/b.err")"
check "round4 the void committed" "$EXIT_A" "0"
check "round4 the stale prepare was refused FTCHG" "$(grep -c 'FTCHG' "$TMP/b.err")" "1"
check "round4 no expectation was recorded" \
  "$(q "SELECT COALESCE(pending_charge_cents::text, 'null') FROM public.orders WHERE id = '$ORDER';")" "null"

echo "=== round 5: late gateway confirmation races a guest edit after the window ==="
q "SELECT public._seed_amend();" >/dev/null
q "$PREPARE_40000" >/dev/null
q "SELECT public._cr_expire_window();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$GUEST_EDIT
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "SELECT public._cr_settle(40000)::text;" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  edit(exit $EXIT_A) $(head -c 200 "$TMP/a.err")"
echo "  settle(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 300) $(head -c 200 "$TMP/b.err")"
check "round5 both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"
check "round5 the settlement was held, not applied" \
  "$(grep -o '"reason": "order_changed_since_preparation"' "$TMP/b.out" | wc -l | tr -d ' ')" "1"
check "round5 the order is held for review" \
  "$(q "SELECT payment_status FROM public.orders WHERE id = '$ORDER';")" "amount_mismatch_hold"
check "round5 the hold is recorded" \
  "$(q "SELECT count(*) FROM public.audit_logs WHERE action = 'payment.held_order_changed_since_charge_prepared';")" "1"

rm -rf "$TMP"
if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
