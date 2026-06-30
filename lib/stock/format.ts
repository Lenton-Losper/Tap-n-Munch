export function formatStockQuantity(value: number, baseUnit: string) {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  return `${formatted} ${baseUnit}`
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
