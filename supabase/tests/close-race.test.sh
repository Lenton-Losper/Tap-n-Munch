#!/usr/bin/env bash
# SETTLEMENT vs TAB CLOSE, IN TWO REAL SESSIONS.
#
# ==================================================================================================
# THE GAP THIS COVERS
# ==================================================================================================
#
# `close_table_session(p_table_id, p_restaurant_id)` settles every active tab on a table with a bare
#
#     UPDATE tabs SET status='settled', settled_at=now(), settled_type='manual_close'
#
# It never touches `orders`, and before 2026-09-19 it took no lock that `settle_order_payment` took
# either. The two lock sets were DISJOINT, so a waiter closing the table and a card settlement
# landing could interleave freely and whichever committed last decided the state -- with nothing
# recording that the other had happened.
#
# `settle_order_payment` now takes the tab row FOR UPDATE before it locks any order, so the two
# serialise. This exercises that, in two genuinely racing sessions, both orderings.
#
# ==================================================================================================
# WHAT THE CORRECT BEHAVIOUR IS, AND WHY IT IS NOT A REFUSAL
# ==================================================================================================
#
# By the time the settlement runs the card HAS been charged. Refusing on a closed tab would leave a
# real charge with no settlement recorded -- a payment SILENTLY LOST, which is the outcome this is
# meant to prevent, not cause. So the settlement applies either way and `tab_was_closed` records
# that it landed on a tab somebody had already closed.
#
# Run against the throwaway container only. It INSERTS.
set -uo pipefail

CONTAINER=${CONTAINER:-ft-harden-pg}
DB=${DB:-flashtap_test}
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1)

RID=11111111-1111-4111-8111-111111111111
TABLE=55555555-5555-4555-8555-5555555555aa
TAB=22222222-2222-4222-8222-222222222222
O1=aaaaaaaa-0000-4000-8000-000000000154
O2=aaaaaaaa-0000-4000-8000-000000000155

FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 -- expected $3, got $2"; FAIL=1; fi
}

seed() {
  "${PSQL[@]}" >/dev/null <<SQL
DELETE FROM public.payment_tips;
DELETE FROM public.audit_logs;
DELETE FROM public.payment_events;
DELETE FROM public.terminal_payment_intents;
DELETE FROM public.orders;
DELETE FROM public.tabs;
DELETE FROM public.customer_sessions;
DELETE FROM public.restaurant_tables;
DELETE FROM public.users;
DELETE FROM public.restaurants;

INSERT INTO public.restaurants (id, name) VALUES ('$RID', 'Riviera');
INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, active, status,
                                      current_session_version)
VALUES ('$TABLE', '$RID', 7, true, 'occupied', 1);
INSERT INTO public.tabs (id, restaurant_id, table_id, status, total)
VALUES ('$TAB', '$RID', '$TABLE', 'open', 720);
INSERT INTO public.orders
  (id, restaurant_id, tab_id, table_id, order_number, status, payment_status, payment_method,
   total, pending_charge_cents)
VALUES
  ('$O1', '$RID', '$TAB', '$TABLE', 154, 'pending', 'pending', 'cash', 220, 22000),
  ('$O2', '$RID', '$TAB', '$TABLE', 155, 'pending', 'pending', 'cash', 500, 50000);
SQL
}

SETTLE="SELECT public.settle_order_payment(
  '$RID', ARRAY['$O1','$O2']::uuid[], 72000, 72000, 'TXN-CLOSE', 'MO-CLOSE', 'card', 'MO-CLOSE',
  NULL, 'close_race_probe', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.38')::text;"
CLOSE="SELECT public.close_table_session('$TABLE', '$RID')::text;"

# --------------------------------------------------------------------------------------------
echo "=== ROUND 1: settlement and close fired together ==="
seed
"${PSQL[@]}" -c "$SETTLE" > /tmp/cr-settle.out 2>/tmp/cr-settle.err &
PS=$!
"${PSQL[@]}" -c "$CLOSE"  > /tmp/cr-close.out  2>/tmp/cr-close.err &
PC=$!
wait $PS; ES=$?
wait $PC; EC=$?
S=$(cat /tmp/cr-settle.out); C=$(cat /tmp/cr-close.out)
echo "  settle(exit $ES): ${S:0:160} $(head -c 160 /tmp/cr-settle.err)"
echo "  close (exit $EC): ${C:0:160} $(head -c 160 /tmp/cr-close.err)"

