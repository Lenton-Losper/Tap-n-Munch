/**
 * A STALE SELECTION MUST NEVER FAIL OPEN, AND MUST NEVER STRAND ANYONE.
 *
 * pick-session-restaurant.test.ts covers the pure choice. This covers the WIRING around it, which
 * is where the failure modes that matter live: what the resolver does when the stored row names a
 * restaurant the user has lost access to, when the stored row cannot be read at all, and when the
 * user has no memberships but a legacy restaurants.owner_id.
 *
 * The three ways access goes away, and where each is handled:
 *   restaurant deleted   -- FK ON DELETE CASCADE removes the context row (database, not here)
 *   membership revoked   -- the row survives; discarded here because it is not in memberships
 *   soft-deleted (deleted_at) -- filtered out of the membership query, so it stops matching
 */
export {} // module scope

import { resolveSessionRestaurantId } from '@/lib/auth/resolve-session-restaurant'

const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const NEDBANK = '38c493cf-a665-42c5-9c3e-858fbdb52b40'
const GONE = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const USER = 'f9bf5348-1c1c-4574-8830-13b249722097'

type Stub = {
  memberships?: { restaurant_id: string; role: string }[]
  membershipError?: { message: string }
  stored?: { context_type: string; restaurant_id: string | null } | null
  storedError?: { message: string }
  ownedRestaurantId?: string | null
  ownerError?: { message: string }
}

/** Records the filters applied, so a test can assert the soft-delete filter is really there. */
const applied: { table: string; filters: string[] }[] = []

function makeClient(stub: Stub) {
  return {
    from(table: string) {
      const record = { table, filters: [] as string[] }
      applied.push(record)

      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = (col: string) => {
        record.filters.push(`eq:${col}`)
        return builder
      }
      builder.is = (col: string, val: unknown) => {
        record.filters.push(`is:${col}:${String(val)}`)
        if (table === 'restaurant_users') {
          return Promise.resolve({
            data: stub.memberships ?? [],
            error: stub.membershipError ?? null,
          })
        }
        return builder
      }
      builder.limit = chain
      builder.maybeSingle = () => {
        if (table === 'user_active_context') {
          return Promise.resolve({ data: stub.stored ?? null, error: stub.storedError ?? null })
        }
        return Promise.resolve({
          data: stub.ownedRestaurantId ? { id: stub.ownedRestaurantId } : null,
          error: stub.ownerError ?? null,
        })
      }
      return builder
    },
  } as never
}

beforeEach(() => {
  applied.length = 0
})

describe('honouring a valid selection', () => {
  it('returns the stored restaurant when the user still belongs to it', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [
          { restaurant_id: RIVIERA, role: 'owner' },
          { restaurant_id: NEDBANK, role: 'owner' },
        ],
        stored: { context_type: 'restaurant', restaurant_id: NEDBANK },
      }),
      USER,
    )
    expect(id).toBe(NEDBANK)
  })

  it('reads memberships with the soft-delete filter applied', async () => {
    await resolveSessionRestaurantId(
      makeClient({
        memberships: [{ restaurant_id: RIVIERA, role: 'owner' }],
        stored: null,
      }),
      USER,
    )
    const membershipRead = applied.find((a) => a.table === 'restaurant_users')
    // Without this filter a revoked-by-soft-delete membership would still count as access.
    expect(membershipRead?.filters).toContain('is:deleted_at:null')
  })
})

describe('NEVER FAILS OPEN -- a selection cannot grant access', () => {
  it('discards a stored restaurant the user no longer belongs to', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [{ restaurant_id: RIVIERA, role: 'owner' }],
        stored: { context_type: 'restaurant', restaurant_id: GONE },
      }),
      USER,
    )
    expect(id).not.toBe(GONE)
  })

  it('falls back to a restaurant the user DOES have, not to nothing', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [
          { restaurant_id: NEDBANK, role: 'manager' },
          { restaurant_id: RIVIERA, role: 'owner' },
        ],
        stored: { context_type: 'restaurant', restaurant_id: GONE },
      }),
      USER,
    )
    // Owner rows first, so the fallback is deterministic rather than query-order.
    expect(id).toBe(RIVIERA)
  })

  it('ignores a platform-typed stored context', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [{ restaurant_id: RIVIERA, role: 'owner' }],
        stored: { context_type: 'platform', restaurant_id: null },
      }),
      USER,
    )
    expect(id).toBe(RIVIERA)
  })
})

describe('NEVER STRANDS -- a broken preference cannot lock anyone out', () => {
  it('falls back rather than throwing when the stored row cannot be read', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [{ restaurant_id: RIVIERA, role: 'owner' }],
        storedError: { message: 'permission denied for table user_active_context' },
      }),
      USER,
    )
    expect(id).toBe(RIVIERA)
  })

  it('falls back to the legacy owner_id column when there are no memberships at all', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({ memberships: [], stored: null, ownedRestaurantId: RIVIERA }),
      USER,
    )
    expect(id).toBe(RIVIERA)
  })

  it('returns null -- not a wrong restaurant -- when the user has no access anywhere', async () => {
    const id = await resolveSessionRestaurantId(
      makeClient({ memberships: [], stored: null, ownedRestaurantId: null }),
      USER,
    )
    expect(id).toBeNull()
  })

  it('does not hand back the stored restaurant when memberships are empty', async () => {
    // The strongest form of "cannot fail open": no memberships, but a stored row still present
    // because the membership was revoked without the restaurant being deleted.
    const id = await resolveSessionRestaurantId(
      makeClient({
        memberships: [],
        stored: { context_type: 'restaurant', restaurant_id: GONE },
        ownedRestaurantId: null,
      }),
      USER,
    )
    expect(id).toBeNull()
  })
})
