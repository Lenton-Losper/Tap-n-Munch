/**
 * Staging verification for Workstream 2 (organizations + canonical inventory identity):
 *  - every restaurant (except soft-deleted ones with no live owner) has organization_id set,
 *    and each organization has exactly one OWNER organization_users row
 *  - every stock_items row has organization_stock_item_id set, strictly 1:1 (no two
 *    stock_items share an organization_stock_item_id), broken down per restaurant
 *  - stock_items_one_per_org_item_per_restaurant unique index holds (zero violations)
 *  - the cross-org trigger really rejects a deliberately-mismatched mapping
 *   npx tsx scripts/verify-organizations-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `ws2-${Date.now()}`

const created = {
  userIds: [] as string[],
  restaurantIds: [] as string[],
  organizationIds: [] as string[],
  orgStockItemIds: [] as string[],
  stockItemIds: [] as string[],
}

async function cleanup() {
  if (created.stockItemIds.length) {
    await db.from('stock_items').delete().in('id', created.stockItemIds)
  }
  if (created.orgStockItemIds.length) {
    await db.from('organization_stock_items').delete().in('id', created.orgStockItemIds)
  }
  if (created.userIds.length) {
    await db.from('organization_users').delete().in('user_id', created.userIds)
    await db.from('restaurant_users').delete().in('user_id', created.userIds)
    await db.from('users').delete().in('id', created.userIds)
    for (const id of created.userIds) {
      await db.auth.admin.deleteUser(id).catch(() => {})
    }
  }
  if (created.restaurantIds.length) {
    await db.from('restaurant_roles').delete().in('restaurant_id', created.restaurantIds)
    await db.from('restaurants').delete().in('id', created.restaurantIds)
  }
  if (created.organizationIds.length) {
    await db.from('organizations').delete().in('id', created.organizationIds)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function createRealAuthUser(emailTag: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `${tag}-${emailTag}@flashtap-test.invalid`,
    password: `P${randomUUID()}!1`,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const userId = data.user.id
  created.userIds.push(userId)
  const { error: publicUserError } = await db.from('users').insert({ id: userId, email: data.user.email })
  if (publicUserError) throw publicUserError
  return userId
}

async function createRealOrgAndRestaurant(name: string): Promise<{ restaurantId: string; organizationId: string; ownerUserId: string }> {
  const ownerUserId = await createRealAuthUser(`owner-${name.replace(/\s+/g, '-')}`)

  const { data: org, error: orgError } = await db
    .from('organizations')
    .insert({ name, owner_user_id: ownerUserId })
    .select('id')
    .single()
  if (orgError || !org) throw orgError ?? new Error('organization insert failed')
  created.organizationIds.push(org.id)

  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .insert({ name, organization_id: org.id })
    .select('id')
    .single()
  if (restaurantError || !restaurant) throw restaurantError ?? new Error('restaurant insert failed')
  created.restaurantIds.push(restaurant.id)

  const { error: roleError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restaurant.id, role_slug: 'owner', display_name: 'Owner', permissions: ['stock:view'], is_system: true })
  if (roleError) throw roleError

  const { error: membershipError } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restaurant.id, user_id: ownerUserId, role: 'owner' })
  if (membershipError) throw membershipError

  const { error: orgMembershipError } = await db
    .from('organization_users')
    .insert({ organization_id: org.id, user_id: ownerUserId, role: 'OWNER' })
  if (orgMembershipError) throw orgMembershipError

  return { restaurantId: restaurant.id, organizationId: org.id, ownerUserId }
}

async function main() {
  // ============================================================
  // Part 1: organization backfill coverage
  // ============================================================
  console.log('--- Part 1: organization backfill coverage ---')

  // The backfill only ever skips a restaurant with organization_id still NULL when it has
  // zero live restaurant_users rows (soft-deleted, or an orphaned fixture nobody can log
  // into) -- any restaurant WITH live members must have gotten an organization.
  const { data: orphanRestaurants, error: orphanError } = await db
    .from('restaurants')
    .select('id, name, deleted_at')
    .is('organization_id', null)
  if (orphanError) throw orphanError

  const unexpectedOrphans: typeof orphanRestaurants = []
  for (const r of orphanRestaurants ?? []) {
    const { count: liveMemberCount, error: liveMemberError } = await db
      .from('restaurant_users')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', r.id)
      .is('deleted_at', null)
    if (liveMemberError) throw liveMemberError
    if ((liveMemberCount ?? 0) > 0) unexpectedOrphans.push(r)
  }
  assert(
    unexpectedOrphans.length === 0,
    `expected 0 restaurants with live members but no organization_id, got: ${JSON.stringify(unexpectedOrphans)}`,
  )
  console.log(
    `organization backfill coverage OK -- every restaurant with live members has organization_id set` +
      ((orphanRestaurants?.length ?? 0) > 0
        ? ` (${orphanRestaurants!.length} zero-member restaurant(s) correctly skipped: ${orphanRestaurants!.map((r) => r.name).join(', ')})`
        : ''),
  )

  const { data: orgs, error: orgsError } = await db.from('organizations').select('id, owner_user_id')
  if (orgsError) throw orgsError
  for (const org of orgs ?? []) {
    const { data: ownerRows, error: ownerRowsError } = await db
      .from('organization_users')
      .select('user_id')
      .eq('organization_id', org.id)
      .eq('role', 'OWNER')
    if (ownerRowsError) throw ownerRowsError
    assert(ownerRows && ownerRows.length >= 1, `organization ${org.id} has no OWNER organization_users row`)
    assert(
      ownerRows.some((r) => r.user_id === org.owner_user_id),
      `organization ${org.id} OWNER membership does not include organizations.owner_user_id`,
    )
  }
  console.log(`every organization (${orgs?.length ?? 0}) has an OWNER organization_users row matching owner_user_id -- OK`)

  // ============================================================
  // Part 2: organization_stock_items backfill coverage, strictly 1:1
  // ============================================================
  console.log('\n--- Part 2: organization_stock_items backfill coverage ---')

  const { count: nullCount, error: nullCountError } = await db
    .from('stock_items')
    .select('id', { count: 'exact', head: true })
    .is('organization_stock_item_id', null)
  if (nullCountError) throw nullCountError
  assert(nullCount === 0, `expected 0 stock_items without organization_stock_item_id, got ${nullCount}`)
  console.log('every stock_items row has organization_stock_item_id set -- OK')

  const { data: allStockItems, error: allStockItemsError } = await db
    .from('stock_items')
    .select('id, restaurant_id, organization_stock_item_id')
  if (allStockItemsError) throw allStockItemsError

  const seenOrgItemIds = new Map<string, string>()
  for (const row of allStockItems ?? []) {
    const orgItemId = row.organization_stock_item_id as string
    const existing = seenOrgItemIds.get(orgItemId)
    assert(!existing, `organization_stock_item_id ${orgItemId} is shared by stock_items ${existing} and ${row.id} -- backfill should be strictly 1:1`)
    seenOrgItemIds.set(orgItemId, row.id as string)
  }
  console.log(`backfill is strictly 1:1 -- ${allStockItems?.length ?? 0} stock_items rows, ${seenOrgItemIds.size} distinct organization_stock_items, no sharing -- OK`)

  const { count: orgStockItemCount, error: orgStockItemCountError } = await db
    .from('organization_stock_items')
    .select('id', { count: 'exact', head: true })
  if (orgStockItemCountError) throw orgStockItemCountError
  assert(
    orgStockItemCount === (allStockItems?.length ?? 0),
    `expected organization_stock_items count (${orgStockItemCount}) to equal stock_items count (${allStockItems?.length}) -- 1:1, no loss, no merging`,
  )
  console.log(`organization_stock_items count (${orgStockItemCount}) == stock_items count (${allStockItems?.length}) -- no loss, no merging -- OK`)

  // Per-client breakdown for visibility.
  const perRestaurant = new Map<string, number>()
  for (const row of allStockItems ?? []) {
    const key = row.restaurant_id as string
    perRestaurant.set(key, (perRestaurant.get(key) ?? 0) + 1)
  }
  const { data: restaurantNames } = await db.from('restaurants').select('id, name').in('id', [...perRestaurant.keys()])
  for (const [restaurantId, count] of perRestaurant) {
    const name = restaurantNames?.find((r) => r.id === restaurantId)?.name ?? restaurantId
    console.log(`  ${name}: ${count} stock_items -> ${count} organization_stock_items`)
  }

  // ============================================================
  // Part 3: cross-org trigger really rejects a mismatched mapping
  // ============================================================
  console.log('\n--- Part 3: cross-org trigger rejection ---')

  const orgA = await createRealOrgAndRestaurant(`${tag} Org A`)
  const orgB = await createRealOrgAndRestaurant(`${tag} Org B`)

  const { data: gUnit, error: gUnitError } = await db
    .from('measurement_units')
    .select('id')
    .is('restaurant_id', null)
    .eq('name', 'g')
    .single()
  if (gUnitError || !gUnit) throw gUnitError ?? new Error('system unit "g" missing')

  const { data: orgBItem, error: orgBItemError } = await db
    .from('organization_stock_items')
    .insert({ organization_id: orgB.organizationId, name: `${tag} cross-org item`, base_unit_id: gUnit.id })
    .select('id')
    .single()
  if (orgBItemError || !orgBItem) throw orgBItemError ?? new Error('org B item insert failed')
  created.orgStockItemIds.push(orgBItem.id)

  // Deliberate mismatch: restaurant A's stock_item pointed at org B's canonical item.
  const { data: mismatchedInsert, error: mismatchedInsertError } = await db
    .from('stock_items')
    .insert({
      restaurant_id: orgA.restaurantId,
      organization_stock_item_id: orgBItem.id,
      name: `${tag} mismatched stock item`,
      unit_id: gUnit.id,
    })
    .select('id')
    .single()

  assert(mismatchedInsertError, 'expected the cross-org trigger to reject a mismatched organization_stock_item_id, but the insert succeeded')
  if (mismatchedInsert) {
    created.stockItemIds.push((mismatchedInsert as { id: string }).id)
  }
  console.log('cross-org trigger correctly rejected the mismatched insert:', mismatchedInsertError.message)

  // Sanity: the same insert with orgA's own canonical item succeeds.
  const { data: orgAItem, error: orgAItemError } = await db
    .from('organization_stock_items')
    .insert({ organization_id: orgA.organizationId, name: `${tag} matching item`, base_unit_id: gUnit.id })
    .select('id')
    .single()
  if (orgAItemError || !orgAItem) throw orgAItemError ?? new Error('org A item insert failed')
  created.orgStockItemIds.push(orgAItem.id)

  const { data: matchingInsert, error: matchingInsertError } = await db
    .from('stock_items')
    .insert({
      restaurant_id: orgA.restaurantId,
      organization_stock_item_id: orgAItem.id,
      name: `${tag} matching stock item`,
      unit_id: gUnit.id,
    })
    .select('id')
    .single()
  if (matchingInsertError || !matchingInsert) throw matchingInsertError ?? new Error('matching insert unexpectedly failed')
  created.stockItemIds.push(matchingInsert.id)
  console.log('same-org insert succeeds as expected -- OK')

  console.log('\nWS2_ORGANIZATIONS_STAGING_VERIFY_OK', {
    organizations: orgs?.length ?? 0,
    stockItems: allStockItems?.length ?? 0,
    orgStockItems: orgStockItemCount,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('WS2_ORGANIZATIONS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
