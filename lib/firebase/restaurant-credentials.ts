import { createServerSupabaseClient } from '@/lib/supabase/server'
import { adminDb } from '@/lib/firebase/admin-firestore'

export async function getRestaurantFinaticCredentials(
  restaurantId: string
) {
  try {
    const supabase = createServerSupabaseClient()

    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('*')
      .eq('firebase_id', restaurantId)
      .single()

    if (restaurant) {
      console.log('[CREDENTIALS] Found in Supabase:', {
        merchantNo: restaurant.finatic_merchant_no,
        storeNo: restaurant.finatic_store_no,
        terminalSn: restaurant.finatic_terminal_sn
      })
      return {
        merchantNo: restaurant.finatic_merchant_no || process.env.PAYCLOUD_MERCHANT_NO || '',
        storeNo: restaurant.finatic_store_no || process.env.PAYCLOUD_STORE_NO || '',
        terminalSn: restaurant.finatic_terminal_sn || null,
        terminals: restaurant.terminals || []
      }
    }
  } catch (err) {
    console.error('[CREDENTIALS] Supabase lookup failed:', err)
  }

  try {
    const db = adminDb()
    if (db) {
      const doc = await db.collection('restaurants').doc(restaurantId).get()
      const data = doc.data()
      if (data) {
        console.log('[CREDENTIALS] Found in Firebase:', {
          merchantNo: data.finatic_merchant_no,
          storeNo: data.finatic_store_no,
          terminalSn: data.finatic_terminal_sn
        })
        return {
          merchantNo: data.finatic_merchant_no || process.env.PAYCLOUD_MERCHANT_NO || '',
          storeNo: data.finatic_store_no || process.env.PAYCLOUD_STORE_NO || '',
          terminalSn: data.finatic_terminal_sn || null,
          terminals: data.terminals || []
        }
      }
    }
  } catch (err) {
    console.error('[CREDENTIALS] Firebase lookup failed:', err)
  }

  return {
    merchantNo: process.env.PAYCLOUD_MERCHANT_NO || '',
    storeNo: process.env.PAYCLOUD_STORE_NO || '',
    terminalSn: null,
    terminals: []
  }
}
