/**
 * Issue #174 — the database must refuse a duplicate (restaurant_id, table_number).
 *
 * Before migration 20260806000000 the ONLY constraint on restaurant_tables was the primary key
 * on `id`. Uniqueness rested entirely on a read-then-write check in
 * app/api/admin/tables/route.ts with no lock, so two concurrent inserts of the same number both
 * passed and both landed. This exercises the real database, because an application-level check
 * cannot prove a database-level guarantee.
 *
 * Runs against STAGING (jest.setup-env.ts loads .env.test). Every row it creates is removed in
 * afterEach, including on failure, and every insert is tagged so a leaked row is identifiable.
 */
import { createStagingAdmin, STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures'
import { UNIQUE_VIOLATION } from '@/lib/tables/table-number-conflict'

const admin = createStagingAdmin()

// Far above the kiosk (9000+) and view-only (5000+) bands so a leaked row is obvious and
// cannot collide with fixtures used elsewhere.
const BASE = 71000
const TAG = 'unique-index-test'

const createdIds: string[] = []

async function insertTable(tableNumber: number, overrides: Record<string, unknown> = {}) {
  const res = await admin
    .from('restaurant_tables')
    .insert({
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      table_number: tableNumber,
      table_name: `${TAG}-${tableNumber}`,
      is_kiosk: false,
      is_view_only: false,
      active: true,
      ...overrides,
    })
    .select('id')
    .maybeSingle()

  if (res.data?.id) createdIds.push(String(res.data.id))
  return res
}

afterEach(async () => {
  if (createdIds.length === 0) return
  await admin.from('restaurant_tables').delete().in('id', createdIds)
  createdIds.length = 0
})

afterAll(async () => {
  // Belt and braces: sweep anything this file could have leaked, by tag.
  await admin
    .from('restaurant_tables')
    .delete()
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .like('table_name', `${TAG}-%`)
})

describe('#174 unique index on (restaurant_id, table_number)', () => {
  test('the index exists on the deployed database', async () => {
    // Proven behaviourally rather than by reading pg_indexes: what matters is that the database
    // REFUSES the duplicate, not that a catalog row exists.
    const first = await insertTable(BASE + 1)
    expect(first.error).toBeNull()

    const duplicate = await insertTable(BASE + 1)
    expect(duplicate.error).not.toBeNull()
    expect(duplicate.error?.code).toBe(UNIQUE_VIOLATION)
  })

  test('CONTROL: a different number on the same restaurant still inserts', async () => {
    // Without this the test above would pass even if the index were far too broad.
    const a = await insertTable(BASE + 2)
    const b = await insertTable(BASE + 3)
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
  })

  test('a DEACTIVATED table still blocks its number (#175 rule, enforced in the DB)', async () => {
    // The index is deliberately NOT scoped to active=true. Freeing the number would make the
    // deactivated row impossible to reactivate, and printed QR cards outlive deactivation.
    const inactive = await insertTable(BASE + 4, { active: false })
    expect(inactive.error).toBeNull()

    const reuse = await insertTable(BASE + 4)
    expect(reuse.error).not.toBeNull()
    expect(reuse.error?.code).toBe(UNIQUE_VIOLATION)
  })

  test('the constraint is per-restaurant, not global', async () => {
    const { data: other } = await admin
      .from('restaurants')
      .select('id')
      .neq('id', STAGING_TEST_RESTAURANT_ID)
      .limit(1)
      .maybeSingle()

    if (!other?.id) {
      console.warn('[#174] only one restaurant on staging — per-restaurant scope not exercised')
      return
    }

    const mine = await insertTable(BASE + 5)
    expect(mine.error).toBeNull()

    const theirs = await insertTable(BASE + 5, { restaurant_id: other.id })
    expect(theirs.error).toBeNull()
  })

  test('concurrent inserts of the same number: exactly one survives', async () => {
    // The race the application pre-check cannot close. Both calls read the same pre-insert
    // state; only the database can arbitrate.
    const results = await Promise.all([insertTable(BASE + 6), insertTable(BASE + 6)])
    const succeeded = results.filter((r) => !r.error)
    const failed = results.filter((r) => r.error)

    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].error?.code).toBe(UNIQUE_VIOLATION)
  })
})
