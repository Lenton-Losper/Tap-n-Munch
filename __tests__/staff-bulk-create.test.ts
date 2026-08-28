/**
 * POST /api/admin/staff/bulk-create -- a waiter with no work email, created directly.
 *
 * Riviera has a floor of waiters and no email for any of them; the only path to add staff before
 * tonight was POST /api/admin/invites, which hard-requires one. This route writes public.users
 * (email: null), restaurant_users and staff_members, then sets the terminal PIN, per entry.
 */
import { POST } from '@/app/api/admin/staff/bulk-create/route'

type Row = Record<string, unknown>

const RESTAURANT = 'rest-riviera'
const ACTOR = 'user-manager'

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: ACTOR }),
  getRestaurantIdForUser: async () => RESTAURANT,
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

jest.mock('@/lib/restaurant-roles/server-roles', () => ({
  resolveStaffAssignableRoleSlug: async (_db: unknown, _rid: string, role: string) =>
    role === 'waiter' || role === 'bar' ? role : null,
}))

/** Table-switching stub. Each table's insert behaviour is configurable per test. */
function makeSupabase(opts: {
  usersEmailNotNull?: boolean
  usersIdNotNull?: boolean
  restaurantUsersFails?: boolean
  staffMembersFails?: boolean
  pinFails?: boolean
} = {}) {
  const inserted: Record<string, Row[]> = {
    users: [],
    restaurant_users: [],
    staff_members: [],
    terminal_authorization_credentials: [],
    authorization_events: [],
  }
  let nextUserId = 0

  const client = {
    from(table: string) {
      return {
        insert(row: Row) {
          const chain = {
            select() {
              return chain
            },
            single: async () => {
              if (table === 'users') {
                if (opts.usersEmailNotNull) {
                  return {
                    data: null,
                    error: { message: 'null value in column "email" violates not-null constraint' },
                  }
                }
                if (opts.usersIdNotNull && row.id == null) {
                  return {
                    data: null,
                    error: { message: 'null value in column "id" of relation "users" violates not-null constraint' },
                  }
                }
                // users.id has NO column default (confirmed against staging) -- a real insert
                // succeeds only because the route supplies one. Honouring row.id here, rather than
                // always synthesising one the way this mock used to, is what lets a test tell "the
                // route generated an id" from "the mock papered over a missing one".
                const id = typeof row.id === 'string' ? row.id : `user-${++nextUserId}`
                inserted.users.push({ ...row, id })
                return { data: { id }, error: null }
              }
              return { data: null, error: { message: `unexpected .single() on ${table}` } }
            },
            then(resolve: (v: { error: Row | null }) => unknown) {
              if (table === 'restaurant_users') {
                if (opts.restaurantUsersFails) {
                  return Promise.resolve(resolve({ error: { message: 'restaurant_users boom' } }))
                }
                inserted.restaurant_users.push(row)
                return Promise.resolve(resolve({ error: null }))
              }
              if (table === 'staff_members') {
                if (opts.staffMembersFails) {
                  return Promise.resolve(resolve({ error: { message: 'staff_members boom' } }))
                }
                inserted.staff_members.push(row)
                return Promise.resolve(resolve({ error: null }))
              }
              if (table === 'terminal_authorization_credentials') {
                if (opts.pinFails) {
                  return Promise.resolve(resolve({ error: { message: 'pin boom' } }))
                }
                inserted.terminal_authorization_credentials.push(row)
                return Promise.resolve(resolve({ error: null }))
              }
              if (table === 'authorization_events') {
                inserted.authorization_events.push(row)
                return Promise.resolve(resolve({ error: null }))
              }
              return Promise.resolve(resolve({ error: { message: `unexpected table ${table}` } }))
            },
          }
          return chain
        },
      }
    },
  }

  return { client: client as never, inserted }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => currentClient,
}))

let currentClient: unknown

function call(staff: Array<{ name: string; role: string; pin: string }>) {
  return POST(
    new Request('https://example.test/api/admin/staff/bulk-create', {
      method: 'POST',
      body: JSON.stringify({ staff }),
    }),
  )
}

