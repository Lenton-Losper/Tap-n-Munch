import { addCalendarDays, calendarDateInTimeZone } from '@/lib/reports/date-range-presets'
import { DEFAULT_REPORT_TIMEZONE } from '@/lib/reports/format-report-datetime'
import { paymentMethodLabel, PAYMENT_METHOD_LABELS } from '@/lib/reports/payment-method-split'

/**
 * PAYMENT METHOD BREAKDOWN -- settlement transactions, with the order-based figures kept apart.
 *
 * ================================================================================================
 * WHY THIS REPLACES THE ORDER-BASED SPLIT
 * ================================================================================================
 *
 * The Analytics pie counted ORDERS by `orders.payment_method` and drew two slices, Card and Cash.
 * `other` was tallied and then never added to the data array, and the percentages were taken over a
 * denominator that included it, so the visible slices summed to less than 100%. On production at
 * 2026-10-21 that left out 2,332 `other` and 81 `paytoday` paid orders.
 *
 * Counting orders was also the wrong unit for "transactions by payment type": an order settled
 * half cash, half card is ONE order and TWO transactions, and a tab settled in one go is MANY
 * orders and ONE transaction.
 *
 * ================================================================================================
 * THE UNIT: ONE ROW IN ONE OF TWO LEDGERS
 * ================================================================================================
 *
 *   payment_events (event_type 'sale')   gateway collections. The table has no method column; every
 *                                        sale row is a card transaction (7,317 of 7,317 on
 *                                        production agree with their order's payment_method).
 *   non_gateway_payment_events           everything else, with its own `method`.
 *
 * `payments` and `order_line_allocation_settlements` are deliberately NOT read. The first is a
 * best-effort shadow of the two ledgers above; the second is the per-item breakdown of a parent
 * event that is already counted. Adding either would count the same money twice.
 *
 * ================================================================================================
 * THE LEDGER IS NOT COMPLETE FOR HISTORY, AND THE CODE SAYS SO INSTEAD OF HIDING IT
 * ================================================================================================
 *
 * The non-gateway ledger starts mid-day on 2026-09-29 (Windhoek). Before it, a cash payment left no
 * settlement record at all, so a settlement-based chart of an earlier day would silently drop cash.
 * Days before SETTLEMENT_LEDGER_RELIABLE_FROM are therefore reported from paid orders instead, as a
 * separate section labelled order-based. The two bases are never added together.
 *
 * Inside the reliable window, a paid order with NO settlement row is a coverage gap. It is counted
 * and listed apart from the totals; no transaction is invented for it.
 */

/**
 * First local day on which the settlement ledger is treated as complete. 2026-09-29 is the
 * cut-over day itself: 46 of the 136 paid orders with no settlement row since then fall on it.
 */
export const SETTLEMENT_LEDGER_RELIABLE_FROM = '2026-09-30'

export type SettlementEvent = {
  id: string
  source: 'gateway' | 'non_gateway'
  /** Raw ledger value. Gateway rows have none and are card by construction. */
  method: string | null
  amountCents: number
  createdAt: string
  orderIds: string[]
  origin?: string | null
  terminalId?: string | null
}

export type RefundEvent = {
  id: string
  amountCents: number
  createdAt: string
  orderIds: string[]
}

export type PaidOrder = {
  id: string
  paymentMethod: string | null
  totalCents: number
  paidAt: string
}

export type BreakdownInput = {
  startDate: string
  endDate: string
  timeZone?: string
  /** Sale events. May extend a day either side of the range; those are used for coverage only. */
  events: SettlementEvent[]
  refunds: RefundEvent[]
  paidOrders: PaidOrder[]
  /**
   * Orders proven to have a ledger row by a direct lookup on order_ids, whatever that row's date.
   * Needed because a sale row can be stamped well after the order's paid_at (a device sale promoted
   * or reconciled later), so a fixed date margin cannot prove "no settlement record".
   */
  coveredElsewhere?: string[]
  ledgerReliableFrom?: string
}

export type MethodRow = {
  method: string
  label: string
  /** False when the value is not one FlashTap records. It is still shown, never merged or dropped. */
  known: boolean
  count: number
  amountCents: number
  /** Share of the transaction (or order) count. Rows sum to exactly 100. */
  percentOfCount: number
  /** Share of the amount. Rows sum to exactly 100. */
  percentOfAmount: number
  firstDay: string
  lastDay: string
  activeDays: number
  /** Distinct orders the rows cover. Not a transaction count. */
  ordersCovered: number
  origins: Record<string, number>
  terminals: number
  /** Set where a human should confirm the data is real before relying on it. */
  validation: string | null
}

