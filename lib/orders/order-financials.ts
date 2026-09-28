/**
 * ONE AUTHORITATIVE FINANCIAL PROJECTION PER ORDER AND PER TAB.
 *
 * ================================================================================================
 * WHY THIS EXISTS
 * ================================================================================================
 *
 * `amend_order_lines` (20260829150000) never rewrites the ORIGINAL order. A void marks the
 * `order_lines` row voided and, for a reduction, inserts a NEW order on the same tab carrying the
 * surviving quantity. `orders.total` on the original therefore keeps counting every voided line,
 * and `sum(orders.total)` across a tab counts a reduced line twice: once on the original, once on
 * its replacement. Riviera #160's tab read N$3,065 that way against a real bill of N$1,395.
 *
 * Every surface that asked "what is owed" of `orders.total` was wrong for an amended tab, including
 * the card charge. This module is the single answer; nothing else should derive these figures.
 *
 * ================================================================================================
 * THE SIX VALUES (all integer cents)
 * ================================================================================================
 *
 *   original     `orders.total` exactly as stored. Historical; never rewritten.
 *   voided       Σ items[i].total over lines voided under VOIDED_LINE (below). On a reduction the
 *                WHOLE original line is voided -- its surviving quantity lives on the replacement
 *                order, which carries its own money. So nothing is ever counted twice.
 *   live         original − voided, floored at 0; 0 for a cancelled order. SUBTRACTIVE on purpose:
 *                a stored total can legitimately differ from Σ items (order-level adjustments), and
 *                re-summing items would silently drop them.
 *   fulfilled    Σ items[i].total over live lines every owning station has marked ready/collected.
 *   paid         Σ item-level allocation settlements + the whole-order charge when the order is
 *                paid (see PAID BASIS).
 *   outstanding  owesMoney(payment_status) ? max(0, live − paid) : 0.
 *   overpaid     max(0, paid − live). Exposed, never clamped away: a void after payment is money the
 *                customer is owed back, and hiding it is how a refund goes unrecorded.
 *
 * ================================================================================================
 * VOIDED_LINE — the one predicate
 * ================================================================================================
 *
 * A line is voided when EVERY station that owns it is 'voided'. A half-voided 'both' line is still
 * live. This is verbatim the rule in `order_is_fully_paid_by_allocations` (20260829170000) and the
 * terminal lines route; a second, different rule would let the bill and the kitchen disagree.
 *
 * ================================================================================================
 * PAID BASIS
 * ================================================================================================
 *
 * For a paid order the whole-order charge is `settledChargeCents` when the settlement recorded it.
 * Before that was recorded, every gateway, cash and reconcile path charged `total − allocSettled`,
 * so for a legacy paid order `paid = original` is what was actually taken -- including any voided
 * lines it was overcharged for. That is reported as `overpaid`, which is the truth.
 *
 * ================================================================================================
 * COVERAGE
 * ================================================================================================
 *
 * An order with no `order_lines` rows (pre-20260827, or a failed line insert) cannot have a voided
 * line, so live = original and `lineCoverage = 'none'`. This fails toward OWING, never toward
 * letting a table close over unpaid food.
 */

import { owesMoney, isPaidPaymentStatus } from '@/lib/payments/payment-integrity'
import { settledCentsByOrder } from '@/lib/payments/settled-cents'

export type LineStationState = 'outstanding' | 'cooked' | 'ready' | 'collected' | 'voided' | string

export type FinancialLineInput = {
  id?: string | null
  order_id: string
  source_item_index: number | null
  kitchen_state: LineStationState | null
  bar_state: LineStationState | null
}

export type FinancialOrderInput = {
  id: string
  tab_id?: string | null
  total: unknown
  items: unknown
  status?: string | null
  payment_status?: string | null
  tab_settlement_for_tab_id?: string | null
  /** Whole-order charge recorded at settlement, when the settlement recorded it. */
  settled_charge_cents?: number | null
}

