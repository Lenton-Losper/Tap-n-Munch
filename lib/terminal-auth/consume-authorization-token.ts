import { createServerSupabaseClient } from '@/lib/supabase/server'

export type ConsumeAuthorizationTokenResult =
  | { ok: true }
  | {
      ok: false
      reason: 'not_found' | 'already_used' | 'expired' | 'mismatch'
    }

type ConsumeAuthorizationTokenParams = {
  tokenId: string
  expectedUserId: string
  expectedRestaurantId: string
  expectedTerminalId: string
  expectedPurpose: string
}

type TokenRow = {
  id: string
  user_id: string
  restaurant_id: string
  terminal_id: string
  purpose: string
  used_at: string | null
  expires_at: string
}

function classifyConsumeFailure(
  token: TokenRow | null,
  params: ConsumeAuthorizationTokenParams,
): ConsumeAuthorizationTokenResult {
  if (!token) {
    return { ok: false, reason: 'not_found' }
  }

  if (token.used_at) {
    return { ok: false, reason: 'already_used' }
  }

  const expiresAt = new Date(token.expires_at)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    return { ok: false, reason: 'expired' }
  }

  if (
    token.user_id !== params.expectedUserId ||
    token.restaurant_id !== params.expectedRestaurantId ||
    token.terminal_id !== params.expectedTerminalId ||
    token.purpose !== params.expectedPurpose
  ) {
    return { ok: false, reason: 'mismatch' }
  }

  // Row exists and appears valid but the atomic UPDATE did not claim it (race).
  return { ok: false, reason: 'already_used' }
}

async function recordAuthorizationEvent(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  event: {
    event_type: 'consumed' | 'denied'
    actor_user_id: string
    restaurant_id: string
    terminal_id: string
    token_id: string | null
    detail?: Record<string, unknown>
  },
) {
  const { error } = await supabase.from('authorization_events').insert({
    event_type: event.event_type,
    actor_user_id: event.actor_user_id,
    restaurant_id: event.restaurant_id,
    terminal_id: event.terminal_id,
    token_id: event.token_id,
    detail: event.detail ?? null,
  })

  if (error) throw error
}

/**
 * Atomically consume a privileged authorization token (single-use).
 * Uses a conditional UPDATE so concurrent callers cannot both succeed.
 */
export async function consumeAuthorizationToken(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  params: ConsumeAuthorizationTokenParams,
): Promise<ConsumeAuthorizationTokenResult> {
  const {
    tokenId,
    expectedUserId,
    expectedRestaurantId,
    expectedTerminalId,
    expectedPurpose,
  } = params

  const nowIso = new Date().toISOString()

  const { data: consumed, error: consumeError } = await supabase
    .from('privileged_authorization_tokens')
    .update({ used_at: nowIso })
    .eq('id', tokenId)
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .eq('user_id', expectedUserId)
    .eq('restaurant_id', expectedRestaurantId)
    .eq('terminal_id', expectedTerminalId)
    .eq('purpose', expectedPurpose)
    .select('id')
    .maybeSingle()

  if (consumeError) throw consumeError

  if (consumed?.id) {
    await recordAuthorizationEvent(supabase, {
      event_type: 'consumed',
      actor_user_id: expectedUserId,
      restaurant_id: expectedRestaurantId,
      terminal_id: expectedTerminalId,
      token_id: String(consumed.id),
    })
    return { ok: true }
  }

  const { data: tokenRow, error: fetchError } = await supabase
    .from('privileged_authorization_tokens')
    .select('id, user_id, restaurant_id, terminal_id, purpose, used_at, expires_at')
    .eq('id', tokenId)
    .maybeSingle()

  if (fetchError) throw fetchError

  const failure = classifyConsumeFailure(
    tokenRow as TokenRow | null,
    params,
  )

  if (!failure.ok) {
    await recordAuthorizationEvent(supabase, {
      event_type: 'denied',
      actor_user_id: expectedUserId,
      restaurant_id: expectedRestaurantId,
      terminal_id: expectedTerminalId,
      token_id: tokenRow?.id ? String(tokenRow.id) : null,
      detail: { reason: failure.reason, action: 'consume_token' },
    })
  }

  return failure
}