check "both sessions completed (no deadlock, no exception)" "$ES$EC" "00"

# THE MONEY. Whatever the interleaving, the charge is real and must be recorded exactly once.
PAID=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status='paid';")
check "both orders settled" "$PAID" "2"
NOTPAID=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status <> 'paid';")
check "no order left unpaid (the payment was not lost)" "$NOTPAID" "0"
EV=$("${PSQL[@]}" -c "SELECT count(*) FROM public.payment_events WHERE event_type='sale';")
check "exactly one ledger row" "$EV" "1"
AU=$("${PSQL[@]}" -c "SELECT count(*) FROM public.audit_logs WHERE action='payment.settlement_applied';")
check "exactly one settlement audit row (no duplicate allocation)" "$AU" "1"
METH=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_method <> 'card';")
check "payment method is the gateway's" "$METH" "0"

# THE TAB. The close wins or loses, but it never leaves the tab half-closed.
TS=$("${PSQL[@]}" -c "SELECT status FROM public.tabs WHERE id='$TAB';")
if [ "$TS" = "settled" ] || [ "$TS" = "open" ]; then
  echo "  PASS tab is in one of the two legal states (got '$TS')"
else
  echo "  FAIL tab is in an illegal state: '$TS'"; FAIL=1
fi

# NEVER SILENT. If the close committed first, the settlement must say so.
CLOSEDFLAG=$("${PSQL[@]}" -c "SELECT COALESCE((SELECT metadata->>'tab_was_closed' FROM public.audit_logs WHERE action='payment.settlement_applied' LIMIT 1),'missing');")
if [ "$CLOSEDFLAG" = "true" ] || [ "$CLOSEDFLAG" = "false" ]; then
  echo "  PASS the settlement recorded whether the tab was already closed ($CLOSEDFLAG)"
else
  echo "  FAIL the settlement did not record tab_was_closed (got '$CLOSEDFLAG')"; FAIL=1
fi

# --------------------------------------------------------------------------------------------
echo "=== ROUND 2: the tab is closed FIRST, then the payment lands ==="
# The ordering that matters most -- a walkout-closed tab turning out to have been paid. The money
# must still be recorded, and it must be findable.
seed
"${PSQL[@]}" -c "$CLOSE" >/dev/null 2>&1
TS2=$("${PSQL[@]}" -c "SELECT status FROM public.tabs WHERE id='$TAB';")
check "the tab is closed before the settlement runs" "$TS2" "settled"

R2=$("${PSQL[@]}" -c "$SETTLE")
OK2=$(echo "$R2" | grep -c '"ok": true' || true)
check "the settlement still applied (the payment is NOT discarded)" "$OK2" "1"
FLAG2=$("${PSQL[@]}" -c "SELECT metadata->>'tab_was_closed' FROM public.audit_logs WHERE action='payment.settlement_applied' LIMIT 1;")
check "and it is flagged as having landed on a closed tab" "$FLAG2" "true"
PAID2=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status='paid';")
check "both orders settled on the closed tab" "$PAID2" "2"

# --------------------------------------------------------------------------------------------
echo "=== ROUND 3: a settled payment is never reverted by a later close ==="
seed
"${PSQL[@]}" -c "$SETTLE" >/dev/null 2>&1
"${PSQL[@]}" -c "$CLOSE"  >/dev/null 2>&1
PAID3=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status='paid';")
check "the close did not revert the settlement" "$PAID3" "2"
EV3=$("${PSQL[@]}" -c "SELECT count(*) FROM public.payment_events WHERE event_type='sale';")
check "and did not disturb the ledger" "$EV3" "1"

