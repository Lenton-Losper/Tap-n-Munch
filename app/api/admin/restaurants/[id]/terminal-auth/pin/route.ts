import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { hashTerminalPin, validateTerminalPin } from '@/lib/terminal-auth/pin-credentials'

export const dynamic = 'force-dynamic'

type SetPinBody = {
  pin?: unknown
  target_user_id?: unknown
}

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as SetPinBody
    const pin = String(body.pin ?? '').trim()
    const targetUserId = String(body.target_user_id ?? user.id).trim()

    if (!targetUserId || !isUuid(targetUserId)) {
      return NextResponse.json({ error: 'target_user_id must be a valid UUID' }, { status: 400 })
    }

    if (!validateTerminalPin(pin)) {
      return NextResponse.json(
        { error: 'PIN must be exactly 4 digits (0-9)' },
        { status: 400 },
      )
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    if (targetUserId !== user.id) {
      const denied = await requirePermission(
        user.id,
        restaurantId,
        PERMISSIONS.TERMINAL_AUTH_MANAGE,
      )
      if (denied) return denied
    }

    const { data: targetMembership, error: membershipError } = await supabase
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', restaurantId)
      .eq('user_id', targetUserId)
      .is('deleted_at', null)
      .maybeSingle()

    if (membershipError) throw membershipError
    if (!targetMembership?.user_id) {
      return NextResponse.json(
        { error: 'Target user is not a member of this restaurant' },
        { status: 403 },
      )
    }

    const { data: existingCredential, error: existingError } = await supabase
      .from('terminal_authorization_credentials')
      .select('user_id')
      .eq('user_id', targetUserId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (existingError) throw existingError

    const eventType = existingCredential ? 'credential_reset' : 'credential_set'
    const { pinHash, pinSalt } = await hashTerminalPin(pin)
    const now = new Date().toISOString()

    if (existingCredential) {
      const { error: updateError } = await supabase
        .from('terminal_authorization_credentials')
        .update({
          pin_hash: pinHash,
          pin_salt: pinSalt,
          updated_at: now,
        })
        .eq('user_id', targetUserId)
        .eq('restaurant_id', restaurantId)

      if (updateError) throw updateError
    } else {
      const { error: insertError } = await supabase
        .from('terminal_authorization_credentials')
        .insert({
          user_id: targetUserId,
          restaurant_id: restaurantId,
          pin_hash: pinHash,
          pin_salt: pinSalt,
        })

      if (insertError) throw insertError
    }

    const { error: auditError } = await supabase.from('authorization_events').insert({
      event_type: eventType,
      actor_user_id: user.id,
      restaurant_id: restaurantId,
      terminal_id: null,
      detail: { target_user_id: targetUserId },
    })

    if (auditError) throw auditError

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to set terminal PIN'
    console.error('[terminal-auth/pin POST] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
