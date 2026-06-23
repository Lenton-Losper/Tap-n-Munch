import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantOwner,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const merchantNo = String(body?.merchantNo || '').trim()
    const storeNo = String(body?.storeNo || '').trim()

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

    const { error } = await supabase
      .from('restaurants')
      .update({
        finatic_merchant_no: merchantNo || null,
        finatic_store_no: storeNo || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', restaurantId)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save account details'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('owner')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
