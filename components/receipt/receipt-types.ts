import {
  customerOrderState,
  CUSTOMER_STATUS_COPY,
  type CustomerOrderState,
} from '@/lib/orders/customer-status'

/**
 * Every status the system actually writes and can show a customer. Established from the write
 * sites, not from what this type used to list -- `preparing` and `confirmed` are both written
 * in production paths but were missing here, so they fell through to the "NEW ORDER" default.
 *
 *   pending            app/api/orders/route.ts
 *   waiting_review     order_requests, surfaced by lib/guest-orders/queries.ts
 *   declined           order_requests, same mapping
 *   accepted           dashboard PATCH, app/api/payments/reconcile
 *   confirmed          terminal PATCH only -- the terminal's word for `accepted`
 *   preparing          dashboard PATCH and terminal PATCH
 *   ready              dashboard PATCH and terminal PATCH
 *   ready_for_terminal app/api/orders/[orderId]/ready-for-terminal
 *   completed          dashboard/terminal PATCH, table close, tab settle
 *   cancelled          dashboard/terminal PATCH
 */
export type OrderStatusKey =
  | 'waiting_review'
  | 'declined'
  | 'pending'
  | 'accepted'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

export type ReceiptStatusBadge =
  | 'WAITING FOR CONFIRMATION'
  | 'DECLINED'
  | 'NEW ORDER'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'COMPLETED'
  | 'CANCELLED'

export type ReceiptLineItem = {
  quantity: number
  name: string
  /**
   * The EX-TAX base for this line. Still here because the Subtotal row is a genuine ex-tax
   * decomposition and must keep summing these.
   */
  subtotal: number
  /**
   * What this line COSTS THE CUSTOMER, tax included (#295).
   *
   * Optional because rows priced before `total` was persisted per line do not carry it;
   * `chargedLineAmount` reconstructs it. Never render `subtotal` as a line price: the order
   * confirmation showed "1x Chicken burger NAD 21.74" above "TOTAL 25.00" with N$25 on the menu,
   * which is a price the customer never pays.
   */
  total?: number
  /** Tax on this line, used only to reconstruct `total` for older rows. */
  tax?: number
  /**
   * What the customer configured (#298). Optional and untyped-ish on purpose: these are read
   * straight off a stored line, and `lineConfigurationSummary` owns interpreting them.
   *
   * Without these the confirmation screen renders only the item NAME, so two lines of the same
   * item in different configurations -- 95 + Extra patty vs 95 + Cheese -- look like the same
   * burger charged two different prices. That is #297.
   */
  size?: unknown
  addons?: unknown
  selectedVariants?: unknown
}

/**
 * The charged amount for one line, for display.
 *
 * `total` is the charged figure for BOTH tax modes -- an inclusive rate has the tax inside it, an
 * exclusive rate is subtotal + tax -- so reading `subtotal` was wrong regardless of the rate.
 * Falling straight back to `subtotal` would leave exactly the oldest orders wrong, so tax is
 * added back first.
 */
export function chargedLineAmount(item: ReceiptLineItem): number {
  const total = Number(item.total)
  if (Number.isFinite(total) && total > 0) return total
  const subtotal = Number(item.subtotal) || 0
  const tax = Number(item.tax) || 0
  return Math.round((subtotal + tax) * 100) / 100
}

export function formatReceiptDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date} • ${time}`
}

export function formatCurrency(amount: number, currency = 'NAD'): string {
  const code = currency.replace(/\$/g, '').trim() || 'NAD'
  return `${code} ${amount.toFixed(2)}`
}

/**
 * #309. This WAS a second customer vocabulary -- nine cases and a default, all its own wording --
 * and it contradicted the rest of the app on a real table: an order sitting `pending` after a
 * customer edit forced re-acceptance read "NEW ORDER - Your order has been received and sent to
 * the restaurant", while the staff dashboard read "TOTAL CHANGED - RE-ACCEPT". Spec section 34
 * removed the NEW badge; A1 says that state reads the signed-off waiting word.
 *
 * Its `default` branch returned NEW ORDER too, which is the same defect
 * lib/orders/customer-status.ts was built to kill: an unmapped status rendering as brand new.
 *
 * Now it DELEGATES. `customerOrderState` does the normalisation (including `confirmed` -> accepted,
 * and the four states that collapse to needs_you) and `CUSTOMER_STATUS_COPY` supplies the word.
 * No wording is defined here any more, which is the point: there is one vocabulary and this is
 * not it.
 *
 * `description` is REMOVED rather than rewritten. Every one of the old sentences was copy nobody
 * signed off, and inventing a replacement would repeat the mistake.
 */
export function mapOrderStatusToBadge(status: OrderStatusKey): {
  label: string
  state: CustomerOrderState
} {
  const state = customerOrderState({ status })
  return { label: CUSTOMER_STATUS_COPY[state], state }
}

export function normalizePaymentMethod(method: string): 'Card' | 'Cash' | 'Wallet' | 'Other' | string {
  const m = String(method || '').toLowerCase()
  if (m === 'cash') return 'Cash'
  if (m === 'wallet') return 'Wallet'
  if (m === 'other') return 'Other'
  if (m === 'card') return 'Card'
  return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Card'
}

export function normalizePaymentStatus(status: string): 'Paid' | 'Pending' | 'Failed' | string {
  const s = String(status || '').toLowerCase()
  if (s === 'paid') return 'Paid'
  if (s === 'failed' || s === 'cancelled') return 'Failed'
  return 'Pending'
}