export type DayCell = { count: number; amountCents: number }
export type DayRow = {
  day: string
  byMethod: Record<string, DayCell>
  total: DayCell
  refunds: DayCell
}

export type Section = {
  basis: 'settlement_transactions' | 'paid_orders'
  startDate: string
  endDate: string
  /** The denominator the percentages use, in words. */
  denominatorLabel: string
  total: { count: number; amountCents: number; ordersCovered: number }
  rows: MethodRow[]
  daily: DayRow[]
}

export type Coverage = {
  /** Paid orders in the settlement window that no ledger row refers to. Excluded from every total. */
  uncoveredOrders: number
  uncoveredAmountCents: number
  byOrderMethod: Record<string, { orders: number; amountCents: number }>
  firstDay: string | null
  lastDay: string | null
  /**
   * Paid orders in the window whose ledger row exists but is dated OUTSIDE the requested days. They
   * are not gaps -- their money is in another day's totals -- but they are also not in this one's.
   */
  settledOutsideRange: number
}

export type Breakdown = {
  timeZone: string
  startDate: string
  endDate: string
  ledgerReliableFrom: string
  settlement: Section | null
  /** Order-based figures for days before the ledger is reliable. Not settlement transactions. */
  preLedger: Section | null
  /** Successful refunds on days inside the settlement window. Negative amounts; never in the percentages. */
  refunds: { count: number; amountCents: number; netOfRefundsCents: number }
  /** Successful refunds on requested days BEFORE the ledger is reliable. Same sign, reported apart. */
  refundsBeforeLedger: { count: number; amountCents: number }
  /** The partial cut-over day (the day before ledgerReliableFrom), when the range includes it. */
  cutOverDay: string | null
  coverage: Coverage
  droppedDuplicateRows: number
  rowsWithoutValidTimestamp: number
}

const KNOWN_METHODS = new Set(Object.keys(PAYMENT_METHOD_LABELS))

/** trim + lowercase; nothing recorded is its own bucket (`unknown`), never folded into cash. */
export function normalizeMethod(raw: unknown): string {
  const v = String(raw ?? '').trim().toLowerCase()
  return v === '' ? 'unknown' : v
}

export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? paymentMethodLabel(method) : `${method} (unrecognised)`
}

/** Percentages to one decimal that add to exactly 100.0 (largest-remainder). All zero when empty. */
export function reconcilePercentages(values: number[]): number[] {
  const total = values.reduce((s, v) => s + v, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map((v) => (v / total) * 1000)
  const floors = raw.map(Math.floor)
  let left = 1000 - floors.reduce((s, v) => s + v, 0)
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    floors[i] += 1
    left -= 1
  }
  return floors.map((f) => f / 10)
}

function dayList(startDate: string, endDate: string): string[] {
  const out: string[] = []
  for (let d = startDate, n = 0; d <= endDate && n < 800; d = addCalendarDays(d, 1), n += 1) out.push(d)
  return out
}

type Unit = {
  method: string
  amountCents: number
  day: string
  orderIds: string[]
  origin?: string | null
  terminalId?: string | null
}

