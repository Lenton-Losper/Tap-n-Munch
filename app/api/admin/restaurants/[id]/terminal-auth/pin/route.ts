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

type RevokePinBody = {
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

/**
 * Deletes any not-yet-consumed authorization tokens for this user/restaurant so a PIN
 * change can't be bypassed by an authorization token issued under the old PIN.
 * consumeAuthorizationToken() treats a missing row as 'not_found', so deletion alone
 * is sufficient to invalidate them -- no new column/status needed.
 */
async function invalidateOutstandingTokens(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  targetUserId: string,
  restaurantId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('privileged_authorization_tokens')
    .delete()
    .eq('user_id', targetUserId)
    .eq('restaurant_id', restaurantId)
    .is('used_at', null)
    .select('id')

  if (error) throw error
  return data?.length ?? 0
}

/** List restaurant staff with PIN status (never the PIN value itself). */
export async function GET(
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
    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.TERMINAL_AUTH_MANAGE)
    if (denied) return denied

    const { data: staff, error: staffError } = await supabase
      .from('restaurant_users')
      .select('user_id, role, users!restaurant_users_user_id_fkey(email, name)')
      .eq('restaurant_id', restaurantId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    if (staffError) throw staffError

    const { data: credentials, error: credentialsError } = await supabase
      .from('terminal_authorization_credentials')
      .select('user_id, updated_at')
      .eq('restaurant_id', restaurantId)

    if (credentialsError) throw credentialsError

    const pinSetByUserId = new Map(
      (credentials ?? []).map((c) => [String(c.user_id), String(c.updated_at)]),
    )

    const result = (staff ?? []).map((member: any) => ({
      user_id: member.user_id,
      role: member.role,
      email: member.users?.email ?? null,
      name: member.users?.name ?? null,
      pin_status: pinSetByUserId.has(String(member.user_id)) ? 'set' : 'not_set',
      pin_updated_at: pinSetByUserId.get(String(member.user_id)) ?? null,
    }))

    return NextResponse.json({ staff: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load PIN status'
    console.error('[terminal-auth/pin GET] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
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

    // A new/changed PIN invalidates any outstanding authorization token issued under
    // the old PIN -- otherwise a token from before the change could still be consumed.
    const invalidatedTokenCount = await invalidateOutstandingTokens(
      supabase,
      targetUserId,
      restaurantId,
    )

    const { error: auditError } = await supabase.from('authorization_events').insert({
      event_type: eventType,
      actor_user_id: user.id,
      restaurant_id: restaurantId,
      terminal_id: null,
      detail: { target_user_id: targetUserId, invalidated_token_count: invalidatedTokenCount },
    })

    if (auditError) throw auditError

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to set terminal PIN'
    console.error('[terminal-auth/pin POST] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Revoke (clear) a staff member's terminal PIN entirely. */
export async function DELETE(
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
    const body = (await request.json().catch(() => ({}))) as RevokePinBody
    const targetUserId = String(body.target_user_id ?? user.id).trim()

    if (!targetUserId || !isUuid(targetUserId)) {
      return NextResponse.json({ error: 'target_user_id must be a valid UUID' }, { status: 400 })
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

    const { error: deleteError } = await supabase
      .from('terminal_authorization_credentials')
      .delete()
      .eq('user_id', targetUserId)
      .eq('restaurant_id', restaurantId)

    if (deleteError) throw deleteError

    const invalidatedTokenCount = await invalidateOutstandingTokens(
      supabase,
      targetUserId,
      restaurantId,
    )

    const { error: auditError } = await supabase.from('authorization_events').insert({
      event_type: 'credential_revoked',
      actor_user_id: user.id,
      restaurant_id: restaurantId,
      terminal_id: null,
      detail: { target_user_id: targetUserId, invalidated_token_count: invalidatedTokenCount },
    })

    if (auditError) throw auditError

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to revoke terminal PIN'
    console.error('[terminal-auth/pin DELETE] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
