import { buildMenuUrl } from '@/lib/base-url'

export const KIOSK_TABLE_NUMBER_START = 1001

export const KIOSK_NAME_PRESETS = ['Entrance', 'Counter', 'Bar', 'Reception'] as const

export type OrderingPointRow = {
  id: string
  table_number: number
  table_name?: string | null
  location?: string | null
  capacity?: number | null
  qr_code_url?: string | null
  is_kiosk?: boolean | null
  active?: boolean | null
}

export function resolveOrderingPointQrUrl(
  restaurantId: string,
  point: Pick<OrderingPointRow, 'is_kiosk' | 'table_number' | 'qr_code_url'>,
): string {
  if (point.is_kiosk) {
    return buildMenuUrl(restaurantId, point.table_number, true)
  }
  return point.qr_code_url || buildMenuUrl(restaurantId, point.table_number)
}

export function orderingPointDisplayName(point: OrderingPointRow): string {
  if (point.is_kiosk) {
    return String(point.table_name || 'Kiosk').trim() || 'Kiosk'
  }
  const name = String(point.table_name || '').trim()
  if (name && !/^table\s+\d+$/i.test(name)) return name
  return `Table ${point.table_number}`
}

export function nextKioskTableNumber(existingNumbers: number[]): number {
  const kioskNumbers = existingNumbers.filter((n) => n >= KIOSK_TABLE_NUMBER_START)
  let candidate =
    kioskNumbers.length > 0 ? Math.max(...kioskNumbers) + 1 : KIOSK_TABLE_NUMBER_START
  const taken = new Set(existingNumbers)
  while (taken.has(candidate)) {
    candidate += 1
  }
  return candidate
}