function buildSection(
  basis: Section['basis'],
  startDate: string,
  endDate: string,
  units: Unit[],
  refundsByDay: Map<string, DayCell>,
): Section {
  const days = dayList(startDate, endDate)
  const grouped = new Map<string, Unit[]>()
  for (const u of units) {
    const list = grouped.get(u.method) ?? []
    list.push(u)
    grouped.set(u.method, list)
  }

  const drafts = [...grouped.entries()].map(([method, list]) => {
    const orders = new Set<string>()
    const origins: Record<string, number> = {}
    const terminals = new Set<string>()
    const activeDays = new Set<string>()
    for (const u of list) {
      u.orderIds.forEach((o) => orders.add(o))
      activeDays.add(u.day)
      if (u.origin) origins[u.origin] = (origins[u.origin] ?? 0) + 1
      if (u.terminalId) terminals.add(u.terminalId)
    }
    const sortedDays = [...activeDays].sort()
    return {
      method,
      count: list.length,
      amountCents: list.reduce((s, u) => s + u.amountCents, 0),
      ordersCovered: orders.size,
      origins,
      terminals: terminals.size,
      activeDays: activeDays.size,
      firstDay: sortedDays[0],
      lastDay: sortedDays[sortedDays.length - 1],
    }
  })
  drafts.sort((a, b) => b.count - a.count || b.amountCents - a.amountCents || a.method.localeCompare(b.method))

  const pCount = reconcilePercentages(drafts.map((d) => d.count))
  const pAmount = reconcilePercentages(drafts.map((d) => d.amountCents))

  const rows: MethodRow[] = drafts.map((d, i) => {
    const known = KNOWN_METHODS.has(d.method)
    let validation: string | null = null
    if (!known) {
      validation = `"${d.method}" is not a payment method FlashTap records. Shown as recorded; confirm where it came from.`
    } else if (d.method === 'other') {
      validation =
        `Staff-recorded "Other": ${d.count} from ${d.firstDay} to ${d.lastDay} (${d.activeDays} active day` +
        `${d.activeDays === 1 ? '' : 's'}${d.terminals ? `, ${d.terminals} terminal${d.terminals === 1 ? '' : 's'}` : ''}).` +
        ' Not classified as real or test traffic; confirm with the venue.'
    }
    return {
      ...d,
      label: methodLabel(d.method),
      known,
      percentOfCount: pCount[i],
      percentOfAmount: pAmount[i],
      validation,
    }
  })

  const daily: DayRow[] = days.map((day) => {
    const byMethod: Record<string, DayCell> = {}
    const total: DayCell = { count: 0, amountCents: 0 }
    for (const u of units) {
      if (u.day !== day) continue
      const cell = (byMethod[u.method] ??= { count: 0, amountCents: 0 })
      cell.count += 1
      cell.amountCents += u.amountCents
      total.count += 1
      total.amountCents += u.amountCents
    }
    const r = refundsByDay.get(day)
    return { day, byMethod, total, refunds: r ? { ...r } : { count: 0, amountCents: 0 } }
  })

  const allOrders = new Set<string>()
  units.forEach((u) => u.orderIds.forEach((o) => allOrders.add(o)))

  return {
    basis,
    startDate,
    endDate,
    denominatorLabel:
      basis === 'settlement_transactions'
        ? `${units.length} successful collection transaction${units.length === 1 ? '' : 's'} (refunds excluded)`
        : `${units.length} paid order${units.length === 1 ? '' : 's'} (order-based, not settlement transactions)`,
    total: {
      count: units.length,
      amountCents: units.reduce((s, u) => s + u.amountCents, 0),
      ordersCovered: allOrders.size,
    },
    rows,
    daily,
  }
}

