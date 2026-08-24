import type { GuestOrderRow } from './types'

/**
 * #279 — what a tablemate is allowed to see, stated as an ALLOWLIST.
 *
 * `select('*')` minus one field is not a redaction: it ships every column the table happens to
 * have, including ones added later by someone who never considered this route. This names what
 * earns its place and drops everything else, so a new column is private by default.
 *
 * DROPPED, and why each matters:
 *   session_id, member_session_id  a session id is a CAPABILITY elsewhere (#282) --
 *                                  fetchGuestOrdersBySession fetches a diner's orders by it. Handing
 *                                  it out turns a disclosure into an escalation, which is why it
 *                                  goes regardless of who is allowed to call this.
 *   customer_name                  a real person's name, of no use to the caller's own screen.
 *   items                          what someone ordered is the private part, and the only consumer
 *                                  of this route (the QR landing) never reads it.
 *   payment_reference,             identifiers that address an order on other routes; the caller
 *   paycloud_merchant_order_no     already holds the id it needs.
 *   customer_email, edit_lock_token, everything else.
 */
const TABLEMATE_FIELDS = [
  /** The caller addresses the order with it — the resume-payment link is built from this. */
  'id',
  /** What a customer is told to quote to staff. */
  'order_number',
  /** Drives which banner state the landing renders. */
  'status',
  /** Distinguishes "resume payment" from "being prepared". */
  'payment_status',
  /** The landing asks a specifically hosted-checkout question and must render the right prompt. */
  'payment_channel',
  /** Used to age the order — the landing's ten-minute abandoned-checkout window. */
  'placed_at',
  /** Shown in the active-order banner. */
  'total',
  /** The client scopes what it renders to the table it is standing at. */
  'table_number',
  /** Live vs settled, which the caller cannot infer from status alone. */
  'is_closed',
] as const

/**
 * Both of these are DERIVED by redactGuestOrderRow rather than read from the row: `surface` says
 * which table it came from, and `edit_lock_held` is a boolean standing in for a token that is
 * never returned. They are safe and the edit panel needs them.
 */
const DERIVED_FIELDS = ['surface', 'edit_lock_held', 'isMine'] as const

/**
 * #279 + the regression it caused. The banner asks "is this MINE", and it used to answer that by
 * comparing `order.session_id` to its own — so dropping session_id here made every row fail that
 * check and the Active Order Banner rendered nothing for anybody. Twelve staging deploys shipped
 * over the E2E control that said so.
 *
 * THE SERVER ANSWERS THE QUESTION INSTEAD OF HANDING OVER THE IDENTIFIER. `isMine` is derived here,
 * not read from the row: the caller only ever receives rows that matched their own session ids
 * (`fetchGuestActiveTableOrders` queries BOTH placer columns with `.in(column, heldIds)`), so every
 * row it returns is theirs by construction.
 *
 * Another diner's order is therefore ABSENT rather than `isMine: false`, and absent is the safer
 * shape: a row that never leaves the server cannot be exposed by a client bug. Sending it with a
 * flag would mean shipping a stranger's order number, items and total to the browser and trusting
 * the client to hide it — which is exactly what #302/#305 did, and it was rolled back within the
 * hour.
 */
export function projectTablemateOrder(row: Record<string, unknown>): GuestOrderRow {
  const out: Record<string, unknown> = { isMine: true }
  for (const key of [...TABLEMATE_FIELDS, ...DERIVED_FIELDS]) {
    if (key in row) out[key] = row[key]
  }
  out.isMine = true
  return out as GuestOrderRow
}

export const TABLEMATE_ALLOWLIST: readonly string[] = [...TABLEMATE_FIELDS, ...DERIVED_FIELDS]