# --------------------------------------------------------------------------------------------
echo "=== ROUND 4: a second settlement after the close is still refused ==="
# Money must not be taken twice just because the tab state moved underneath it.
R4=$("${PSQL[@]}" -c "$SETTLE")
CLAIMED4=$(echo "$R4" | grep -o '"claimed_order_ids": \[\]' | wc -l)
check "the replay claimed nothing" "$CLAIMED4" "1"
EV4=$("${PSQL[@]}" -c "SELECT count(*) FROM public.payment_events WHERE event_type='sale';")
check "still exactly one ledger row after the replay" "$EV4" "1"

# --------------------------------------------------------------------------------------------
echo "=== ROUND 5: the settlement SERIALISES a concurrent close ==="
#
# WHAT ROUNDS 1-4 ESTABLISHED, stated plainly because it is the useful finding here: the MONEY
# invariants hold with or without the explicit tab lock. A first version of mutation M10 removed
# that lock and rounds 1-4 stayed GREEN. The reasons are worth writing down:
#
#   * `close_table_session` never touches `orders`, so it cannot conflict with a settlement over
#     the rows that carry the money;
#   * the settlement's own per-order `FOR UPDATE` and its already-paid guard are what make double
#     settlement unreachable -- that is the protection this race actually rests on, and M10 now
#     targets it instead;
#   * the settlement's closing `UPDATE tabs SET total = ...` takes the tab row lock anyway, so the
#     two serialise even without an explicit one.
#
# The explicit `FOR UPDATE` is therefore lock-ORDER hygiene (tab before orders, always) and a
# well-defined read for `tab_was_closed`, not a money guard. It is not claimed to be more.
#
# This round pins the serialisation itself, with a deterministic window rather than a hoped-for
# one: session A holds its transaction open after the settlement returns, so it still holds every
# lock the function took, and B must wait.
seed

# A: settle, then sit on the locks for two seconds before committing.
( "${PSQL[@]}" <<SQL
BEGIN;
SELECT public.settle_order_payment(
  '$RID', ARRAY['$O1','$O2']::uuid[], 72000, 72000, 'TXN-HOLD', 'MO-HOLD', 'card', 'MO-HOLD',
  NULL, 'close_race_hold', 'term-1', 0, NULL, ARRAY[]::uuid[], '2.38');
SELECT pg_sleep(2);
COMMIT;
SQL
) >/dev/null 2>&1 &
PA=$!

sleep 0.5   # let A get past the settlement and into its sleep, still uncommitted

B_START=$(date +%s%N)
"${PSQL[@]}" -c "$CLOSE" >/dev/null 2>&1
B_END=$(date +%s%N)
wait $PA
B_MS=$(( (B_END - B_START) / 1000000 ))
echo "  the close waited ${B_MS}ms for the settlement's transaction"

# A holds for 2s and B starts 0.5s in, so a blocked close waits ~1.5s. A close that sails through
# in a few milliseconds saw no lock at all.
if [ "$B_MS" -gt 700 ]; then
  echo "  PASS the close BLOCKED on the settlement's tab lock (${B_MS}ms)"
else
  echo "  FAIL the close did not block -- it committed in ${B_MS}ms while the settlement was still open"
  FAIL=1
fi

# And the consequence that matters: the flag the settlement recorded is consistent with a tab that
# was open for the whole of its transaction.
FLAG5=$("${PSQL[@]}" -c "SELECT metadata->>'tab_was_closed' FROM public.audit_logs WHERE action='payment.settlement_applied' LIMIT 1;")
check "the settlement's closed-flag is a consistent read" "$FLAG5" "false"
TS5=$("${PSQL[@]}" -c "SELECT status FROM public.tabs WHERE id='$TAB';")
check "and the close still took effect afterwards" "$TS5" "settled"
PAID5=$("${PSQL[@]}" -c "SELECT count(*) FROM public.orders WHERE payment_status='paid';")
check "with the money recorded exactly once" "$PAID5" "2"

if [ "$FAIL" = "0" ]; then echo "RESULT=OK"; else echo "RESULT=FAILED"; fi
exit $FAIL
