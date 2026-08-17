/**
 * Issue #131 — a ready order was shown to the customer as "PREPARING".
 *
 * Runs in the default node environment: renderToStaticMarkup is a server render and needs
 * MessageChannel, which jsdom does not provide.
 *
 * These assertions are made against the RENDERED confirmation screen, not the mapping table,
 * because that markup is the artefact the customer actually reads.
 *
 * The status vocabulary asserted here is the set the system genuinely writes to orders.status,
 * established from the write sites rather than from OrderStatusKey (which was missing two of
 * them). Staging carries only completed/pending/cancelled, so it could not confirm the rest:
 *   pending            app/api/orders/route.ts:367
 *   waiting_review     app/api/orders/route.ts:305,319 (order_requests, surfaced to the
 *                      customer via lib/guest-orders/queries.ts mapOrderRequestToGuestRow)
 *   declined           order_requests, same mapping
 *   accepted           app/api/payments/reconcile/route.ts:171, dashboard PATCH
 *   confirmed          app/api/terminal/orders/[orderId]/status/route.ts:23  <- terminal only
 *   preparing          dashboard PATCH + terminal PATCH                      <- both writers
 *   ready              dashboard PATCH + terminal PATCH
 *   ready_for_terminal app/api/orders/[orderId]/ready-for-terminal/route.ts:79
 *   completed          dashboard/terminal PATCH, table close, tab settle
 *   cancelled          dashboard/terminal PATCH
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderConfirmationView } from '@/components/receipt/order-confirmation-view'
import { mapOrderStatusToBadge, type OrderStatusKey } from '@/components/receipt/receipt-types'
import { getReceiptStatusBadge } from '@/lib/orders/receipt-status'
import { CUSTOMER_STATUS_COPY } from '@/lib/orders/customer-status'

function renderConfirmation(orderStatus: OrderStatusKey, paymentStatus = 'pending') {
  return renderToStaticMarkup(
    <OrderConfirmationView
      orderNumber={41}
      tableNumber={7}
      createdAt="2026-08-05T10:00:00.000Z"
      orderStatus={orderStatus}
      paymentMethod="card"
      paymentStatus={paymentStatus}
      items={[{ quantity: 1, name: 'Coffee', subtotal: 30 }]}
      total={30}
    />,
  )
}

describe('customer-facing order status vocabulary (#131)', () => {
  describe('the confirmation screen the customer reads', () => {
    it('says READY — not PREPARING — once the kitchen marks the order ready', () => {
      // The reported symptom: kitchen marks the coffee ready, customer still reads "PREPARING".
      const html = renderConfirmation('ready')
      expect(html).toContain(CUSTOMER_STATUS_COPY.ready)
      expect(html).not.toContain(CUSTOMER_STATUS_COPY.preparing)
      expect(html).not.toContain('Your order is being prepared')
    })

    it('says PREPARING while the order is actually being prepared', () => {
      // `preparing` is written by BOTH the dashboard and the terminal, yet had no case at all,
      // so it fell through to the default and told the customer "NEW ORDER".
      const html = renderConfirmation('preparing')
      expect(html).toContain(CUSTOMER_STATUS_COPY.preparing)
      expect(html).not.toMatch(/NEW ORDER/i)
    })

    it('does not show a terminal-confirmed order as a brand new one', () => {
      // The terminal writes `confirmed` where the dashboard writes `accepted`.
      const html = renderConfirmation('confirmed')
      expect(html).toContain(CUSTOMER_STATUS_COPY.accepted)
      expect(html).not.toMatch(/NEW ORDER/i)
    })
  })

  describe('mapOrderStatusToBadge', () => {
    it('maps every status the system actually writes to a distinct, truthful badge', () => {
      expect(mapOrderStatusToBadge('preparing').label).toBe(CUSTOMER_STATUS_COPY.preparing)
      expect(mapOrderStatusToBadge('ready').label).toBe(CUSTOMER_STATUS_COPY.ready)
      expect(mapOrderStatusToBadge('confirmed').label).toBe(CUSTOMER_STATUS_COPY.accepted)
      expect(mapOrderStatusToBadge('accepted').label).toBe(CUSTOMER_STATUS_COPY.accepted)
      expect(mapOrderStatusToBadge('ready_for_terminal').label).toBe(CUSTOMER_STATUS_COPY.needs_you)
    })

    /**
     * #309: `description` is gone. The private sentences it held were unsigned copy, and the
     * defect this asserted against - a READY order described as still being prepared - is now
     * structurally impossible: the label comes from CUSTOMER_STATUS_COPY, keyed by a state
     * `customerOrderState` derived. Asserted on the label instead, which is what renders.
     */
    it('never tells a customer their ready order is still being prepared', () => {
      expect(mapOrderStatusToBadge('ready').label).not.toMatch(/being prepared/i)
      expect(mapOrderStatusToBadge('ready').label).toBe(CUSTOMER_STATUS_COPY.ready)
    })

    it('keeps the statuses that were already correct', () => {
      expect(mapOrderStatusToBadge('waiting_review').label).toBe(CUSTOMER_STATUS_COPY.waiting)
      expect(mapOrderStatusToBadge('declined').label).toBe(CUSTOMER_STATUS_COPY.needs_you)
      expect(mapOrderStatusToBadge('pending').label).toBe(CUSTOMER_STATUS_COPY.waiting)
      expect(mapOrderStatusToBadge('completed').label).toBe(CUSTOMER_STATUS_COPY.ready)
      expect(mapOrderStatusToBadge('cancelled').label).toBe(CUSTOMER_STATUS_COPY.needs_you)
    })
  })

  describe('getReceiptStatusBadge — the same defect on the receipt screen', () => {
    // Reached when payment_status is neither 'paid' nor plain 'pending' (e.g. 'cash_pending',
    // 'terminal_pending'), which is exactly the unpaid-at-table case.
    it('says READY for a ready order awaiting cash settlement', () => {
      expect(getReceiptStatusBadge({ status: 'ready', payment_status: 'cash_pending' }).label)
        .toBe('READY')
    })

    it('says PREPARING for a preparing order rather than a vague placeholder', () => {
      expect(getReceiptStatusBadge({ status: 'preparing', payment_status: 'cash_pending' }).label)
        .toBe('PREPARING')
    })

    it('still puts payment truth first', () => {
      // A paid order reads PAID regardless of kitchen state; that precedence must not change.
      expect(getReceiptStatusBadge({ status: 'ready', payment_status: 'paid' }).label).toBe('PAID')
      expect(getReceiptStatusBadge({ status: 'waiting_review' }).label).toBe('CONFIRMING PAYMENT…')
    })
  })
})
