#!/usr/bin/env bash
# TWO TERMINALS TAKING PAYMENT FOR ONE ORDER, IN TWO REAL SESSIONS (RC-RACES 2026-09-30, C6 / D4).
# Sibling of charge-edit-race.test.sh -- see concurrency.test.sh for why a race cannot be tested
# from one psql pipe. Seeds through charge-edit-race.test.sql's _seed_cr() (order #160, N$400, on
# the seeded tab), which run-db-tests.mjs defines before calling this.
#
# THE INVARIANT: one order, one card attempt in flight, owned by one terminal. The order has ONE
# merchant reference, so a second terminal's attempt would be a second charge on the same reference
# that nothing downstream can tell apart from the first (20260930110000).
#
# ROUND 1. Terminal A's prepare has written its expectation (uncommitted) when terminal B's prepare
#          writes one. B must WAIT for the row, then be REFUSED (FTOWN). A's attempt is intact.
# ROUND 2. The same terminal prepares twice at once (a retry). Both succeed -- the guard must not
#          lock a terminal out of its own attempt.
# ROUND 3. A's attempt is older than the in-flight window (the reader was abandoned). B takes over.
#          A dead terminal must never strand a table.
# ROUND 4. A's attempt was released (declined / settled). B prepares freely; the owner was cleared.
# ROUND 5. A writer that names no terminal (push-to-terminal, the QR receipt route) re-prepares while
#          A's attempt is live: allowed, and A still owns it.
# ROUND 7. The device reported the attempt UNCERTAIN (P5 9027, Finatic E04111): the attempt and every
#          order sharing its settlement are marked; no writer -- the launching terminal, another
#          terminal, an anonymous writer -- may prepare a new charge (FTUNR, 20260930110100).
# ROUND 8. Releasing the attempt clears the mark and the retry is allowed; an uncertain report with
#          no attempt in flight marks nothing.
# ROUND 9. The uncertain report is committing when a new prepare arrives: it waits, then is refused.
# ROUND 6. Two confirmations for two DIFFERENT references land on one order at once (the takeover
#          case: both readers answered). Exactly one pays the order; the other is refused and
#          recorded as paid by another payment -- never absorbed as a duplicate.
#
# Run by supabase/tests/run-db-tests.mjs against the throwaway container only -- it INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1 -v VERBOSITY=verbose)
TMP=$(mktemp -d)

RID=11111111-1111-4111-8111-111111111111
ORDER=bbbbbbbb-0000-4000-8000-000000000160
TA=7e000000-0000-4000-8000-00000000000a
TB=7e000000-0000-4000-8000-00000000000b

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}
q() { "${PSQL[@]}" -c "$1"; }

prepare() { # $1 = terminal id; what prepare-payment writes for the lead order
  echo "UPDATE public.orders SET pending_charge_cents = 40000,
       pending_settlement_id = '44444444-4444-4444-8444-444444444160',
       pending_charge_terminal_id = '$1' WHERE id = '$ORDER';"
}
owner() { q "SELECT COALESCE(pending_charge_terminal_id::text, 'none') FROM public.orders WHERE id = '$ORDER';"; }

echo "=== round 1: a second terminal prepares while the first terminal's write is in flight ==="
q "SELECT public._seed_cr();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$(prepare $TA)
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "$(prepare $TB)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  terminal A(exit $EXIT_A) $(head -c 200 "$TMP/a.err")"
echo "  terminal B(exit $EXIT_B) $(head -c 300 "$TMP/b.err" | tr '\n' ' ')"
check "round1 terminal A's prepare committed" "$EXIT_A" "0"
check "round1 terminal B was refused FTOWN" "$(grep -c 'FTOWN' "$TMP/b.err")" "1"
check "round1 terminal A still owns the attempt" "$(owner)" "$TA"
check "round1 A's expectation is intact" \
  "$(q "SELECT pending_charge_cents FROM public.orders WHERE id = '$ORDER';")" "40000"

