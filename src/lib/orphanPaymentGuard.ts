/**
 * #344 — may a recovered orphaned payment be applied to the order on screen?
 *
 * THE DEFECT THIS CLOSES. `consumeOrphanedIfAny()` returns a card payment the device recovered
 * after process death. Both call sites in payment.ts returned it as the result for WHICHEVER order
 * was on screen, with no check of which order it actually belonged to. If the app died after the
 * reader's callback for order A and staff then started a payment on order B, B was reported paid
 * carrying A's voucher and A stayed unpaid — and the server's amount gate could not catch it,
 * because the amount sent was B's own total and matched B exactly.
 *
 * THE RULING, 2026-08-25, three cases and no fourth:
 *
 *   1. the orphan names THIS order          APPLY.  What the mechanism was built for.
 *   2. it names a DIFFERENT order           HOLD.   Do not apply, and do not discard.
 *   3. it names no order at all             HOLD.   UNKNOWN IS NOT PERMISSION.
 *
 * CASE 3 IS THE ONE TO NOT GET CLEVER ABOUT. The comment this replaces read "Prefer applying orphan
 * only when it matches this order (or order id unknown)" — and that parenthesis is the defect. An
 * orphan whose order cannot be established is the same "cannot say" state as #327's
 * `left_pending_finatic_uncertain`, and the standing rule there is that not knowing never
 * authorises the favourable action.
 *
 * HOLD IS NOT DISCARD. A held orphan is a card transaction that really happened; dropping it loses
 * money that was actually taken. Persistence is the caller's job (see storage.ts) and it must
 * survive the app being killed.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */

export type OrphanDisposition = 'apply' | 'hold';

/** Why an orphan was held — for the record that is persisted, and for what staff are told. */
export type OrphanHoldReason = 'different_order' | 'unknown_order';

export type OrphanDecision =
  | {disposition: 'apply'}
  | {disposition: 'hold'; reason: OrphanHoldReason};

/**
 * Split an order identifier into its ids.
 *
 * A TAB SETTLE CHARGES SEVERAL ORDERS AT ONCE and passes them as a comma-separated list — see
 * resolvePrepareOrderId in payment.ts, and TableDetailScreen's `orderIds.join(',')`. Native stores
 * whatever JS handed `launchPayment`, which is that whole string, so both sides of this comparison
 * can be lists.
 */
function idSet(raw: string | undefined | null): string[] {
  return String(raw ?? '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(part => part.length > 0)
    .sort();
}

/**
 * Decide what to do with a recovered orphan, given the order currently being charged.
 *
 * COMPARED AS SETS, NOT AS STRINGS, and this is a deliberate implementation choice inside the
 * ruling rather than a widening of it. A tab settle derives its id list at the moment of the
 * charge, so a retry can legitimately produce the same orders in a different order or with
 * different spacing; plain string equality would call that a mismatch and hold a payment that
 * genuinely belongs to this charge.
 *
 * EQUALITY, NOT OVERLAP. A partial match must HOLD. An orphan covering {A,B} applied to a charge
 * for {A} would settle the wrong amount, which is the same class of defect this guard exists to
 * prevent — so anything short of the same set is case 2.
 */
export function decideOrphanDisposition(
  orphanOrderId: string | undefined | null,
  currentOrderId: string | undefined | null,
): OrphanDecision {
  const orphanIds = idSet(orphanOrderId);

  // Case 3. Native writes "" rather than omitting the key, so empty-after-trim is the real test.
  if (orphanIds.length === 0) {
    return {disposition: 'hold', reason: 'unknown_order'};
  }

  const currentIds = idSet(currentOrderId);
  if (currentIds.length === 0) {
    // Nothing to compare against. Same rule as case 3: not knowing is not permission.
    return {disposition: 'hold', reason: 'unknown_order'};
  }

  const same =
    orphanIds.length === currentIds.length &&
    orphanIds.every((id, i) => id === currentIds[i]);

  return same
    ? {disposition: 'apply'}
    : {disposition: 'hold', reason: 'different_order'};
}