export type LineFinancials = {
  sourceItemIndex: number
  lineId: string | null
  name: string
  quantity: number
  unitCents: number
  totalCents: number
  voided: boolean
  fulfilled: boolean
  /** The structured variant selection carried on the item, if any: { groupName: optionLabel }. */
  selectedVariants: Record<string, string> | null
}

export type OrderFinancials = {
  orderId: string
  originalCents: number
  voidedCents: number
  liveCents: number
  fulfilledCents: number
  paidCents: number
  outstandingCents: number
  overpaidCents: number
  lineCoverage: 'full' | 'partial' | 'none'
  paidBasis: 'none' | 'allocations' | 'recorded_charge' | 'legacy_total'
  cancelled: boolean
  isSettlementArtefact: boolean
  lines: LineFinancials[]
}

export type TabFinancials = {
  originalCents: number
  voidedCents: number
  liveCents: number
  fulfilledCents: number
  paidCents: number
  outstandingCents: number
  overpaidCents: number
  orders: OrderFinancials[]
}

export function toCents(value: unknown): number | null {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function ownedStates(line: Pick<FinancialLineInput, 'kitchen_state' | 'bar_state'>): string[] {
  return [line.kitchen_state, line.bar_state].filter((s): s is string => s != null)
}

/** VOIDED_LINE. Every owning station voided. See the header. */
export function isVoidedLine(line: Pick<FinancialLineInput, 'kitchen_state' | 'bar_state'>): boolean {
  const owned = ownedStates(line)
  return owned.length > 0 && owned.every((s) => s === 'voided')
}

function isFulfilledLine(line: Pick<FinancialLineInput, 'kitchen_state' | 'bar_state'>): boolean {
  const owned = ownedStates(line)
  return owned.length > 0 && owned.every((s) => s === 'ready' || s === 'collected')
}

function readSelectedVariants(item: Record<string, unknown>): Record<string, string> | null {
  const raw = item.selectedVariants ?? item.selected_variants
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [group, label] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof label === 'string' && label.trim()) out[group] = label
  }
  return Object.keys(out).length > 0 ? out : null
}

function itemTotalCents(item: Record<string, unknown>): number {
  const direct = toCents(item.total)
  if (direct != null) return direct
  const sub = toCents(item.subtotal)
  if (sub != null) return sub
  const unit = toCents(item.unitPrice ?? item.unit_price)
  const qty = Number(item.quantity)
  return unit != null && Number.isFinite(qty) ? Math.round(unit * qty) : 0
}

/**
 * The projection for ONE order. Pure: every input is passed in, so the same function serves the
 * route, the invoice, the tests and the Riviera regression without a database.
 *
 * `allocationSettledCents` is Σ order_line_allocation_settlements for this order (settledCentsByOrder).
 */
