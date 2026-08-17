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

export function mapOrderStatusToBadge(status: OrderStatusKey): {
  label: ReceiptStatusBadge
  description: string
} {
  switch (status) {
    case 'waiting_review':
      return {
        label: 'WAITING FOR CONFIRMATION',
        description: 'Your order request has been sent. Waiting for the restaurant to confirm.',
      }
    case 'declined':
      return {
        label: 'DECLINED',
        description: 'Sorry, the restaurant was unable to accept this order.',
      }
    case 'pending':
      return {
        label: 'NEW ORDER',
        description: 'Your order has been received and sent to the restaurant.',
      }
    case 'accepted':
    case 'confirmed':
      return {
        label: 'ACCEPTED',
        description: 'The kitchen has accepted your order.',
      }
    case 'preparing':
      return {
        label: 'PREPARING',
        description: 'Your order is being prepared.',
      }
    case 'ready':
      return {
        label: 'READY',
        description: 'Your order is ready.',
      }
    case 'ready_for_terminal':
      return {
        label: 'READY',
        description: 'Staff have been notified to bring the card machine to your table.',
      }
    case 'completed':
      return {
        label: 'COMPLETED',
        description: 'Thank you for your order!',
      }
    case 'cancelled':
      return {
        label: 'CANCELLED',
        description: 'This order has been cancelled.',
      }
    default:
      return {
        label: 'NEW ORDER',
        description: 'Your order is being processed.',
      }
  }
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
