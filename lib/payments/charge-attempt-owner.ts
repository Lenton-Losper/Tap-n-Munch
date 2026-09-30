/**
 * ONE CARD ATTEMPT PER ORDER, OWNED BY THE TERMINAL THAT PREPARED IT (RC-RACES, 2026-09-30).
 *
 * An order has ONE merchant reference (`paycloud_merchant_order_no`), so two terminals preparing it
 * at the same moment were both handed that reference and both opened a reader. The second charge
 * then correlated to the first everywhere -- webhook, sale event, device callback -- and was
 * recorded nowhere. See supabase/migrations/20260930110000_charge_attempt_owned_by_one_terminal.sql.
 *
 * The migration's trigger (SQLSTATE FTOWN) is what makes the refusal hold under a race. This module
 * is the route's early read of the same rule, so the common case is refused before anything is
 * written, and the one 409 body both paths answer with.
 */

/**
 * The in-flight window every guard uses: orders_refuse_edit_during_charge, amend_order_lines'
 * payment_in_flight, release_stale_card_attempts, and the FTOWN trigger. Past it the attempt is
 * treated as dead and another terminal may take over, as cash already may.
 */
export const CHARGE_ATTEMPT_WINDOW_SECONDS = 300

/** The trigger's SQLSTATE. */
export const CHARGE_OWNED_ELSEWHERE_SQLSTATE = 'FTOWN'

export type ChargeOwnerRow = {
  id?: unknown
  order_number?: unknown
  pending_charge_cents?: unknown
  pending_charge_at?: unknown
  pending_charge_terminal_id?: unknown
}

/**
 * Seconds until the other terminal's attempt lapses, or null when this terminal may prepare. Mirrors
 * the trigger exactly: an unknown owner is not refused, a missing timestamp is (fails closed).
 */
export function secondsUntilAttemptLapses(
  row: ChargeOwnerRow,
  terminalId: string,
  now: number = Date.now(),
): number | null {
  if (row.pending_charge_cents == null) return null
  const owner = String(row.pending_charge_terminal_id ?? '').trim()
  if (!owner || owner === terminalId) return null
  const at = row.pending_charge_at == null ? NaN : Date.parse(String(row.pending_charge_at))
  if (!Number.isFinite(at)) return CHARGE_ATTEMPT_WINDOW_SECONDS
  const left = CHARGE_ATTEMPT_WINDOW_SECONDS - (now - at) / 1000
  return left > 0 ? Math.ceil(left) : null
}

/**
 * 409 SETTLEMENT_SET_NOT_CLAIMABLE, deliberately: every terminal build since F-TERMPAY treats that
 * code as a refusal BEFORE the reader opened (no verify, no failure callback, refresh the table).
 * A new code would reach older builds as an unknown error and be verified as an ambiguous payment.
 * `payment_in_progress_elsewhere` and the per-order reason say what actually happened.
 */
export function chargeOwnedElsewhereBody(
  rows: ChargeOwnerRow[],
  retryAfterSeconds: number,
): Record<string, unknown> {
  return {
    error:
      'A card payment for this bill is already in progress on another terminal. Wait for it to ' +
      'finish or cancel it there, then refresh the table.',
    code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
    payment_in_progress_elsewhere: true,
    retry_after_seconds: Math.max(1, retryAfterSeconds),
    orders: rows.map((r) => ({ order_id: String(r.id), payment_status: 'pending', status: null })),
    not_claimable: rows.map((r) => ({
      order_id: String(r.id),
      order_number: r.order_number == null ? null : Number(r.order_number),
      reason: 'payment_in_progress_elsewhere',
    })),
  }
}

/**
 * AN EARLIER CARD ATTEMPT'S OUTCOME IS UNKNOWN (RC-RACES D4, 20260930110100).
 *
 * The P5 said "not confirmed" and Finatic had no record, so the charge may exist. No new charge may
 * be prepared for these orders until it is resolved -- "Check payment status" (verify-payment), or a
 * staff release (dashboard cancel, or a cash / Mark-as-Paid settlement once the attempt is stale).
 * The trigger (SQLSTATE FTUNR) enforces this for every writer; this is the route's early read.
 */
export const CHARGE_UNRESOLVED_SQLSTATE = 'FTUNR'

export type UnresolvedRow = ChargeOwnerRow & { pending_charge_unresolved_at?: unknown }

export function hasUnresolvedAttempt(row: UnresolvedRow): boolean {
  return row.pending_charge_cents != null && row.pending_charge_unresolved_at != null
}

/** 409 SETTLEMENT_SET_NOT_CLAIMABLE for the same reason as chargeOwnedElsewhereBody. */
export function unresolvedAttemptBody(rows: UnresolvedRow[]): Record<string, unknown> {
  return {
    error:
      'An earlier card payment for this bill was not confirmed and may have gone through. Use ' +
      '"Check payment status" first. Nothing has been charged again.',
    code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
    refusal: 'PAYMENT_ATTEMPT_UNRESOLVED',
    payment_attempt_unresolved: true,
    resolution: 'check_payment_status',
    orders: rows.map((r) => ({ order_id: String(r.id), payment_status: 'pending', status: null })),
    not_claimable: rows.map((r) => ({
      order_id: String(r.id),
      order_number: r.order_number == null ? null : Number(r.order_number),
      reason: 'payment_attempt_unresolved',
    })),
  }
}
