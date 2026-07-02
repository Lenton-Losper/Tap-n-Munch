import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  try {
    const { inviteId } = await params
    if (!inviteId?.trim()) {
      return NextResponse.json({ error: 'Missing invite id' }, { status: 400 })
    }

    const user = await getUserFromRequest(_request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const { data: invite, error: inviteError } = await supabase
      .from('staff_invites')
      .select('id, restaurant_id, accepted')
      .eq('id', inviteId)
      .maybeSingle()

    if (inviteError) throw inviteError
    if (!invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
    }
    if (String(invite.restaurant_id) !== restaurantId) {
      return NextResponse.json({ error: 'Invite does not belong to this restaurant' }, { status: 403 })
    }
    if (invite.accepted) {
      return NextResponse.json({ error: 'Accepted invites cannot be cancelled' }, { status: 400 })
    }

    const { error: deleteError } = await supabase
      .from('staff_invites')
      .delete()
      .eq('id', inviteId)
      .eq('restaurant_id', restaurantId)
      .eq('accepted', false)

    if (deleteError) throw deleteError

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to cancel invite'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[admin/invites DELETE]', error)
    return NextResponse.json({ error: message }, { status })
  }
}
