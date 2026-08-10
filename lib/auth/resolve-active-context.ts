import { createServerSupabaseClient } from '@/lib/supabase/server'
import { contextsEqual, destinationForContext, resolveUserContexts, type UserContext } from './resolve-user-contexts'

export type { UserContext }
export { destinationForContext }

export type LoginDestination =
  | { kind: 'resolved'; context: UserContext; destination: string }
  | { kind: 'picker'; contexts: UserContext[] }
  | { kind: 'none' }

/** Restaurant-scoped route roots under app/(staff) -- there is no per-restaurant
 *  URL segment yet (single active-restaurant-per-session), so "access to a
 *  restaurant-scoped redirect" just means "has at least one restaurant context". */
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

/** Same-app path guard against open redirects: must be a root-relative path,
 *  never protocol-relative ("//host/..."), an absolute URL, or a backslash form
 *  ("/\host", which browsers normalise into "//host"). Whitespace and control
 *  characters never appear in a real path from middleware -- a link carrying them
 *  is being built by someone else, so refuse it rather than reason about it. */
function isSafeRedirectPath(redirectParam: string): boolean {
  return (
    redirectParam.startsWith('/') &&
    !redirectParam.startsWith('//') &&
    !redirectParam.includes('://') &&
    !redirectParam.includes('\\') &&
    !/[\s\u0000-\u001f\u007f]/.test(redirectParam)
  )
}

/** A path is "under" a route root only at a segment or query/hash boundary --
 *  '/adminish' is not an admin path. */
function isUnderPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true
  const next = path.charAt(prefix.length)
  return path.startsWith(prefix) && (next === '/' || next === '?' || next === '#')
}

/** Rule 1: match a requested redirect path against the user's REAL contexts.
 *  Returns null (never honored) unless the path maps to a context type the
 *  user actually has -- an unmatched or unrecognized redirect is ignored
 *  entirely, falling through to rule 2, not silently sent somewhere else.
 *
 *  The requested path itself is the destination, not the root of the matched
 *  context: middleware sets ?redirect=<pathname> for any /admin/* bounce, and
 *  answering /admin/terminals with /admin drops the page the user asked for. */
function matchRedirectToContext(
  redirectParam: string | null | undefined,
  contexts: UserContext[],
): { context: UserContext; destination: string } | null {
  if (!redirectParam || !isSafeRedirectPath(redirectParam)) return null

  const contextForPath = isUnderPrefix(redirectParam, '/admin')
    ? contexts.find((c) => c.type === 'platform')
    : RESTAURANT_SCOPED_PREFIXES.some((prefix) => isUnderPrefix(redirectParam, prefix))
      ? contexts.find((c) => c.type === 'restaurant')
      : undefined

  if (!contextForPath) return null

  return { context: contextForPath, destination: redirectParam }
}

async function writeActiveContext(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
  context: UserContext,
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

async function readStoredContext(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
): Promise<UserContext | null> {
  const { data, error } = await supabase
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[resolve-active-context] failed to read user_active_context:', error)
    return null
  }
  if (!data) return null

  if (data.context_type === 'platform') {
    // Role isn't stored in user_active_context -- filled in from the real
    // contexts list by the caller's contextsEqual match, this is only used
    // for comparison, never returned directly.
    return { type: 'platform', role: 'support' }
  }
  if (data.context_type === 'restaurant' && data.restaurant_id) {
    return { type: 'restaurant', restaurantId: data.restaurant_id, role: '' }
  }
  return null
}

/**
 * Resolves where an account should land after signing in, replacing the old
 * implicit-platform-admin-fallback Phase 1 logic. Shared by the Google OAuth
 * callback and the email/password sign-in flow so there is exactly one place
 * this precedence is decided.
 *
 * Precedence:
 *   1. An access-verified `redirectParam` wins outright (checked against the
 *      user's real resolveUserContexts() list, not just presence of the param).
 *   2. Exactly one context available -- no ambiguity to resolve.
 *   3. A stored user_active_context row, re-validated against current access
 *      (a revoked context is NOT trusted, falls through to rule 4).
 *   4. Multiple contexts, nothing valid stored -- do NOT default to platform
 *      admin. Caller shows the context picker instead.
 */
export async function resolveLoginDestination(params: {
  userId: string
  redirectParam?: string | null
}): Promise<LoginDestination> {
  const { userId, redirectParam } = params
  const supabase = createServerSupabaseClient()

  const contexts = await resolveUserContexts(userId)

  // Rule 1
  const redirectMatch = matchRedirectToContext(redirectParam, contexts)
  if (redirectMatch) {
    await writeActiveContext(supabase, userId, redirectMatch.context)
    return { kind: 'resolved', context: redirectMatch.context, destination: redirectMatch.destination }
  }

  // Rule 2
  if (contexts.length === 1) {
    const only = contexts[0]
    await writeActiveContext(supabase, userId, only)
    return { kind: 'resolved', context: only, destination: destinationForContext(only) }
  }

  if (contexts.length === 0) {
    return { kind: 'none' }
  }

  // Rule 3
  const stored = await readStoredContext(supabase, userId)
  const matched = stored ? contexts.find((c) => contextsEqual(c, stored)) : null
  if (matched) {
    return { kind: 'resolved', context: matched, destination: destinationForContext(matched) }
  }

  // Rule 4 -- ambiguous, nothing valid stored: picker, never a silent platform default.
  return { kind: 'picker', contexts }
}
