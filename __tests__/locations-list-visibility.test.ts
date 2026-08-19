/**
 * THE LOCATIONS LIST MUST WIDEN FOR AN ORG OWNER AND NOT FOR ANYONE ELSE.
 *
 * Found on production 2026-08-19, the day the first organisation ever held two restaurants:
 * Settings > Business > Locations showed one of them. `restaurants` RLS is
 * `id IN (user_restaurant_ids()) OR owner_id = auth.uid()` -- organization_id is not in it, so a
 * session-scoped read of an organisation's locations returns only the ones the caller personally
 * belongs to. The same query with RLS bypassed returned both.
 *
 * THE POSITIVE CONTROL IS THE WHOLE TEST. A suite that only asserts MORE rows appear cannot tell
 * "correctly widened" from "authorisation removed" -- both look like success. So the control here
 * is not a row count at all:
 *
 *     FOR A NON-OWNER, THE SERVICE-ROLE CLIENT MUST NEVER BE CONSTRUCTED.
 *
 * A row count could be satisfied by bypassing RLS and then filtering in JavaScript, which would
 * pass while having removed the database's guarantee. Asserting the factory was not called pins the
 * mechanism, not the symptom.
 *
 * Fake clients rather than a live database: the thing under test is WHICH client is chosen, and a
 * real connection would prove the fake's behaviour instead.
 */
export {} // module scope

import { resolveVisibleLocations } from '@/lib/organizations/queries'

const ORG = '5608ba8f-54a7-445b-aca5-80593663670c'

/** Stands in for a Supabase client; records the table and filter it was asked for. */
function fakeClient(rows: Array<{ id: string; name: string }>) {
  const calls: string[] = []
  const client = {
    calls,
    from(table: string) {
      calls.push(table)
      const builder = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        order: () => Promise.resolve({ data: rows.map((r) => ({ ...r, location_type: 'RETAIL', address: null })), error: null }),
      }
      return builder
    },
  }
  return client as unknown as Parameters<typeof resolveVisibleLocations>[0]['sessionClient'] & { calls: string[] }
}

const BOTH = [
  { id: 'b161c758-582d-4dfa-839a-9fa35c492a49', name: 'FNB ChowNow' },
  { id: '01bf27f1-a958-4322-bb3e-cc5240987808', name: 'Riviera' },
]
/** What RLS actually leaves for a user who belongs to Riviera only. */
const RIVIERA_ONLY = [{ id: '01bf27f1-a958-4322-bb3e-cc5240987808', name: 'Riviera' }]

describe('an organisation OWNER — flashtapapp2@gmail.com', () => {
  it('sees every location in the organisation', async () => {
    const session = fakeClient(RIVIERA_ONLY)
    const admin = fakeClient(BOTH)
    const locations = await resolveVisibleLocations({
      organizationId: ORG,
      sessionClient: session,
      createAdminClient: () => admin,
      canViewAllLocations: true,
    })
    expect(locations.map((l) => l.name)).toEqual(['FNB ChowNow', 'Riviera'])
  })

  it('gets there through the elevated client, because the session one cannot answer', async () => {
    const session = fakeClient(RIVIERA_ONLY)
    const admin = fakeClient(BOTH)
    await resolveVisibleLocations({
      organizationId: ORG,
      sessionClient: session,
      createAdminClient: () => admin,
      canViewAllLocations: true,
    })
    expect(admin.calls).toEqual(['restaurants'])
    expect(session.calls).toEqual([])
  })
})

describe('POSITIVE CONTROL — a member who is NOT an organisation owner', () => {
  /**
   * llosperofficial@gmail.com on production: a restaurant_users row on Riviera, NO row on FNB
   * ChowNow, and no organization_users row at all. This user must be unaffected by the fix.
   */
  it('still sees exactly one location', async () => {
    const session = fakeClient(RIVIERA_ONLY)
    const admin = fakeClient(BOTH)
    const locations = await resolveVisibleLocations({
      organizationId: ORG,
      sessionClient: session,
      createAdminClient: () => admin,
      canViewAllLocations: false,
    })
    expect(locations.map((l) => l.name)).toEqual(['Riviera'])
  })

  it('NEVER causes a service-role client to be constructed', async () => {
    // The load-bearing assertion. Remove the gate in resolveVisibleLocations and this fails while
    // a row-count check would still pass, because the fake admin client happens to return the
    // right rows -- which is exactly how "authorisation removed" disguises itself as "widened".
    const session = fakeClient(RIVIERA_ONLY)
    let adminConstructed = 0
    await resolveVisibleLocations({
      organizationId: ORG,
      sessionClient: session,
      createAdminClient: () => {
        adminConstructed += 1
        return fakeClient(BOTH)
      },
      canViewAllLocations: false,
    })
    expect(adminConstructed).toBe(0)
    expect(session.calls).toEqual(['restaurants'])
  })

  it('is not rescued by the organisation having more locations', async () => {
    // Same user, an organisation that grows a third site. Still one.
    const session = fakeClient(RIVIERA_ONLY)
    const locations = await resolveVisibleLocations({
      organizationId: ORG,
      sessionClient: session,
      createAdminClient: () => fakeClient([...BOTH, { id: 'new', name: 'ChowNow Nedbank' }]),
      canViewAllLocations: false,
    })
    expect(locations).toHaveLength(1)
  })
})
