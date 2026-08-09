/**
 * Issue #66. An account that is both a platform_admins super_admin and a restaurant_users
 * owner landed on /dashboard, ignoring both the platform role and ?redirect=%2Fadmin,
 * because each sign-in entry point decided the destination for itself with a
 * `restaurantId ? '/dashboard' : ...` ternary and never read the redirect param.
 *
 * Both entry points now go through resolveLoginDestination, so these tests pin the
 * precedence in the one place that decides it -- including the part that was still wrong:
 * a redirect only ever resolved to the ROOT of the matched context, so middleware bouncing
 * an unauthenticated admin off /admin/terminals sent them to /admin after sign-in.
 *
 * The guard rails matter as much as the routing: a redirect is honoured only when it maps
 * to a context the account genuinely has, and only when it is a same-app path.
 */
const resolveUserContexts = jest.fn()

jest.mock('@/lib/auth/resolve-user-contexts', () => {
  const actual = jest.requireActual('@/lib/auth/resolve-user-contexts')
  return { ...actual, resolveUserContexts: (...args: unknown[]) => resolveUserContexts(...args) }
})

let storedContext: { context_type: string; restaurant_id: string | null } | null = null
let upserts: Record<string, unknown>[] = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'user_active_context') throw new Error(`unexpected table ${table}`)
      return {
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row)
          return { error: null }
        },
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: storedContext, error: null }) }),
        }),
      }
    },
  }),
}))

// --- the two sign-in entry points named in the issue, over the real resolver above ---

jest.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

let oauthUser: { id: string; email: string; user_metadata: Record<string, unknown> } | null = {
  id: 'u1',
  email: 'owner@example.com',
  user_metadata: {},
}

jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () => ({ data: { user: oauthUser }, error: null }),
    },
  }),
}))

jest.mock('@/lib/auth/ensure-public-user', () => ({
  ensurePublicUserForOAuth: async () => ({ ok: true }),
}))
jest.mock('@/lib/auth/sync-user-email', () => ({
  syncUserEmailAcrossTables: async () => ({ ok: true }),
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1' }),
}))

import { resolveLoginDestination } from '@/lib/auth/resolve-active-context'
import { GET as oauthCallback } from '@/app/auth/callback/route'
import { POST as resolveContextRoute } from '@/app/api/auth/resolve-active-context/route'

const PLATFORM = { type: 'platform', role: 'super_admin' } as const
const RESTAURANT = { type: 'restaurant', restaurantId: 'riviera-uuid', role: 'owner' } as const

beforeEach(() => {
  resolveUserContexts.mockReset()
  storedContext = null
  upserts = []
})

describe('an account that is both a platform admin and a restaurant owner (#66)', () => {
  beforeEach(() => {
    resolveUserContexts.mockResolvedValue([PLATFORM, RESTAURANT])
  })

  it('goes to /admin when it arrived via ?redirect=%2Fadmin, not to the owner dashboard', async () => {
    const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam: '/admin' })

    expect(resolved.kind).toBe('resolved')
    expect(resolved).toMatchObject({ destination: '/admin', context: { type: 'platform' } })
  })

  it('lands on the admin page that was actually asked for, not the console root', async () => {
    // middleware.ts sets ?redirect=<pathname> for any /admin/* bounce.
    const resolved = await resolveLoginDestination({
      userId: 'u1',
      redirectParam: '/admin/terminals?tab=offline',
    })

    expect(resolved).toMatchObject({ destination: '/admin/terminals?tab=offline' })
  })

  it('does the same for a restaurant-scoped deep link', async () => {
    const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam: '/stock/counts' })

    expect(resolved).toMatchObject({
      destination: '/stock/counts',
      context: { type: 'restaurant' },
    })
  })

  it('remembers the context the redirect resolved to', async () => {
    await resolveLoginDestination({ userId: 'u1', redirectParam: '/admin' })
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ user_id: 'u1', context_type: 'platform', restaurant_id: null })
  })

  it('asks which account to use when nothing says -- never a silent default', async () => {
    const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam: null })
    expect(resolved.kind).toBe('picker')
  })
})

describe('a redirect is only honoured for a context the account really has (#66)', () => {
  it('ignores ?redirect=/admin for an owner who is not a platform admin', async () => {
    resolveUserContexts.mockResolvedValue([RESTAURANT])
    const resolved = await resolveLoginDestination({ userId: 'u2', redirectParam: '/admin' })

    // Falls through to the single context it does have.
    expect(resolved).toMatchObject({ destination: '/dashboard', context: { type: 'restaurant' } })
  })

  it('ignores ?redirect=/dashboard for a platform admin with no restaurant', async () => {
    resolveUserContexts.mockResolvedValue([PLATFORM])
    const resolved = await resolveLoginDestination({ userId: 'u3', redirectParam: '/dashboard' })

    expect(resolved).toMatchObject({ destination: '/admin', context: { type: 'platform' } })
  })

  it('ignores a path that belongs to no context at all', async () => {
    resolveUserContexts.mockResolvedValue([PLATFORM, RESTAURANT])
    const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam: '/signup' })
    expect(resolved.kind).toBe('picker')
  })
})

