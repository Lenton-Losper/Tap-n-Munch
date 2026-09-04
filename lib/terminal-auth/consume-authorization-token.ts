import { createServerSupabaseClient } from '@/lib/supabase/server'
import { authorize } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'

export type ConsumeAuthorizationTokenResult =
  | { ok: true }
  | {
      ok: false
      reason: 'not_found' | 'already_used' | 'expired' | 'mismatch' | 'missing_permission'
    }

type ConsumeAuthorizationTokenParams = {
  tokenId: string
  expectedUserId: string
  expectedRestaurantId: string
  expectedTerminalId: string
  expectedPurpose: string
  /**
   * ============================================================================================
   * RE-CHECK THE PERMISSION AT CONSUME TIME — one enforcement point is one bug away from none
   * ============================================================================================
   *
   * Until 2026-09-04 the permission behind a purpose was checked ONCE, when the token was minted
   * by POST /api/terminal/authorize. Consumption verified the token's user, restaurant, terminal,
   * purpose and expiry — but never asked again whether that user may still do the thing.
   *
   * A token was therefore BEARER AUTHORITY: anything holding one could spend it and the acting
   * route re-verified nothing. Found by effect while proving Ship 2's gate — a probe minted a
   * walkout token for a waiter directly, bypassing the only place the check lives, and the walkout
   * route accepted it and closed the table.
   *
   * A minted token is also not instantaneous. It carries a TTL, and in that window a manager can
   * be demoted, removed from the venue, or have the permission unticked. With a single check, a
   * token minted before a demotion stays spendable until it expires.
   *
   * OPTIONAL, deliberately. Passing it opts a caller into the stricter behaviour. `refund` and
   * `cash_settlement` are unchanged in this ship: widening an auth path every till depends on is
   * its own change with its own verification, not a rider on this one.
   */
  requirePermission?: Permission
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

  /**
   * BEFORE the consuming UPDATE, so a token that should not exist is never spent.
   *
   * Checking after would burn the token on the way to refusing, which turns a permission error
   * into a second problem: the manager's authorisation is gone and they have to PIN in again for a
   * refusal they will meet identically the second time.
   *
   * A denial is recorded as an authorization_event with the same shape as every other, so "someone
   * tried to spend a token they were not entitled to" is visible rather than inferred from a
   * missing success.
   */
  if (params.requirePermission) {
    let allowed = false
    try {
      allowed = await authorize(expectedUserId, expectedRestaurantId, params.requirePermission)
    } catch (permErr) {
      // FAILS CLOSED. Not being able to read a permission is not permission.
      console.error('[consume-authorization-token] permission check failed', permErr)
      allowed = false
    }
    if (!allowed) {
      await recordAuthorizationEvent(supabase, {
        event_type: 'denied',
        actor_user_id: expectedUserId,
        restaurant_id: expectedRestaurantId,
        terminal_id: expectedTerminalId,
        token_id: tokenId,
        detail: {
          reason: 'missing_permission',
          action: 'consume_token',
          permission: params.requirePermission,
          purpose: expectedPurpose,
        },
      })
      return { ok: false, reason: 'missing_permission' }
    }
  }

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
