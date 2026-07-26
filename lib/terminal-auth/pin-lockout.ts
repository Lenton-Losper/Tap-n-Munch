/**
 * Staff PIN lockout for terminal authorize.
 * Threshold: 5 failed PIN attempts in a 10-minute window → locked for that window.
 * Mistyping once or twice does not lock; correct PIN works until the threshold.
 */
export const PIN_MAX_FAILED_ATTEMPTS = 5
/** Sliding window / lockout duration (ms). */
export const PIN_LOCKOUT_WINDOW_MS = 10 * 60 * 1000

export type PinLockoutStatus = {
  locked: boolean
  failedAttempts: number
  retryAfterSeconds: number
}

type SupabaseLike = {
  from: (table: string) => any
}

export async function getPinLockoutStatus(
  supabase: SupabaseLike,
  params: {
    restaurantId: string
    userId: string
    nowMs?: number
  },
): Promise<PinLockoutStatus> {
  const nowMs = params.nowMs ?? Date.now()
  const sinceIso = new Date(nowMs - PIN_LOCKOUT_WINDOW_MS).toISOString()

  const { data, error } = await supabase
    .from('authorization_events')
    .select('id, created_at, detail')
    .eq('restaurant_id', params.restaurantId)
    .eq('actor_user_id', params.userId)
    .eq('event_type', 'denied')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw error

  const pinFailures = (data ?? []).filter((row: { detail?: unknown }) => {
    const detail = row.detail as { reason?: unknown } | null
    return detail?.reason === 'pin_mismatch'
  })

  const failedAttempts = pinFailures.length
  if (failedAttempts < PIN_MAX_FAILED_ATTEMPTS) {
    return { locked: false, failedAttempts, retryAfterSeconds: 0 }
  }

  const oldestRelevant = pinFailures[PIN_MAX_FAILED_ATTEMPTS - 1]
  const oldestMs = Date.parse(String(oldestRelevant?.created_at ?? ''))
  const unlockAt = (Number.isFinite(oldestMs) ? oldestMs : nowMs) + PIN_LOCKOUT_WINDOW_MS
  const retryAfterSeconds = Math.max(1, Math.ceil((unlockAt - nowMs) / 1000))

  return { locked: true, failedAttempts, retryAfterSeconds }
}