/**
 * The open-redirect guard (#66).
 *
 * The previous version of this block proved nothing. Every one of its payloads was already
 * rejected by isUnderPrefix() before isSafeRedirectPath() was ever consulted -- '//evil.example'
 * and 'https://evil.example/admin' are not under '/admin' by prefix, and even
 * '/admin\nSet-Cookie: x=1' fails the segment-boundary check because the character after
 * '/admin' is a newline rather than '/', '?' or '#'. And its single assertion was an if/else
 * over resolved.kind in which BOTH arms were satisfiable, so a resolver that returned anything
 * at all passed. Measured: with isSafeRedirectPath replaced by `() => true`, all 13 tests in
 * this file still passed.
 *
 * So every payload below is of the form '/admin/...' or '/dashboard/...' -- past the prefix
 * check, honoured for a context the account genuinely has, with isSafeRedirectPath the only
 * thing standing between it and being returned as a destination. The benign-twin test pins
 * that property, so a later change to prefix matching cannot quietly make this block vacuous
 * again the way it was.
 */
describe('the open-redirect guard (#66)', () => {
  beforeEach(() => {
    resolveUserContexts.mockResolvedValue([PLATFORM, RESTAURANT])
  })

  /**
   * Each payload is written with escapes, never a raw control byte. The previous file embedded
   * literal NULs, which makes git treat the whole file as binary and skip it in review.
   */
  const guardIsTheOnlyDefence: Array<[string, string]> = [
    ['bare LF, response-splitting a Set-Cookie', '/admin/x\nSet-Cookie: a=b'],
    ['CRLF, splitting a header', '/admin/x\r\nX: 1'],
    ['tab', '/admin/x\ty'],
    ['space', '/admin/x y'],
    ['NUL, which truncates in some downstream parsers', '/admin/x\u0000y'],
    ['LF on the restaurant-scoped side too', '/dashboard/x\nSet-Cookie: a=b'],
    ['backslash, which browsers normalise to a slash', '/admin/\\evil.com'],
  ]

  it.each(guardIsTheOnlyDefence)(
    'refuses %s, and resolves nothing at all',
    async (_label, redirectParam) => {
      const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam })

      // Exact outcome, not "one of the acceptable shapes". The account has two contexts and
      // nothing stored, so a refused redirect must fall all the way through to rule 4.
      expect(resolved).toEqual({ kind: 'picker', contexts: [PLATFORM, RESTAURANT] })
      // A refused redirect must also not have quietly selected a context on the way past.
      expect(upserts).toEqual([])
    },
  )

  it('is the only thing rejecting them: the same paths without the hostile character resolve', async () => {
    // Without this, the block silently reverts to testing prefix matching -- which is exactly
    // how it became vacuous the first time.
    expect(await resolveLoginDestination({ userId: 'u1', redirectParam: '/admin/x' })).toEqual({
      kind: 'resolved',
      context: PLATFORM,
      destination: '/admin/x',
    })
    expect(await resolveLoginDestination({ userId: 'u1', redirectParam: '/dashboard/x' })).toEqual({
      kind: 'resolved',
      context: RESTAURANT,
      destination: '/dashboard/x',
    })
  })

  // POSITIVE CONTROL. A guard that refuses everything would satisfy every assertion above.
  // These say what must still work, exactly.
  it('still resolves a legitimate deep path, query and fragment intact', async () => {
    expect(
      await resolveLoginDestination({
        userId: 'u1',
        redirectParam: '/admin/terminals/T-123?tab=offline#last',
      }),
    ).toEqual({
      kind: 'resolved',
      context: PLATFORM,
      destination: '/admin/terminals/T-123?tab=offline#last',
    })

    expect(
      await resolveLoginDestination({ userId: 'u1', redirectParam: '/stock/counts/2026-08-09' }),
    ).toEqual({
      kind: 'resolved',
      context: RESTAURANT,
      destination: '/stock/counts/2026-08-09',
    })
  })

  // These never reach isSafeRedirectPath -- the prefix check turns them away first. Kept
  // because they are still outcomes worth pinning, but labelled so nobody reads them as
  // evidence about the guard.
  it.each([
    ['//evil.example'],
    ['https://evil.example/admin'],
    ['/\\evil.example'],
    ['/\\/evil.example'],
    ['javascript:alert(1)//admin'],
    ['/adminish/x'],
  ])('refuses %s at the prefix check, before the guard is consulted', async (redirectParam) => {
    const resolved = await resolveLoginDestination({ userId: 'u1', redirectParam })
    expect(resolved).toEqual({ kind: 'picker', contexts: [PLATFORM, RESTAURANT] })
  })
})

describe('the sign-in entry points honour the redirect (#66)', () => {
  beforeEach(() => {
    resolveUserContexts.mockResolvedValue([PLATFORM, RESTAURANT])
  })

  it('Google OAuth sends a dual-context admin to the admin page they were bounced from', async () => {
    const response = await oauthCallback(
      new Request('https://app.flashtap.test/auth/callback?code=abc&redirect=%2Fadmin%2Fterminals'),
    )

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://app.flashtap.test/admin/terminals')
  })

  it('Google OAuth asks which account to use when no redirect says', async () => {
    const response = await oauthCallback(
      new Request('https://app.flashtap.test/auth/callback?code=abc'),
    )
    expect(response.headers.get('location')).toBe('https://app.flashtap.test/choose-context')
  })

  it('the email/password path resolves the same destination from the redirect it was given', async () => {
    const response = await resolveContextRoute(
      new Request('https://app.flashtap.test/api/auth/resolve-active-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ redirect: '/admin' }),
      }),
    )

    expect(await response.json()).toEqual({ destination: '/admin' })
  })

  it('the email/password path refuses an off-site redirect and falls back to the picker', async () => {
    const response = await resolveContextRoute(
      new Request('https://app.flashtap.test/api/auth/resolve-active-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ redirect: 'https://evil.example/admin' }),
      }),
    )

    expect(await response.json()).toEqual({ destination: '/choose-context' })
  })
})