echo "=== round 2: the same terminal prepares twice at once ==="
q "SELECT public._seed_cr();" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$(prepare $TA)
SELECT pg_sleep(1.0);
COMMIT;
SQL
PID_A=$!
sleep 0.4
q "$(prepare $TA)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
check "round2 both of the terminal's own writes succeeded" "$EXIT_A$EXIT_B" "00"
check "round2 it still owns the attempt" "$(owner)" "$TA"

echo "=== round 3: the first terminal's attempt has lapsed; another terminal takes over ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
q "UPDATE public.orders SET pending_charge_at = now() - interval '10 minutes' WHERE id = '$ORDER';" >/dev/null
q "$(prepare $TB)" > "$TMP/b.out" 2> "$TMP/b.err"; EXIT_B=$?
echo "  terminal B(exit $EXIT_B) $(head -c 200 "$TMP/b.err")"
check "round3 the takeover was allowed" "$EXIT_B" "0"
check "round3 terminal B owns the attempt" "$(owner)" "$TB"

echo "=== round 4: the first terminal's attempt was released ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
q "UPDATE public.orders SET pending_charge_cents = NULL, pending_settlement_id = NULL WHERE id = '$ORDER';" >/dev/null
check "round4 releasing the charge cleared its owner" "$(owner)" "none"
q "$(prepare $TB)" > "$TMP/b.out" 2> "$TMP/b.err"; EXIT_B=$?
check "round4 another terminal prepares freely" "$EXIT_B" "0"
check "round4 terminal B owns the attempt" "$(owner)" "$TB"

echo "=== round 5: a writer that names no terminal re-prepares a live attempt ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
q "UPDATE public.orders SET pending_charge_cents = 40000 WHERE id = '$ORDER';" > "$TMP/b.out" 2> "$TMP/b.err"; EXIT_B=$?
check "round5 the anonymous writer was not refused" "$EXIT_B" "0"
check "round5 terminal A still owns the attempt" "$(owner)" "$TA"

echo "=== round 6: two confirmations for two different references land at once ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
settle() { # $1 = reference
  echo "SELECT public.settle_order_payment('$RID', ARRAY['$ORDER']::uuid[], 40000, 40000,
     'TXN-$1', '$1', 'card', '$1', NULL, 'paycloud_webhook_valid_signature', 'term-1', 0,
     NULL, ARRAY[]::uuid[], '2.41')::text;"
}
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$(settle MO-RC-A)
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "$(settle MO-RC-B)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  A(exit $EXIT_A): $(tr -d '\n' < "$TMP/a.out" | head -c 240) $(head -c 200 "$TMP/a.err")"
echo "  B(exit $EXIT_B): $(tr -d '\n' < "$TMP/b.out" | head -c 240) $(head -c 200 "$TMP/b.err")"
check "round6 both sessions returned cleanly" "$EXIT_A$EXIT_B" "00"
check "round6 exactly one settlement applied" \
  "$(cat "$TMP/a.out" "$TMP/b.out" | grep -o '"ok": true' | wc -l | tr -d ' ')" "1"
check "round6 the other was refused as paid by another payment" \
  "$(grep -o '"reason": "order_paid_by_other_payment"' "$TMP/b.out" | wc -l | tr -d ' ')" "1"
check "round6 the order was paid once, by the first reference" \
  "$(q "SELECT payment_status || '/' || payment_reference FROM public.orders WHERE id = '$ORDER';")" "paid/MO-RC-A"
check "round6 one sale row for the order" \
  "$(q "SELECT count(*) FROM public.payment_events WHERE event_type = 'sale' AND '$ORDER' = ANY(order_ids);")" "1"

uncertain() { # what every failure / verify path writes when the outcome is unknown
  echo "INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
        VALUES ('$RID', 'payment.verification_uncertain', 'order', '$ORDER', '{\"isE04111\": true}');"
}
SIB=bbbbbbbb-0000-4000-8000-000000000162
unres() { q "SELECT CASE WHEN pending_charge_unresolved_at IS NULL THEN 'clear' ELSE 'unresolved' END FROM public.orders WHERE id = '$1';"; }

