export type StockStatus = 'out_of_stock' | 'low_stock' | 'healthy' | 'not_tracked'

export function computeStockStatus(currentStock: number, parLevel: number | null): StockStatus {
  if (parLevel == null) return 'not_tracked'
  if (currentStock <= 0) return 'out_of_stock'
  if (currentStock <= parLevel) return 'low_stock'
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