describe('POST /api/admin/staff/bulk-create', () => {
  it('creates a waiter with no email: users, restaurant_users, staff_members and a PIN all written', async () => {
    const { client, inserted } = makeSupabase()
    currentClient = client

    const res = await call([{ name: 'Maria', role: 'waiter', pin: '1234' }])
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.created_count).toBe(1)
    expect(body.failed_count).toBe(0)
    expect(inserted.users[0]).toMatchObject({ name: 'Maria', email: null })
    // THE REAL BUG, PINNED. users.id has no column default (confirmed against staging
    // 2026-08-28) -- this route must supply one itself or the insert fails on "null value in
    // column id" before it ever reaches the email check. A UUID, not the auth id this person does
    // not have.
    expect(inserted.users[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(inserted.restaurant_users[0]).toMatchObject({
      restaurant_id: RESTAURANT,
      role: 'waiter',
      invite_accepted: true,
    })
    expect(inserted.staff_members[0]).toMatchObject({ name: 'Maria', email: null, role: 'waiter' })
    expect(inserted.terminal_authorization_credentials).toHaveLength(1)
  })

  it('creates several people in one call, each independently', async () => {
    const { client, inserted } = makeSupabase()
    currentClient = client

    const res = await call([
      { name: 'Maria', role: 'waiter', pin: '1111' },
      { name: 'Sipho', role: 'bar', pin: '2222' },
    ])
    const body = await res.json()

    expect(body.created_count).toBe(2)
    expect(inserted.users).toHaveLength(2)
  })

  it('one bad PIN does not block the others in the same batch', async () => {
    const { client } = makeSupabase()
    currentClient = client

    const res = await call([
      { name: 'Maria', role: 'waiter', pin: '1234' },
      { name: 'BadPin', role: 'waiter', pin: '12' },
      { name: 'Sipho', role: 'waiter', pin: '5678' },
    ])
    const body = await res.json()

    expect(body.created_count).toBe(2)
    expect(body.failed_count).toBe(1)
    const failed = body.results.find((r: { name: string }) => r.name === 'BadPin')
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/4 digits/)
  })

  it('an invalid role fails that entry, names the bad role, does not create the user', async () => {
    const { client, inserted } = makeSupabase()
    currentClient = client

    const res = await call([{ name: 'Ghost', role: 'astronaut', pin: '1234' }])
    const body = await res.json()

    expect(body.failed_count).toBe(1)
    expect(body.results[0].error).toMatch(/astronaut/)
    expect(inserted.users).toHaveLength(0)
  })

  it('never invents a placeholder email -- users.email is always null', async () => {
    const { client, inserted } = makeSupabase()
    currentClient = client

    await call([{ name: 'Maria', role: 'waiter', pin: '1234' }])

    expect(inserted.users[0].email).toBeNull()
  })

  it('a NOT NULL email constraint (migration not yet applied) reports a clear, specific reason', async () => {
    const { client } = makeSupabase({ usersEmailNotNull: true })
    currentClient = client

    const res = await call([{ name: 'Maria', role: 'waiter', pin: '1234' }])
    const body = await res.json()

    expect(body.failed_count).toBe(1)
    expect(body.results[0].error).toMatch(/schema change/i)
  })

  /**
   * PROVES THE MOCK ITSELF WOULD CATCH THE REGRESSION -- were usersIdNotNull ever real (a
   * migration reverted the column default some other way), a route that omitted id would be
   * reported per-entry, not silently. Not exercised by the route's own current call (it always
   * supplies id, so this branch never fires against real code); this pins the FIXTURE's own
   * honesty about the failure shape, the same way this repo's other mocks are pinned.
   */
  it('the fixture reports a missing id per-entry, not silently, if a caller ever omits it', async () => {
    const { client } = makeSupabase({ usersIdNotNull: true })
    currentClient = client

    const res = await client.from('users').insert({ name: 'No id' }).single()

    expect(res.error?.message).toMatch(/column "id"/)
  })

  it('a failed PIN write after the person is created reports the failure, not a silent orphan', async () => {
    const { client } = makeSupabase({ pinFails: true })
    currentClient = client

    const res = await call([{ name: 'Maria', role: 'waiter', pin: '1234' }])
    const body = await res.json()

    expect(body.results[0].ok).toBe(false)
    expect(body.results[0].user_id).toBeTruthy()
    expect(body.results[0].error).toMatch(/PIN could not be set/)
  })

  it('rejects an empty batch', async () => {
    const { client } = makeSupabase()
    currentClient = client

    const res = await call([])
    expect(res.status).toBe(400)
  })
})
