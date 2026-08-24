/**
 * THE ONE PLACE THAT REMEMBERS THE ORDER A CUSTOMER JUST PLACED.
 *
 * ActiveOrderBanner navigates with this id, so whichever screen placed the most recent order has to
 * record it. Two screens did (cart, order-secure) and two did not (browse, tab) — so an order placed
 * from browse or the tab left the banner pointing at an OLDER order, and tapping it opened that
 * order's confirmation. That is how a customer on order #23 was shown a link carrying #21's id.
 *
 * WHY A MODULE RATHER THAN TWO MORE WRITE SITES. There were four screens and there will be a fifth.
 * A convention that has to be remembered at each new call site is the convention that gets missed —
 * this defect IS that miss. Two keys are written because two readers exist and neither is safe to
 * drop unilaterally; keeping both behind one function is what stops them diverging.
 */
const PRIMARY_KEY = 'last_order_id'
/** Legacy alias. Read by the banner's fallback; written together so the two cannot disagree. */
const RETURN_KEY = 'flashtap_return_order_id'
const RETURN_TABLE_KEY = 'flashtap_return_table'

/** Call this from EVERY screen that places an order, immediately after the id comes back. */
export function rememberPlacedOrder(orderId: string, tableNumber?: number | null): void {
  if (typeof window === 'undefined') return
  const id = String(orderId ?? '').trim()
  if (!id) return
  try {
    sessionStorage.setItem(PRIMARY_KEY, id)
    sessionStorage.setItem(RETURN_KEY, id)
    const tn = Number(tableNumber)
    if (Number.isFinite(tn) && tn > 0) sessionStorage.setItem(RETURN_TABLE_KEY, String(tn))
  } catch {
    // Private browsing and blocked site data both throw here. Losing the pointer costs the banner
    // a shortcut; it must never cost the customer their order, so this is deliberately silent.
  }
}

/**
 * The id the banner should open, or '' when nothing is remembered.
 *
 * Returns EMPTY rather than a guess. The banner falls back to its session-scoped `activeOrder`
 * query, which is authoritative — pointing at a remembered-but-wrong order is the defect this
 * module exists to fix, so an absent pointer must never be substituted for one.
 */
export function readPlacedOrderId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return String(sessionStorage.getItem(PRIMARY_KEY) || sessionStorage.getItem(RETURN_KEY) || '').trim()
  } catch {
    return ''
  }
}
