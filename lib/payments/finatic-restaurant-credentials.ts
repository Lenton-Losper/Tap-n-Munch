import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * Same merchant/store resolution as checkout (`app/api/orders/route.ts`):
 * restaurant `finatic_merchant_no` / `finatic_store_no` when set, else
 * `PAYCLOUD_MERCHANT_NO` / `PAYCLOUD_STORE_NO`.
 */
export async function getRestaurantFinaticCredentials(
  restaurantId: string
): Promise<{ merchantNo: string; storeNo: string; terminalSn: string; terminals: any[] }> {
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('restaurants')
    .select('*')
    .eq('firebase_id', restaurantId)
    .single()

  const merchantNo = String(data?.finatic_merchant_no || process.env.PAYCLOUD_MERCHANT_NO || '').trim()
  const storeNo = String(data?.finatic_store_no || process.env.PAYCLOUD_STORE_NO || '').trim()
  const terminalSn = String(data?.finatic_terminal_sn || process.env.PAYCLOUD_TERMINAL_SN || 'WPYB002349003019').trim()
  const terminals = Array.isArray(data?.terminals) ? data.terminals : []
  return { merchantNo, storeNo, terminalSn, terminals }
}