export function computeOrderFinancials(
  order: FinancialOrderInput,
  lines: readonly FinancialLineInput[],
  allocationSettledCents = 0,
): OrderFinancials {
  const items = Array.isArray(order.items) ? (order.items as unknown[]) : []
  const orderLines = lines.filter((l) => String(l.order_id) === String(order.id))
  const lineByIndex = new Map<number, FinancialLineInput>()
  for (const l of orderLines) {
    if (l.source_item_index != null) lineByIndex.set(Number(l.source_item_index), l)
  }

  const lineFinancials: LineFinancials[] = []
  let voidedCents = 0
  let fulfilledCents = 0
  let covered = 0
  items.forEach((raw, index) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const line = lineByIndex.get(index) ?? null
    if (line) covered += 1
    const totalCents = itemTotalCents(item)
    const quantity = Number(item.quantity)
    const voided = line ? isVoidedLine(line) : false
    const fulfilled = !voided && line ? isFulfilledLine(line) : false
    if (voided) voidedCents += totalCents
    if (fulfilled) fulfilledCents += totalCents
    const unit = toCents(item.unitPrice ?? item.unit_price)
    lineFinancials.push({
      sourceItemIndex: index,
      lineId: line?.id ? String(line.id) : null,
      name: String(item.displayName ?? item.display_name ?? item.name ?? '').trim() || 'Item',
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unitCents:
        unit ?? (Number.isFinite(quantity) && quantity > 0 ? Math.round(totalCents / quantity) : totalCents),
      totalCents,
      voided,
      fulfilled,
      selectedVariants: readSelectedVariants(item),
    })
  })

  const cancelled = String(order.status ?? '').toLowerCase() === 'cancelled'
  const originalCents = toCents(order.total) ?? 0
  const liveCents = cancelled ? 0 : Math.max(0, originalCents - voidedCents)

  const allocSettled = Math.max(0, Math.round(Number(allocationSettledCents) || 0))
  let paidCents = allocSettled
  let paidBasis: OrderFinancials['paidBasis'] = allocSettled > 0 ? 'allocations' : 'none'
  if (isPaidPaymentStatus(order.payment_status)) {
    const recorded = order.settled_charge_cents
    if (recorded != null && Number.isFinite(Number(recorded))) {
      paidCents = allocSettled + Math.max(0, Math.round(Number(recorded)))
      paidBasis = 'recorded_charge'
    } else {
      // Legacy: every path charged `total − allocSettled`, so what was taken is the original total.
      paidCents = Math.max(allocSettled, originalCents)
      paidBasis = 'legacy_total'
    }
  }

  const owes = !cancelled && owesMoney(order.payment_status)
  const outstandingCents = owes ? Math.max(0, liveCents - paidCents) : 0
  const overpaidCents = Math.max(0, paidCents - liveCents)

  return {
    orderId: String(order.id),
    originalCents,
    voidedCents,
    liveCents,
    fulfilledCents,
    paidCents,
    outstandingCents,
    overpaidCents,
    lineCoverage:
      items.length === 0 || covered === 0 ? 'none' : covered === items.length ? 'full' : 'partial',
    paidBasis,
    cancelled,
    isSettlementArtefact: Boolean(String(order.tab_settlement_for_tab_id ?? '').trim()),
    lines: lineFinancials,
  }
}

/** Σ over a tab. Settlement artefacts represent a payment of the tab, not food, and are excluded. */
export function computeTabFinancials(
  orders: readonly FinancialOrderInput[],
  lines: readonly FinancialLineInput[],
  allocationSettledByOrder: ReadonlyMap<string, number> = new Map(),
): TabFinancials {
  const per = orders
    .map((o) => computeOrderFinancials(o, lines, allocationSettledByOrder.get(String(o.id)) ?? 0))
    .filter((f) => !f.isSettlementArtefact)
  const sum = (k: keyof Pick<OrderFinancials, 'originalCents' | 'voidedCents' | 'liveCents' | 'fulfilledCents' | 'paidCents' | 'outstandingCents' | 'overpaidCents'>) =>
    per.reduce((s, f) => s + f[k], 0)
  return {
    originalCents: sum('originalCents'),
    voidedCents: sum('voidedCents'),
    liveCents: sum('liveCents'),
    fulfilledCents: sum('fulfilledCents'),
    paidCents: sum('paidCents'),
    outstandingCents: sum('outstandingCents'),
    overpaidCents: sum('overpaidCents'),
    orders: per,
  }
}

/**
 * Columns the reader needs. SELECTED, not merely written -- see written-columns-are-not-selected.
 *
 * `settled_charge_cents` arrives with 20260928120000. That migration is additive and must be
 * applied BEFORE code selecting it is deployed: PostgREST refuses a select naming an absent column
 * (42703), and every money path reading through here fails closed on that refusal.
 */
export const FINANCIAL_ORDER_COLUMNS =
  'id, tab_id, total, items, status, payment_status, tab_settlement_for_tab_id, settled_charge_cents'
export const FINANCIAL_LINE_COLUMNS = 'id, order_id, source_item_index, kitchen_state, bar_state'

/** Integer cents to the major-unit figure the legacy wire fields carry. One division, no drift. */
export function centsToMajor(cents: number): number {
  return Math.round(cents) / 100
}

