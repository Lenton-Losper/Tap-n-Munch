import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { authorize } from '@/lib/permissions/authorize'
import { resolveTerminalAuthorizationPermission } from '@/lib/terminal-auth/purpose-permissions'
import { validateTerminalPin, verifyTerminalPin } from '@/lib/terminal-auth/pin-credentials'

export const dynamic = 'force-dynamic'

const DEFAULT_TTL_SECONDS = 90

type AuthorizeBody = {
  user_id?: unknown
  pin?: unknown
  purpose?: unknown
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

async function recordAuthorizationEvent(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  event: {
    event_type: 'issued' | 'denied'
    actor_user_id: string | null
    restaurant_id: string
    terminal_id: string
    token_id?: string | null
    detail?: Record<string, unknown>
  },
) {
  const { error } = await supabase.from('authorization_events').insert({
    event_type: event.event_type,
    actor_user_id: event.actor_user_id,
    restaurant_id: event.restaurant_id,
    terminal_id: event.terminal_id,
    token_id: event.token_id ?? null,
    detail: event.detail ?? null,
  })

  if (error) throw error
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as AuthorizeBody
    const userId = String(body.user_id ?? '').trim()
    const pin = String(body.pin ?? '').trim()
    const purpose = String(body.purpose ?? '').trim()

    if (!userId || !isUuid(userId)) {
      return NextResponse.json({ error: 'user_id must be a valid UUID' }, { status: 400 })
    }

    if (!validateTerminalPin(pin)) {
      return NextResponse.json(
        { error: 'PIN must be exactly 4 digits (0-9)' },
        { status: 400 },
      )
    }

    const permission = resolveTerminalAuthorizationPermission(purpose)
    if (!permission) {
      return NextResponse.json({ error: 'Unrecognized purpose' }, { status: 400 })
    }

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle()

    if (userError) throw userError

    if (!userRow?.id) {
      return NextResponse.json({ error: 'Unknown user_id' }, { status: 400 })
    }

    const auditBase = {
      actor_user_id: userId,
      restaurant_id: terminal.restaurantId,
      terminal_id: terminal.terminalId,
      detail: { purpose, permission },
    }

    const { data: membership, error: membershipError } = await supabase
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (membershipError) throw membershipError

    if (!membership?.user_id) {
      await recordAuthorizationEvent(supabase, {
        ...auditBase,
        event_type: 'denied',
        detail: { ...auditBase.detail, reason: 'not_a_member' },
      })
      return NextResponse.json({ error: 'Authorization denied' }, { status: 403 })
    }

    const allowed = await authorize(userId, terminal.restaurantId, permission)
    if (!allowed) {
      await recordAuthorizationEvent(supabase, {
        ...auditBase,
        event_type: 'denied',
        detail: { ...auditBase.detail, reason: 'missing_permission' },
      })
      return NextResponse.json({ error: 'Authorization denied' }, { status: 403 })
    }

    const { data: credential, error: credentialError } = await supabase
      .from('terminal_authorization_credentials')
      .select('pin_hash, pin_salt')
      .eq('user_id', userId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (credentialError) throw credentialError

    if (!credential?.pin_hash || !credential?.pin_salt) {
      await recordAuthorizationEvent(supabase, {
        ...auditBase,
        event_type: 'denied',
        detail: { ...auditBase.detail, reason: 'no_credential' },
      })
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 403 })
    }

    const pinValid = await verifyTerminalPin(
      pin,
      String(credential.pin_hash),
      String(credential.pin_salt),
    )

    if (!pinValid) {
      await recordAuthorizationEvent(supabase, {
        ...auditBase,
        event_type: 'denied',
        detail: { ...auditBase.detail, reason: 'pin_mismatch' },
      })
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 })
    }

    const nonce = crypto.randomUUID()
    const ttlSeconds = DEFAULT_TTL_SECONDS
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()

    const { data: tokenRow, error: tokenError } = await supabase
      .from('privileged_authorization_tokens')
      .insert({
        user_id: userId,
        restaurant_id: terminal.restaurantId,
        terminal_id: terminal.terminalId,
        purpose,
        nonce,
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      })
      .select('id, expires_at')
      .single()

    if (tokenError || !tokenRow?.id) {
      throw tokenError ?? new Error('Failed to issue authorization token')
    }

    await recordAuthorizationEvent(supabase, {
      event_type: 'issued',
      actor_user_id: userId,
      restaurant_id: terminal.restaurantId,
      terminal_id: terminal.terminalId,
      token_id: String(tokenRow.id),
      detail: { purpose, permission, ttl_seconds: ttlSeconds },
    })

    return NextResponse.json({
      token_id: String(tokenRow.id),
      expires_at: String(tokenRow.expires_at),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/authorize POST] failed:', err)
    return NextResponse.json({ error: 'Authorization failed' }, { status: 500 })
  }
}
