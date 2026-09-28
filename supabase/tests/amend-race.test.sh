#!/usr/bin/env bash
# amend_order_lines IN TWO REAL SESSIONS. Sibling of concurrency.test.sh -- see its header for why a
# race cannot be tested from one psql pipe.
#
# ROUND 1. Two waiters amend the SAME line at the same moment. Exactly one may apply it: the
#          conditional UPDATE (`WHERE kitchen_state = 'outstanding'`) is what decides, and the loser
#          must be REFUSED, not given a second replacement order.
# ROUND 2. A settlement is mid-flight on the order (row locked, 'paid' written, not yet committed)
#          when the amendment arrives. The amendment must wait and refuse `order_paid` -- not read
#          the stale 'pending' and void a line that is about to be paid for.
# ROUND 3. A settlement holding the TAB (settle_order_payment's lock order: tab, then orders) when a
#          reduction arrives. Both must complete. Taking the orders before the tab would deadlock
#          here, because the replacement order's foreign key needs the tab.
#
# Run by supabase/tests/run-db-tests.mjs against the throwaway container only -- it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1)
TMP=$(mktemp -d)

RID=11111111-1111-4111-8111-111111111111
TAB=22222222-2222-4222-8222-222222222222
ORDER=bbbbbbbb-0000-4000-8000-000000000160
LINE=cccccccc-0000-4000-8000-000000000002

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}

seed() {
  # amend-rpc.test.sql's own seed, so the two suites share one fixture.
  "${PSQL[@]}" -c "SELECT public._seed_amend();" >/dev/null
}

amend() { # $1 = order number, $2 = new quantity
  echo "SELECT public.amend_order_lines('$RID', '$TAB', $1, 'terminal', NULL,
    '[{\"line_id\":\"$LINE\",\"new_quantity\":$2}]'::jsonb)::text;"
}

echo "=== round 1: two amendments of one line ==="
seed
# Session A holds its transaction open after amending, so B genuinely overlaps it.
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$(amend 920 1)
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
"${PSQL[@]}" -c "$(amend 921 1)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  A(exit $EXIT_A): $(tr -d '\n' < "$TMP/a.out" | head -c 300) $(head -c 200 "$TMP/a.err")"
echo "  B(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 300) $(head -c 200 "$TMP/b.err")"
check "round1 both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"
APPLIED=$(cat "$TMP/a.out" "$TMP/b.out" | grep -o '"action": "replaced"' | wc -l | tr -d ' ')
check "round1 exactly one session applied the amendment" "$APPLIED" "1"
REFUSED=$(cat "$TMP/a.out" "$TMP/b.out" | grep -o '"reason": "window_closed"' | wc -l | tr -d ' ')
check "round1 the other was refused window_closed" "$REFUSED" "1"
REPL=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE order_number IN (920, 921);")
check "round1 exactly one replacement order" "$REPL" "1"
VOIDS=$("${PSQL[@]}" -c "SELECT count(*) FROM public.order_line_events WHERE order_line_id = '$LINE' AND to_state = 'voided';")
check "round1 exactly one void event" "$VOIDS" "1"

echo "=== round 2: amendment during an uncommitted settlement ==="
seed
"${PSQL[@]}" > "$TMP/s.out" 2> "$TMP/s.err" <<SQL &
BEGIN;
UPDATE public.orders SET payment_status = 'paid', status = 'completed' WHERE id = '$ORDER';
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_S=$!
sleep 0.5
"${PSQL[@]}" -c "$(amend 930 0)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_S; EXIT_S=$?
wait $PID_B; EXIT_B=$?
echo "  settle(exit $EXIT_S)  amend(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 300) $(head -c 200 "$TMP/b.err")"
check "round2 both sessions returned cleanly" "$EXIT_S$EXIT_B" "00"
PAIDREF=$(grep -o '"reason": "order_paid"' "$TMP/b.out" | wc -l | tr -d ' ')
check "round2 the amendment was refused order_paid" "$PAIDREF" "1"
STATE=$("${PSQL[@]}" -c "SELECT bar_state FROM public.order_lines WHERE id = '$LINE';")
check "round2 the paid line was not voided" "$STATE" "outstanding"

echo "=== round 3: reduction while a settlement holds the tab ==="
seed
"${PSQL[@]}" > "$TMP/s.out" 2> "$TMP/s.err" <<SQL &
BEGIN;
SELECT 1 FROM public.tabs WHERE id = '$TAB' FOR UPDATE;
SELECT pg_sleep(1.0);
SELECT 1 FROM public.orders WHERE id = '$ORDER' FOR UPDATE;
SELECT pg_sleep(0.3);
COMMIT;
SQL
PID_S=$!
sleep 0.4
"${PSQL[@]}" -c "$(amend 940 1)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_S; EXIT_S=$?
wait $PID_B; EXIT_B=$?
echo "  settle(exit $EXIT_S) $(head -c 200 "$TMP/s.err")"
echo "  amend(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 300) $(head -c 200 "$TMP/b.err")"
check "round3 no deadlock: both sessions returned cleanly" "$EXIT_S$EXIT_B" "00"
REPL=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE order_number = 940;")
check "round3 the reduction applied after the settlement released the tab" "$REPL" "1"

rm -rf "$TMP"
if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