/**
 * ================================================================================================
 * THE READERS
 * ================================================================================================
 *
 * The projection above is pure. These read its three inputs -- the orders, their order_lines, and
 * the item-ledger settlements (settledCentsByOrder, whose rule is NOT restated here) -- and hand
 * them over unchanged.
 *
 * THEY FAIL CLOSED. Every read error throws FinancialsUnreadable. A caller on a money path turns
 * that into a refusal; a caller that only displays may catch it and degrade, but visibly. None may
 * read "could not read the lines" as "nothing is voided" (that charges for cancelled food) or
 * "could not read the settlements" as "nothing is paid" (that charges twice).
 *
 * LINES ARE READ BY order_id, NOT tab_id. The projection joins a line to its order's item on
 * (order_id, source_item_index), so an order_id read is the one that cannot miss a line. Paginated:
 * an unranged PostgREST read silently truncates at 1,000 rows.
 */

type FinancialsSupabase = {
  from: (table: string) => any
}

export class FinancialsUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinancialsUnreadable'
  }
}

const READ_PAGE = 1000

type RangeResult<Row> = PromiseLike<{ data: Row[] | null; error: { message: string } | null }>

async function readAllPages<Row>(
  build: () => { range: (from: number, to: number) => RangeResult<Row> },
  label: string,
): Promise<Row[]> {
  const out: Row[] = []
  for (let offset = 0; ; offset += READ_PAGE) {
    const { data, error } = await build().range(offset, offset + READ_PAGE - 1)
    if (error) throw new FinancialsUnreadable(`${label}: ${error.message}`)
    const page = data ?? []
    out.push(...page)
    if (page.length < READ_PAGE) return out
  }
}

/** Every order_lines row for these orders, with the columns VOIDED_LINE needs. Throws on failure. */
export async function readFinancialLines(
  supabase: FinancialsSupabase,
  orderIds: readonly string[],
): Promise<FinancialLineInput[]> {
  const ids = [...new Set(orderIds.map(String).filter(Boolean))]
  if (ids.length === 0) return []
  return readAllPages<FinancialLineInput>(
    () =>
      supabase
        .from('order_lines')
        .select(FINANCIAL_LINE_COLUMNS)
        .in('order_id', ids)
        .order('id', { ascending: true }),
    'order_lines',
  )
}

async function readAllocationSettled(
  supabase: FinancialsSupabase,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  try {
    return await settledCentsByOrder(supabase as never, [...orderIds])
  } catch (e) {
    throw new FinancialsUnreadable(e instanceof Error ? e.message : String(e))
  }
}

/** The projection's other two inputs for orders the caller has already read. Throws on failure. */
export async function readProjectionInputs(
  supabase: FinancialsSupabase,
  orderIds: readonly string[],
): Promise<{ lines: FinancialLineInput[]; allocationSettledByOrder: Map<string, number> }> {
  const [lines, allocationSettledByOrder] = await Promise.all([
    readFinancialLines(supabase, orderIds),
    readAllocationSettled(supabase, orderIds),
  ])
  return { lines, allocationSettledByOrder }
}

/**
 * The projection for rows the CALLER has already read (with at least FINANCIAL_ORDER_COLUMNS).
 * Reads only the lines and the ledger -- for routes that keep their own order read, such as
 * prepare-payment (which also needs pending_settlement_id) or the tables view (orders nested under
 * tabs).
 */
export async function projectOrderRows(
  supabase: FinancialsSupabase,
  rows: readonly FinancialOrderInput[],
): Promise<Map<string, OrderFinancials>> {
  const ids = rows.map((r) => String(r.id))
  const [lines, settled] = await Promise.all([
    readFinancialLines(supabase, ids),
    readAllocationSettled(supabase, ids),
  ])
  const out = new Map<string, OrderFinancials>()
  for (const row of rows) {
    out.set(String(row.id), computeOrderFinancials(row, lines, settled.get(String(row.id)) ?? 0))
  }
  return out
}

export type LoadedOrderFinancials = {
  rows: FinancialOrderInput[]
  /** Keyed by order id; every row read has an entry. */
  byId: Map<string, OrderFinancials>
}

