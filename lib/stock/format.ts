export type StockStatus =
  | 'negative'
  | 'out_of_stock'
  | 'low_stock'
  | 'healthy'
  | 'not_tracked'

/** `stock_movements.quantity_delta` is numeric(_,4). This is that 4. */
export const STOCK_QUANTITY_DECIMALS = 4

/**
 * Round to the precision the database actually stores.
 *
 * A balance is a SUM of numeric(_,4) values that arrive over PostgREST as strings or floats and
 * are added in JavaScript, so a set of movements that cancel exactly can land at -2.8e-17 rather
 * than 0 — see the `0.3 - 0.1 - 0.2` case. Every comparison against zero has to go through here
 * first, or an item holding precisely nothing gets called impossible.
 *
 * It cannot hide a real negative: the smallest one the column can represent is -0.0001, which
 * survives the rounding intact.
 */
export function roundToStockPrecision(value: number): number {
  const factor = 10 ** STOCK_QUANTITY_DECIMALS
  return Math.round(value * factor) / factor
}

/**
 * `negative` is checked FIRST, and deliberately before the par-level branch (#146).
 *
 * A negative balance is not a low balance — it is an impossible one. You cannot hold minus
 * twenty-two of something, so the number is evidence that a deduction is wrong, not that stock
 * ran out. The vocabulary had no way to say that, and the two ways it used to be reported were
 * both silent:
 *
 *   par_level set   -> 'out_of_stock', which reads exactly like a legitimate zero
 *   par_level null  -> 'not_tracked', which reads as "nothing to report here"
 *
 * That is how a production item sat at -22 for three weeks and, on staging as this was written,
 * how 'whole milk' sat at -8617 with no par level (invisible) and 'espresso beans' at -154 with
 * one (indistinguishable from empty). Both live examples, one of each failure mode.
 *
 * Ordering it before the `parLevel == null` check is the whole point: the par level is a
 * reporting threshold, and an impossible quantity is impossible whether or not someone has set
 * a threshold for it.
 *
 * This is DETECTION ONLY. It changes what the stock screen says, not what any write is allowed
 * to do -- nothing here can refuse a deduction or fail an order. The write-time guard is a
 * separate, customer-facing decision (#146 recommendation 4).
 *
 * The balance is rounded to the stored precision ONCE, at entry, and every branch below reads
 * the rounded value. lib/stock/queries.ts:116 passes the raw JavaScript sum of the movement
 * deltas, so without this the `negative` branch fires on -2.8e-17 and paints "Impossible
 * (negative)" on an item that holds precisely nothing. Rounding only the negative check would
 * close that one case and leave this function disagreeing with itself at the zero boundary.
 */
export function computeStockStatus(currentStock: number, parLevel: number | null): StockStatus {
  const balance = roundToStockPrecision(currentStock)
  if (balance < 0) return 'negative'
  if (parLevel == null) return 'not_tracked'
  if (balance <= 0) return 'out_of_stock'
  if (balance <= parLevel) return 'low_stock'
  return 'healthy'
}

export function formatStockQuantity(value: number, baseUnit: string) {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  return `${formatted} ${baseUnit}`
}

/** Signed delta for count/adjustment previews, e.g. "+5 g" or "-12 g". */
export function formatSignedStockDelta(delta: number, baseUnit: string) {
  if (delta === 0) return `0 ${baseUnit}`
  const abs = Math.abs(delta)
  const formatted = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.?0+$/, '')
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatted} ${baseUnit}`
}

export function formatUnitCost(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

export function formatLastDelivery(value: string | null) {
  if (!value) return 'No deliveries yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatRelativeMovementTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  if (startOfDate.getTime() === startOfToday.getTime()) {
    return `Today, ${time}`
  }
  if (startOfDate.getTime() === startOfYesterday.getTime()) {
    return 'Yesterday'
  }

  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long' })
  }

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

export function formatReasonLabel(reason: string) {
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

export const ADJUSTMENT_TYPES = [
  { value: 'waste', label: 'Waste' },
  { value: 'sale', label: 'Sale (manual)' },
  { value: 'damage', label: 'Damage' },
  { value: 'count', label: 'Recount correction' },
  { value: 'other', label: 'Other' },
] as const

export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number]['value']

export const MOVEMENT_REASONS = [
  'received',
  'adjustment',
  'loss',
  'theft',
  'recount',
  'sale',
] as const

export type MovementReason = (typeof MOVEMENT_REASONS)[number]

export type MovementDateRange = '7d' | '30d' | 'all'

export function movementDateRangeStart(range: MovementDateRange): string | null {
  if (range === 'all') return null
  const days = range === '7d' ? 7 : 30
  const start = new Date()
  start.setDate(start.getDate() - days)
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}
