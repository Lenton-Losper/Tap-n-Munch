import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdsForUser } from '@/lib/supabase/admin-restaurant-auth'

export type ActiveContext =
  | { type: 'platform'; restaurantId: null }
  | { type: 'restaurant'; restaurantId: string }

export type ResolvedActiveContext = {
  /** null only when the account has neither a platform_admins row nor any
   *  restaurant_users membership -- callers decide their own fallback
   *  (e.g. onboarding/signup) for that case, since it isn't a precedence
   *  question. */
  context: ActiveContext | null
}

/** Restaurant-scoped route roots under app/(staff) -- there is no per-restaurant
 *  URL segment yet (single active-restaurant-per-session), so "access to a
 *  restaurant-scoped redirect" just means "has at least one membership". */
const RESTAURANT_SCOPED_PREFIXES = [
  '/dashboard',
  '/analytics',
  '/documents',
  '/menu-management',
  '/qr-codes',
  '/settings',
  '/staff',
  '/stock',
]

export function destinationForContext(context: ActiveContext): string {
  return context.type === 'platform' ? '/admin' : '/dashboard'
}

async function checkIsPlatformAdmin(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_platform_admin', { p_user_id: userId })
  if (error) {
    console.error('[resolve-active-context] is_platform_admin check failed:', error)
    return false
  }
  return data === true
}

async function writeActiveContext(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
  context: ActiveContext,
): Promise<void> {
  const { error } = await supabase.from('user_active_context').upsert(
    {
      user_id: userId,
      context_type: context.type,
      restaurant_id: context.type === 'restaurant' ? context.restaurantId : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) {
    console.error('[resolve-active-context] failed to write user_active_context:', error)
  }
}

/** Same-app path guard against open redirects: must be a root-relative path,
 *  never protocol-relative ("//host/...") or an absolute URL. */
function isSafeRedirectPath(redirectParam: string): boolean {
  return redirectParam.startsWith('/') && !redirectParam.startsWith('//') && !redirectParam.includes('://')
}

/** Rule 1: match a requested redirect path to a context the user actually has
 *  verified access to. Returns null if the path isn't recognized as
 *  context-scoped, or the user doesn't have access to the context it maps to
 *  -- never honors an unverified redirect. */
function matchRedirectToContext(
  redirectParam: string | null | undefined,
  isAdmin: boolean,
  restaurantIds: string[],
): ActiveContext | null {
  if (!redirectParam || !isSafeRedirectPath(redirectParam)) return null

  if (redirectParam.startsWith('/admin')) {
    return isAdmin ? { type: 'platform', restaurantId: null } : null
  }

  if (RESTAURANT_SCOPED_PREFIXES.some((prefix) => redirectParam.startsWith(prefix))) {
    return restaurantIds.length > 0 ? { type: 'restaurant', restaurantId: restaurantIds[0] } : null
  }

  return null
}

/**
 * Resolves which context (platform admin console vs. a specific restaurant)
 * an account should land in after signing in, replacing the old
 * `restaurantId ? '/dashboard' : isPlatformAdmin ? '/admin' : '/dashboard'`
 * ternary that always favored restaurant membership. Shared by the Google
 * OAuth callback and the email/password sign-in flow so there is exactly one
 * place this precedence is decided.
 *
 * Precedence:
 *   1. An access-verified `redirectParam` wins outright.
 *   2. Exactly one context available (platform admin XOR exactly one
 *      restaurant membership) -- no ambiguity to resolve.
 *   3. A stored user_active_context row, re-verified against current access
 *      (a revoked context falls through to rule 4, not back to rule 2).
 *   4. Default: platform if the user is a platform admin, else their first
 *      restaurant. Persisted so the next sign-in hits rule 3 instead.
 */
export async function resolveActiveContext(params: {
  userId: string
  redirectParam?: string | null
}): Promise<ResolvedActiveContext> {
  const { userId, redirectParam } = params
  const supabase = createServerSupabaseClient()

  const [isAdmin, restaurantIds] = await Promise.all([
    checkIsPlatformAdmin(supabase, userId),
    getRestaurantIdsForUser(supabase, userId),
  ])

  // Rule 1
  const redirectContext = matchRedirectToContext(redirectParam, isAdmin, restaurantIds)
  if (redirectContext) {
    await writeActiveContext(supabase, userId, redirectContext)
    return { context: redirectContext }
  }

  // Rule 2
  if (isAdmin && restaurantIds.length === 0) {
    const context: ActiveContext = { type: 'platform', restaurantId: null }
    await writeActiveContext(supabase, userId, context)
    return { context }
  }
  if (!isAdmin && restaurantIds.length === 1) {
    const context: ActiveContext = { type: 'restaurant', restaurantId: restaurantIds[0] }
    await writeActiveContext(supabase, userId, context)
    return { context }
  }

  // Rule 3
  const { data: stored, error: storedError } = await supabase
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (storedError) {
    console.error('[resolve-active-context] failed to read user_active_context:', storedError)
  }

  if (stored) {
    if (stored.context_type === 'platform' && isAdmin) {
      return { context: { type: 'platform', restaurantId: null } }
    }
    if (
      stored.context_type === 'restaurant' &&
      stored.restaurant_id &&
      restaurantIds.includes(stored.restaurant_id)
    ) {
      return { context: { type: 'restaurant', restaurantId: stored.restaurant_id } }
    }
    // Stored context no longer reflects actual access -- fall through to rule 4.
  }

  // Rule 4
  if (isAdmin) {
    const context: ActiveContext = { type: 'platform', restaurantId: null }
    await writeActiveContext(supabase, userId, context)
    return { context }
  }
  if (restaurantIds.length > 0) {
    const context: ActiveContext = { type: 'restaurant', restaurantId: restaurantIds[0] }
    await writeActiveContext(supabase, userId, context)
    return { context }
  }

  return { context: null }
}
