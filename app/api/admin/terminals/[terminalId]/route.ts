import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantOwner,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ terminalId: string }> }
) {
  try {
    const user = await getUserFromRequest(request)
    const { terminalId } = await params
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

    const { data: terminal, error: findError } = await supabase
      .from('restaurant_terminals')
      .select('id')
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (findError) throw findError
    if (!terminal?.id) {
      return NextResponse.json({ error: 'Terminal not found' }, { status: 404 })
    }

    const { error: deleteError } = await supabase
      .from('restaurant_terminals')
      .delete()
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)

    if (deleteError) throw deleteError

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to remove terminal'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('owner') || message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
