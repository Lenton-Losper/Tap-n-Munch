import { getCachedRestaurantCredentials } from '@/lib/cache/restaurant-cache'

export async function getRestaurantFinaticCredentials(
  restaurantId: string
): Promise<{ merchantNo: string; storeNo: string; terminalSn: string | null; terminals: unknown[] }> {
  const data = await getCachedRestaurantCredentials(restaurantId)

  const merchantNo = String(data?.finatic_merchant_no || '').trim()
  const storeNo = String(data?.finatic_store_no || '').trim()
  const terminalSn = data?.finatic_terminal_sn ? String(data.finatic_terminal_sn).trim() : null
  const terminals = Array.isArray((data as { terminals?: unknown[] })?.terminals)
    ? (data as { terminals?: unknown[] }).terminals!
    : []

  if (!merchantNo || !storeNo) {
    throw new Error(`No Finatic credentials configured for restaurant`)
  }

  return { merchantNo, storeNo, terminalSn, terminals }
}
