import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function getRestaurantFinaticCredentials(
  restaurantId: string
) {
  const supabase = createServerSupabaseClient()

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .eq('firebase_id', restaurantId)
    .single()

  return {
    merchantNo: restaurant?.finatic_merchant_no
      || process.env.PAYCLOUD_MERCHANT_NO || '',
    storeNo: restaurant?.finatic_store_no
      || process.env.PAYCLOUD_STORE_NO || '',
    terminalSn: restaurant?.finatic_terminal_sn
      || process.env.PAYCLOUD_TERMINAL_SN
      || 'WPYB002349003019',
    terminals: restaurant?.terminals || []
  }
}
