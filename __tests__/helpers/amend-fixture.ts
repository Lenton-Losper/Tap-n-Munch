/**
 * A pure model of what `amend_order_lines` (20260829150000) does to the rows, for tests that must
 * reason about an AMENDED tab without a database.
 *
 * It reproduces the three facts the financial projection depends on, and nothing else:
 *
 *   1. The ORIGINAL order is never rewritten -- not its items, not its total.
 *   2. The amended `order_lines` row is voided on every station that owns it.
 *   3. A reduction (new quantity > 0) inserts a NEW order on the same tab carrying the surviving
 *      quantity, with the item scaled from the original priced item (never re-priced), and one new
 *      line at source_item_index 0.
 *
 * A refused amendment (window_closed: the line was no longer outstanding) changes nothing, which is
 * why `refuse` exists -- the Riviera regression asserts it moves no money.
 */
import type { FinancialLineInput, FinancialOrderInput } from '@/lib/orders/order-financials'

export type FixtureItem = { name: string; quantity: number; total: number }

export type FixtureOrder = FinancialOrderInput & {
  items: Array<Record<string, unknown>>
  order_number?: number
}

export type FixtureLine = FinancialLineInput & { id: string; route_to: 'kitchen' | 'bar' | 'both' }

export class AmendFixture {
  orders: FixtureOrder[] = []
  lines: FixtureLine[] = []
  private seq = 0

  constructor(readonly tabId = 'tab-1') {}

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  /** Place an order: one item per entry, one line per item, every line outstanding. */
  place(items: Array<FixtureItem & { route?: 'kitchen' | 'bar' | 'both' }>, overrides: Partial<FixtureOrder> = {}): FixtureOrder {
    const id = overrides.id ?? this.nextId('order')
    const order: FixtureOrder = {
      id,
      tab_id: this.tabId,
      status: 'pending',
      payment_status: 'pending',
      tab_settlement_for_tab_id: null,
      settled_charge_cents: null,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        total: i.total,
        unitPrice: Math.round((i.total / i.quantity) * 100) / 100,
      })),
      total: Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100,
      ...overrides,
    }
    this.orders.push(order)
    items.forEach((item, index) => {
      const route = item.route ?? 'kitchen'
      this.lines.push({
        id: this.nextId('line'),
        order_id: id,
        source_item_index: index,
        route_to: route,
        kitchen_state: route === 'bar' ? null : 'outstanding',
        bar_state: route === 'kitchen' ? null : 'outstanding',
      })
    })
    return order
  }

  lineFor(orderId: string, name: string): FixtureLine {
    const order = this.orders.find((o) => o.id === orderId)
    const index = order?.items.findIndex((i) => i.name === name) ?? -1
    const line = this.lines.find((l) => l.order_id === orderId && l.source_item_index === index)
    if (!line) throw new Error(`no line for ${name} on ${orderId}`)
    return line
  }

  /**
   * amend_order_lines on one line. Returns the replacement order, or null for a full void.
   * Mirrors the RPC: void the whole original line, then (if anything survives) a new order.
   */
  amend(orderId: string, name: string, newQuantity: number): FixtureOrder | null {
    const line = this.lineFor(orderId, name)
    if (line.kitchen_state != null) line.kitchen_state = 'voided'
    if (line.bar_state != null) line.bar_state = 'voided'
    if (newQuantity === 0) return null

    const source = this.orders.find((o) => o.id === orderId)!.items[Number(line.source_item_index)]
    const ratio = newQuantity / Number(source.quantity)
    const total = Math.round(Number(source.total) * ratio * 100) / 100
    return this.place([{ name, quantity: newQuantity, total, route: line.route_to }], {
      status: 'pending',
      payment_status: 'pending',
    })
  }

  /** A refused amendment (window_closed). Writes nothing -- that is the point. */
  refuse(orderId: string, name: string): void {
    this.lineFor(orderId, name) // must exist, or the "refusal" is a typo
  }

  /** A station moves a line on. A line past outstanding can no longer be amended. */
  markReady(orderId: string, name: string): void {
    const line = this.lineFor(orderId, name)
    if (line.kitchen_state != null) line.kitchen_state = 'ready'
    if (line.bar_state != null) line.bar_state = 'ready'
  }
}

/**
 * RIVIERA ORDER #160, AS PLACED (2026-09-24). Table 1, N$1,945 across eight items. The three
 * reductions and the Modena outcome are applied by the tests themselves, step by step.
 */
export const RIVIERA_ITEMS: Array<FixtureItem & { route: 'kitchen' | 'bar' }> = [
  { name: 'Modena Pasta', quantity: 1, total: 240, route: 'kitchen' },
  { name: 'Wish You Were Here', quantity: 2, total: 380, route: 'kitchen' },
  { name: 'Seared Salmon', quantity: 2, total: 920, route: 'kitchen' },
  { name: 'Double Cheese Burger', quantity: 2, total: 180, route: 'kitchen' },
  { name: 'Jameson', quantity: 1, total: 80, route: 'bar' },
  { name: 'Hansa', quantity: 1, total: 80, route: 'bar' },
  { name: 'Soft Drinks', quantity: 1, total: 35, route: 'bar' },
  { name: 'Mixers', quantity: 1, total: 30, route: 'bar' },
]