/**
 * Orders by id, scoped to the restaurant, projected. An id that cannot be read is simply absent;
 * on a money path the caller must treat `rows.length !== ids.length` as a refusal.
 */
export async function loadOrderFinancials(
  supabase: FinancialsSupabase,
  restaurantId: string,
  orderIds: readonly string[],
): Promise<LoadedOrderFinancials> {
  const ids = [...new Set(orderIds.map(String).filter(Boolean))]
  if (ids.length === 0) return { rows: [], byId: new Map() }
  const { data, error } = await supabase
    .from('orders')
    .select(FINANCIAL_ORDER_COLUMNS)
    .eq('restaurant_id', restaurantId)
    .in('id', ids)
  if (error) throw new FinancialsUnreadable(`orders: ${error.message}`)
  const rows = (data ?? []) as FinancialOrderInput[]
  return { rows, byId: await projectOrderRows(supabase, rows) }
}

/**
 * Every order on one tab, projected and summed. Settlement artefacts are excluded from the sum.
 *
 * `restaurantId` scopes the read whenever the caller has one; null is for internal server helpers
 * that hold only a tab id (a tab id is a uuid and belongs to one venue).
 */
export async function loadTabFinancials(
  supabase: FinancialsSupabase,
  restaurantId: string | null,
  tabId: string,
): Promise<TabFinancials> {
  const rows = await readAllPages<FinancialOrderInput>(() => {
    let query = supabase.from('orders').select(FINANCIAL_ORDER_COLUMNS)
    if (restaurantId) query = query.eq('restaurant_id', restaurantId)
    return query.eq('tab_id', tabId).order('id', { ascending: true })
  }, 'orders')
  const ids = rows.map((r) => String(r.id))
  const [lines, settled] = await Promise.all([
    readFinancialLines(supabase, ids),
    readAllocationSettled(supabase, ids),
  ])
  return computeTabFinancials(rows, lines, settled)
}

/**
 * A tab's figures and NOTHING ELSE -- no order ids, no rows. For the guest routes classified
 * AGGREGATE_NO_IDS (__tests__/guest-routes-do-not-leak-foreign-order-ids.test.ts): the projection
 * has to read order ids to join lines to their orders, and this is the boundary that keeps every
 * one of them inside the server. Built field by field, never spread, so a field added to
 * TabFinancials later cannot start travelling.
 */
export type TabTotals = {
  originalCents: number
  /** Σ (original − voided) over every non-artefact order, paid or cancelled included: "ordered". */
  grossOrderedCents: number
  voidedCents: number
  liveCents: number
  paidCents: number
  outstandingCents: number
  overpaidCents: number
}

export async function loadTabTotals(
  supabase: FinancialsSupabase,
  restaurantId: string | null,
  tabId: string,
): Promise<TabTotals> {
  const t = await loadTabFinancials(supabase, restaurantId, tabId)
  return {
    originalCents: t.originalCents,
    grossOrderedCents: t.orders.reduce((sum, o) => sum + (o.originalCents - o.voidedCents), 0),
    voidedCents: t.voidedCents,
    liveCents: t.liveCents,
    paidCents: t.paidCents,
    outstandingCents: t.outstandingCents,
    overpaidCents: t.overpaidCents,
  }
}

/** The C2 wire shape, for one order or a tab. Integer cents throughout. */
export type FinancialsWire = {
  original_cents: number
  voided_cents: number
  live_cents: number
  paid_cents: number
  outstanding_cents: number
  overpaid_cents: number
}

export function financialsWire(
  f: Pick<OrderFinancials, 'originalCents' | 'voidedCents' | 'liveCents' | 'paidCents' | 'outstandingCents' | 'overpaidCents'>,
): FinancialsWire {
  return {
    original_cents: f.originalCents,
    voided_cents: f.voidedCents,
    live_cents: f.liveCents,
    paid_cents: f.paidCents,
    outstanding_cents: f.outstandingCents,
    overpaid_cents: f.overpaidCents,
  }
}
