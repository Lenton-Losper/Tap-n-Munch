/**
 * Synthetic ledger rows for the payment-method breakdown, run through the REAL aggregator.
 *
 * Invented data for tests and screenshots only: nothing here is copied from a venue. The shape is
 * chosen to exercise every branch of the card -- all four recorded methods, an unrecognised value,
 * a split order, a tab settled over several orders, refunds on both sides of the ledger cut-over,
 * paid orders with no settlement record, and a ramp of staff-recorded "Other" payments.
 */
import {
  buildPaymentMethodBreakdown,
  type PaidOrder,
  type RefundEvent,
  type SettlementEvent,
} from '@/lib/analytics/payment-method-breakdown'

export const FIXTURE_RANGE = { startDate: '2026-09-28', endDate: '2026-10-11' }

export function fixtureInputs() {
  const events: SettlementEvent[] = []
  const refunds: RefundEvent[] = []
  const paidOrders: PaidOrder[] = []
  let n = 0
  const at = (day: string, hour = 10, min = 0) => `${day}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`
  const day = (i: number) => new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10) // 09-28 + i

  const paid = (method: string, cents: number, when: string) => {
    const id = `ord-${++n}`
    paidOrders.push({ id, paymentMethod: method, totalCents: cents, paidAt: when })
    return id
  }
  const gateway = (cents: number, when: string) => {
    const o = paid('card', cents, when)
    events.push({ id: `gw-${n}`, source: 'gateway', method: null, amountCents: cents, createdAt: when, orderIds: [o], origin: 'gateway' })
  }
  const manual = (method: string, cents: number, when: string, terminalId = 'term-1') => {
    const o = paid(method, cents, when)
    events.push({
      id: `ng-${n}`, source: 'non_gateway', method, amountCents: cents, createdAt: when, orderIds: [o],
      origin: 'terminal_order_payment', terminalId,
    })
  }

  for (let i = 0; i < 14; i++) {
    const d = day(i)
    const settled = d >= '2026-09-30'
    const cardN = 3 + (i % 4)
    for (let k = 0; k < cardN; k++) {
      const when = at(d, 8 + k)
      if (settled) gateway(4500 + k * 1250, when)
      else paid('card', 4500 + k * 1250, when) // before the ledger: order only
    }
    for (let k = 0; k < 2 + (i % 2); k++) {
      const when = at(d, 11 + k)
      if (settled) manual('cash', 3000 + k * 800, when)
      else paid('cash', 3000 + k * 800, when)
    }
    if (settled && i % 3 === 0) manual('paytoday', 2100, at(d, 14))
    if (d >= '2026-10-07') {
      for (let k = 0; k < 4 + (i % 5); k++) manual('other', 1500 + k * 700, at(d, 9 + k, 5), `term-${1 + (k % 5)}`)
    }
    if (settled && i % 4 === 1) manual('card', 5200, at(d, 15)) // standalone card machine
  }

  // A split order (cash + card on ONE order) and a tab settled in one go over three orders.
  const split = paid('cash', 8000, at('2026-10-04', 16))
  events.push(
    { id: 'ng-split-cash', source: 'non_gateway', method: 'cash', amountCents: 3000, createdAt: at('2026-10-04', 16), orderIds: [split], origin: 'terminal_allocation_settle' },
    { id: 'gw-split-card', source: 'gateway', method: null, amountCents: 5000, createdAt: at('2026-10-04', 16, 1), orderIds: [split], origin: 'gateway' },
  )
  const tab = [paid('cash', 2000, at('2026-10-05', 18)), paid('cash', 2500, at('2026-10-05', 18)), paid('cash', 1800, at('2026-10-05', 18))]
  events.push({ id: 'ng-tab', source: 'non_gateway', method: 'cash', amountCents: 6300, createdAt: at('2026-10-05', 18), orderIds: tab, origin: 'terminal_tab_settle' })

  // A method FlashTap does not record, kept visible in its own bucket.
  manual('voucher', 2400, at('2026-10-08', 12))

  // Paid orders no ledger row mentions: reported as a coverage gap, never invented into a transaction.
  paid('card', 3300, at('2026-10-03', 9))
  paid('card', 2750, at('2026-10-03', 10))
  paid('card', 4100, at('2026-10-06', 11))

  refunds.push(
    { id: 'ref-1', amountCents: 3500, createdAt: at('2026-10-02', 13), orderIds: ['x'] },
    { id: 'ref-pre', amountCents: 1200, createdAt: at('2026-09-29', 13), orderIds: ['y'] },
  )
  return { events, refunds, paidOrders }
}

export function fixtureBreakdown() {
  return buildPaymentMethodBreakdown({ ...FIXTURE_RANGE, timeZone: 'Africa/Windhoek', ...fixtureInputs() })
}