export function buildPaymentMethodBreakdown(input: BreakdownInput): Breakdown {
  const timeZone = input.timeZone?.trim() || DEFAULT_REPORT_TIMEZONE
  const reliableFrom = input.ledgerReliableFrom ?? SETTLEMENT_LEDGER_RELIABLE_FROM
  const { startDate, endDate } = input
  const dayOf = (ts: string): string | null => {
    const d = new Date(ts)
    return Number.isNaN(d.getTime()) ? null : calendarDateInTimeZone(d, timeZone)
  }

  // Duplicates are dropped by row id only. Both ledgers already enforce UNIQUE(restaurant_id,
  // idempotency_key), so a repeated id can only be a paging overlap, never a second payment.
  let droppedDuplicateRows = 0
  let rowsWithoutValidTimestamp = 0
  const seen = new Set<string>()
  const events: Array<SettlementEvent & { day: string }> = []
  // Every distinct ledger row proves its orders have a settlement, whether or not it can be dated.
  const covered = new Set<string>(input.coveredElsewhere ?? [])
  for (const e of input.events) {
    if (seen.has(e.id)) {
      droppedDuplicateRows += 1
      continue
    }
    seen.add(e.id)
    e.orderIds.forEach((id) => covered.add(id))
    const day = dayOf(e.createdAt)
    if (!day) {
      rowsWithoutValidTimestamp += 1
      continue
    }
    events.push({ ...e, day })
  }

  const settlementStart = startDate > reliableFrom ? startDate : reliableFrom
  const hasSettlement = settlementStart <= endDate
  const preLedgerEnd = addCalendarDays(reliableFrom, -1) < endDate ? addCalendarDays(reliableFrom, -1) : endDate
  const hasPreLedger = startDate <= preLedgerEnd

  const refundSeen = new Set<string>()
  const refundsByDay = new Map<string, DayCell>()
  let refundCount = 0
  let refundCents = 0
  let preRefundCount = 0
  let preRefundCents = 0
  for (const r of input.refunds) {
    if (refundSeen.has(r.id)) {
      droppedDuplicateRows += 1
      continue
    }
    refundSeen.add(r.id)
    const day = dayOf(r.createdAt)
    if (!day) {
      rowsWithoutValidTimestamp += 1
      continue
    }
    if (day < startDate || day > endDate) continue
    if (!hasSettlement || day < settlementStart) {
      preRefundCount += 1
      preRefundCents -= Math.abs(r.amountCents)
      continue
    }
    const cell = refundsByDay.get(day) ?? { count: 0, amountCents: 0 }
    cell.count += 1
    cell.amountCents -= Math.abs(r.amountCents)
    refundsByDay.set(day, cell)
    refundCount += 1
    refundCents -= Math.abs(r.amountCents)
  }

  const settlementUnits: Unit[] = events
    .filter((e) => e.day >= settlementStart && e.day <= endDate)
    .map((e) => ({
      method: e.source === 'gateway' ? 'card' : normalizeMethod(e.method),
      amountCents: e.amountCents,
      day: e.day,
      orderIds: e.orderIds,
      origin: e.origin ?? (e.source === 'gateway' ? 'gateway' : null),
      terminalId: e.terminalId,
    }))
  const settlement = hasSettlement
    ? buildSection('settlement_transactions', settlementStart, endDate, settlementUnits, refundsByDay)
    : null

  const paid = input.paidOrders
    .map((o) => ({ o, day: dayOf(o.paidAt) }))
    .filter((x): x is { o: PaidOrder; day: string } => {
      if (!x.day) rowsWithoutValidTimestamp += 1
      return !!x.day
    })

  const preLedger = hasPreLedger
    ? buildSection(
        'paid_orders',
        startDate,
        preLedgerEnd,
        paid
          .filter((x) => x.day >= startDate && x.day <= preLedgerEnd)
          .map((x) => ({
            method: normalizeMethod(x.o.paymentMethod),
            amountCents: x.o.totalCents,
            day: x.day,
            orderIds: [x.o.id],
          })),
        new Map(),
      )
    : null

  // Coverage: a paid order in the reliable window that no ledger row (any fetched row, including the
  // margin either side of the range) refers to.
  const coveredInWindow = new Set<string>()
  events
    .filter((e) => e.day >= settlementStart && e.day <= endDate)
    .forEach((e) => e.orderIds.forEach((id) => coveredInWindow.add(id)))
  const coverage: Coverage = {
    uncoveredOrders: 0,
    uncoveredAmountCents: 0,
    byOrderMethod: {},
    firstDay: null,
    lastDay: null,
    settledOutsideRange: 0,
  }
  if (hasSettlement) {
    for (const { o, day } of paid) {
      if (day < settlementStart || day > endDate) continue
      if (covered.has(o.id)) {
        if (!coveredInWindow.has(o.id)) coverage.settledOutsideRange += 1
        continue
      }
      coverage.uncoveredOrders += 1
      coverage.uncoveredAmountCents += o.totalCents
      const m = normalizeMethod(o.paymentMethod)
      const cell = (coverage.byOrderMethod[m] ??= { orders: 0, amountCents: 0 })
      cell.orders += 1
      cell.amountCents += o.totalCents
      if (!coverage.firstDay || day < coverage.firstDay) coverage.firstDay = day
      if (!coverage.lastDay || day > coverage.lastDay) coverage.lastDay = day
    }
  }

  return {
    timeZone,
    startDate,
    endDate,
    ledgerReliableFrom: reliableFrom,
    settlement,
    preLedger,
    refunds: {
      count: refundCount,
      amountCents: refundCents,
      netOfRefundsCents: (settlement?.total.amountCents ?? 0) + refundCents,
    },
    refundsBeforeLedger: { count: preRefundCount, amountCents: preRefundCents },
    cutOverDay: (() => {
      const d = addCalendarDays(reliableFrom, -1)
      return d >= startDate && d <= endDate ? d : null
    })(),
    coverage,
    droppedDuplicateRows,
    rowsWithoutValidTimestamp,
  }
}
