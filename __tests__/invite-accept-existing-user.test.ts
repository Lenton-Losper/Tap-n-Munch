/**
 * POST /api/auth/invite/accept — reproduces the real production failure first, then proves the
 * fix: an invite for an email that already has a `users` row (finance@taste-hospitalitygroup.com,
 * 2026-08-29 — a pre-existing account with zero restaurant memberships, invited fresh to Riviera)
 * hit `duplicate key value violates unique constraint "users_email_key"` on every attempt, because
 * the route unconditionally tried to mint a brand new auth user + users row for every accept.
 */
import { POST } from '@/app/api/auth/invite/accept/route'

type Row = Record<string, unknown>

function makeFakeSupabase(opts: {
  invite: Row | null
  existingUser: Row | null
  existingMembership: Row | null
}) {
  const inserted: Record<string, Row[]> = { users: [], restaurant_users: [] }
  const updated: Record<string, Row[]> = { staff_invites: [] }
  const createUserCalls: Row[] = []
  const deleteUserCalls: string[] = []

  function table(name: string) {
    let mode: 'select' | 'update' = 'select'
    let patch: Row | null = null
    const filters: Array<(r: Row) => boolean> = []

    const api = {
      select() {
        return api
      },
      update(p: Row) {
        mode = 'update'
        patch = p
        return api
      },
      insert(row: Row) {
        inserted[name] = inserted[name] ?? []
        inserted[name].push(row)
        return {async then(resolve: (v: {error: null}) => void) { resolve({error: null}) }, error: null}
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val)
        return api
      },
      async maybeSingle() {
        if (name === 'staff_invites' && mode === 'select') {
          return { data: opts.invite, error: null }
        }
        if (name === 'staff_invites' && mode === 'update') {
          updated.staff_invites.push({ ...(patch as Row) })
          return { data: null, error: null }
        }
        if (name === 'users') {
          return { data: opts.existingUser, error: null }
        }
        if (name === 'restaurant_users') {
          return { data: opts.existingMembership, error: null }
        }
        return { data: null, error: null }
      },
      // The real route awaits `.update(patch).eq(...)` bare -- no .maybeSingle() -- for the
      // staff_invites accepted-flag write. Without this, `await` on a plain non-thenable object
      // resolves to the object itself and `error` reads as undefined, silently skipping this
      // fake's own bookkeeping rather than throwing -- which is exactly what happened before this
      // was added: the update "succeeded" and nothing recorded it.
      async then(resolve: (v: {data: null; error: null}) => void) {
        if (name === 'staff_invites' && mode === 'update') {
          updated.staff_invites.push({ ...(patch as Row) })
        }
        resolve({ data: null, error: null })
      },
    }
    return api
  }

  const client = {
    from(name: string) {
      return table(name)
    },
    auth: {
      admin: {
        async createUser(row: Row) {
          createUserCalls.push(row)
          return { data: { user: { id: 'new-auth-user-1' } }, error: null }
        },
        async deleteUser(id: string) {
          deleteUserCalls.push(id)
          return { data: null, error: null }
        },
      },
    },
  }

  return { client, inserted, updated, createUserCalls, deleteUserCalls }
}

let fake: ReturnType<typeof makeFakeSupabase>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => fake.client,
}))

const VALID_INVITE = {
  id: 'invite-1',
  email: 'finance@taste-hospitalitygroup.com',
  role: 'manager',
  accepted: false,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  restaurant_id: '01bf27f1-a958-4322-bb3e-cc5240987808',
}

function request(body: Row) {
  return new Request('http://localhost/api/auth/invite/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('accepting an invite for an email that already has an account', () => {
  it('links the existing account instead of creating a new one -- no createUser call, membership inserted, invite marked accepted', async () => {
    fake = makeFakeSupabase({
      invite: VALID_INVITE,
      existingUser: { id: 'existing-user-1' },
      existingMembership: null,
    })

    const res = await POST(
      request({ token: 'tok', fullName: 'Mcdonald', password: 'Cricket12345' }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, linked_existing: true })

    // The whole point: never tries to mint a duplicate account.
    expect(fake.createUserCalls).toHaveLength(0)
    expect(fake.inserted.users).toHaveLength(0)

    expect(fake.inserted.restaurant_users).toEqual([
      { restaurant_id: VALID_INVITE.restaurant_id, user_id: 'existing-user-1', role: 'manager' },
    ])
    expect(fake.updated.staff_invites).toHaveLength(1)
    expect(fake.updated.staff_invites[0]).toMatchObject({ accepted: true })
  })

  it('a re-sent invite for someone already a member of THIS restaurant is idempotent, not a duplicate-key error', async () => {
    fake = makeFakeSupabase({
      invite: VALID_INVITE,
      existingUser: { id: 'existing-user-1' },
      existingMembership: { id: 'membership-1' },
    })

    const res = await POST(
      request({ token: 'tok', fullName: 'Mcdonald', password: 'Cricket12345' }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, linked_existing: true })
    // Already a member -- nothing new to insert, but still succeeds and marks the invite done.
    expect(fake.inserted.restaurant_users).toHaveLength(0)
    expect(fake.updated.staff_invites).toHaveLength(1)
  })

  it('an email with no existing account still goes through the original create-account path', async () => {
    fake = makeFakeSupabase({
      invite: { ...VALID_INVITE, email: 'brand-new-person@example.com' },
      existingUser: null,
      existingMembership: null,
    })

    const res = await POST(
      request({ token: 'tok', fullName: 'Brand New', password: 'Cricket12345' }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, linked_existing: false })
    expect(fake.createUserCalls).toHaveLength(1)
    expect(fake.inserted.users).toHaveLength(1)
    expect(fake.inserted.restaurant_users).toEqual([
      { restaurant_id: VALID_INVITE.restaurant_id, user_id: 'new-auth-user-1', role: 'manager' },
    ])
  })
})
