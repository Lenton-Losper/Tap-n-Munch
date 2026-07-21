import { buildMenuUrl } from '@/lib/base-url'

export const KIOSK_TABLE_NUMBER_START = 1001
// Separate reserved range so kiosk and view-only numbering never collide, however many
// of either a restaurant creates.
export const VIEW_ONLY_TABLE_NUMBER_START = 5001

export const KIOSK_NAME_PRESETS = ['Entrance', 'Counter', 'Bar', 'Reception'] as const
export const VIEW_ONLY_NAME_PRESETS = ['Entrance', 'Noticeboard', 'Reception', 'Lobby'] as const

export type OrderingPointRow = {
  id: string
  table_number: number
  table_name?: string | null
  location?: string | null
  capacity?: number | null
  qr_code_url?: string | null
  is_kiosk?: boolean | null
  is_view_only?: boolean | null
  active?: boolean | null
}

export function resolveOrderingPointQrUrl(
  restaurantId: string,
  point: Pick<OrderingPointRow, 'is_kiosk' | 'table_number' | 'qr_code_url'>,
): string {
  if (point.is_kiosk) {
    return buildMenuUrl(restaurantId, point.table_number, true)
  }
  // View-only points use the same plain table URL shape as a dining table -- the
  // reserved table_number is what the landing page uses to look up is_view_only and
  // render the stripped-down menu-only flow. No separate URL shape needed.
  return point.qr_code_url || buildMenuUrl(restaurantId, point.table_number)
}

export function orderingPointDisplayName(point: OrderingPointRow): string {
  if (point.is_kiosk) {
    return String(point.table_name || 'Kiosk').trim() || 'Kiosk'
  }
  if (point.is_view_only) {
    return String(point.table_name || 'Menu QR').trim() || 'Menu QR'
  }
  const name = String(point.table_name || '').trim()
  if (name && !/^table\s+\d+$/i.test(name)) return name
  return `Table ${point.table_number}`
}

export function nextKioskTableNumber(existingNumbers: number[]): number {
  const kioskNumbers = existingNumbers.filter(
    (n) => n >= KIOSK_TABLE_NUMBER_START && n < VIEW_ONLY_TABLE_NUMBER_START,
  )
  let candidate =
    kioskNumbers.length > 0 ? Math.max(...kioskNumbers) + 1 : KIOSK_TABLE_NUMBER_START
  const taken = new Set(existingNumbers)
  while (taken.has(candidate)) {
    candidate += 1
  }
  return candidate
}

export function nextViewOnlyTableNumber(existingNumbers: number[]): number {
  const viewOnlyNumbers = existingNumbers.filter((n) => n >= VIEW_ONLY_TABLE_NUMBER_START)
  let candidate =
    viewOnlyNumbers.length > 0 ? Math.max(...viewOnlyNumbers) + 1 : VIEW_ONLY_TABLE_NUMBER_START
  const taken = new Set(existingNumbers)
  while (taken.has(candidate)) {
    candidate += 1
  }
  return candidate
}