echo "=== round 7: after an uncertain outcome nobody may prepare a new charge, the launching terminal included ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
q "UPDATE public.orders SET pending_charge_cents = 8000, pending_settlement_id = '44444444-4444-4444-8444-444444444160' WHERE id = '$SIB';" >/dev/null
q "$(uncertain)" >/dev/null
check "round7 the attempt is marked unresolved" "$(unres $ORDER)" "unresolved"
check "round7 the sibling in the same attempt is marked too" "$(unres $SIB)" "unresolved"
q "$(prepare $TA)" > "$TMP/b.out" 2> "$TMP/b.err"; EXIT_A=$?
q "$(prepare $TB)" > "$TMP/c.out" 2> "$TMP/c.err"; EXIT_B=$?
q "UPDATE public.orders SET pending_charge_cents = 8000 WHERE id = '$SIB';" > "$TMP/d.out" 2> "$TMP/d.err"; EXIT_C=$?
echo "  same terminal(exit $EXIT_A) $(head -c 160 "$TMP/b.err" | tr '\n' ' ')"
check "round7 the launching terminal was refused FTUNR" "$(grep -c 'FTUNR' "$TMP/b.err")" "1"
check "round7 another terminal was refused FTUNR" "$(grep -c 'FTUNR' "$TMP/c.err")" "1"
check "round7 an anonymous writer (push / QR) was refused FTUNR" "$(grep -c 'FTUNR' "$TMP/d.err")" "1"
check "round7 the uncertain expectation is intact" \
  "$(q "SELECT pending_charge_cents || '/' || pending_charge_terminal_id FROM public.orders WHERE id = '$ORDER';")" "40000/$TA"

echo "=== round 8: releasing the attempt resolves it; the retry is allowed ==="
q "UPDATE public.orders SET pending_charge_cents = NULL, pending_settlement_id = NULL WHERE id IN ('$ORDER', '$SIB');" >/dev/null
check "round8 the release cleared the mark" "$(unres $ORDER)" "clear"
q "$(prepare $TA)" > "$TMP/b.out" 2> "$TMP/b.err"; EXIT_A=$?
check "round8 the retry after the release was allowed" "$EXIT_A" "0"
q "$(uncertain)" >/dev/null
q "UPDATE public.orders SET pending_charge_cents = NULL WHERE id = '$ORDER';" >/dev/null
q "INSERT INTO public.audit_logs (restaurant_id, action, entity_type, entity_id) VALUES ('$RID', 'payment.verification_uncertain', 'order', '$ORDER');" >/dev/null
check "round8 an uncertain report with no attempt in flight marks nothing" "$(unres $ORDER)" "clear"

echo "=== round 9: the uncertain report is committing when a new prepare arrives ==="
q "SELECT public._seed_cr();" >/dev/null
q "$(prepare $TA)" >/dev/null
"${PSQL[@]}" > "$TMP/a.out" 2> "$TMP/a.err" <<SQL &
BEGIN;
$(uncertain)
SELECT pg_sleep(1.5);
COMMIT;
SQL
PID_A=$!
sleep 0.5
q "$(prepare $TA)" > "$TMP/b.out" 2> "$TMP/b.err" &
PID_B=$!
wait $PID_A; EXIT_A=$?
wait $PID_B; EXIT_B=$?
echo "  report(exit $EXIT_A) $(head -c 160 "$TMP/a.err")"
echo "  prepare(exit $EXIT_B) $(head -c 200 "$TMP/b.err" | tr '\n' ' ')"
check "round9 the report committed" "$EXIT_A" "0"
check "round9 the prepare waited and was refused FTUNR" "$(grep -c 'FTUNR' "$TMP/b.err")" "1"

rm -rf "$TMP"
if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
