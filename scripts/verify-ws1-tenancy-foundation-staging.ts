/**
 * Staging verification for Workstream 1 (tenancy foundation):
 *  - users.restaurant_id is actually gone, and bug_reports RLS still works via
 *    user_restaurant_ids() (real insert/select as an authenticated multi-membership user).
 *  - getRestaurantIdForUser / getRestaurantIdsForUser behave correctly for 0, 1, and 2+
 *    restaurant memberships, using real restaurant_users rows (not synthetic assertions).
 *  - requireCallerRestaurantId authorizes correctly against a user's full restaurant set.
 *   npx tsx scripts/verify-ws1-tenancy-foundation-staging.ts
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

process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `ws1-${Date.now()}`

const created = {
  userIds: [] as string[],
  restaurantIds: [] as string[],
  bugReportIds: [] as string[],
}

async function cleanup() {
  if (created.bugReportIds.length) {
    await db.from('bug_reports').delete().in('id', created.bugReportIds)
  }
  if (created.userIds.length) {
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

async function createRealRestaurantWithOwnerRole(name: string): Promise<string> {
  const { data: restaurant, error } = await db
    .from('restaurants')
    .insert({ name })
    .select('id')
    .single()
  if (error || !restaurant) throw error ?? new Error('restaurant insert failed')
  created.restaurantIds.push(restaurant.id)

  const { error: roleError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restaurant.id, role_slug: 'owner', display_name: 'Owner', permissions: ['stock:view'], is_system: true })
  if (roleError) throw roleError

  return restaurant.id
}

async function main() {
  // ============================================================
  // Part 1: users.restaurant_id is actually gone; bug_reports RLS repointed correctly
  // ============================================================
  console.log('--- Part 1: schema + RLS ---')

  const columnCheck = await db.from('users').select('restaurant_id').limit(1)
  assert(
    columnCheck.error && /column .*restaurant_id.* does not exist/i.test(columnCheck.error.message),
    `users.restaurant_id should no longer exist, got: ${JSON.stringify(columnCheck.error)}`,
  )
  console.log('users.restaurant_id column confirmed dropped:', columnCheck.error!.message)

  const restaurantIdSingle = await createRealRestaurantWithOwnerRole(`${tag} Bug Report Test`)
  const bugReportUserId = await createRealAuthUser('bugreporter')
  const { error: membershipError } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restaurantIdSingle, user_id: bugReportUserId, role: 'owner' })
  if (membershipError) throw membershipError

  // Real anon-key + password sign-in, then a real RLS-scoped insert/select as that user --
  // not a service-role bypass -- to prove the repointed policy actually authorizes.
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!
  const userClient = createClient(stagingUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const password = `P${randomUUID()}!1`
  await db.auth.admin.updateUserById(bugReportUserId, { password })
  const { data: session, error: passwordSignInError } = await userClient.auth.signInWithPassword({
    email: `${tag}-bugreporter@flashtap-test.invalid`,
    password,
  })
  if (passwordSignInError || !session.session) throw passwordSignInError ?? new Error('sign-in failed')

  const { data: insertedBugReport, error: bugReportInsertError } = await userClient
    .from('bug_reports')
    .insert({ restaurant_id: restaurantIdSingle, description: `${tag} real RLS insert test` })
    .select('id')
    .single()
  if (bugReportInsertError || !insertedBugReport) {
    throw bugReportInsertError ?? new Error('bug_reports insert returned no row')
  }
  created.bugReportIds.push(insertedBugReport.id)
  console.log('Real authenticated bug_reports INSERT succeeded via repointed RLS policy:', insertedBugReport.id)

  const { data: readBack, error: bugReportSelectError } = await userClient
    .from('bug_reports')
    .select('id, restaurant_id')
    .eq('id', insertedBugReport.id)
    .maybeSingle()
  if (bugReportSelectError) throw bugReportSelectError
  assert(readBack?.id === insertedBugReport.id, 'repointed SELECT policy should allow reading own restaurant bug_reports row')
  console.log('Real authenticated bug_reports SELECT succeeded via repointed RLS policy')

  await userClient.auth.signOut()

  // ============================================================
  // Part 2: getRestaurantIdForUser / getRestaurantIdsForUser with REAL memberships
  // ============================================================
  console.log('\n--- Part 2: multi-restaurant resolution ---')

  const { getRestaurantIdForUser, getRestaurantIdsForUser, requireCallerRestaurantId, AmbiguousRestaurantError } =
    await import('../lib/supabase/admin-restaurant-auth')

  // 2a. Zero restaurants
  const zeroRestaurantUserId = await createRealAuthUser('zero-restaurants')
  const zeroIds = await getRestaurantIdsForUser(db as any, zeroRestaurantUserId)
  assert(zeroIds.length === 0, `expected 0 restaurant ids, got ${zeroIds.length}`)
  let threwNotFound = false
  try {
    await getRestaurantIdForUser(db as any, zeroRestaurantUserId)
  } catch (err) {
    threwNotFound = err instanceof Error && err.message.includes('not found')
  }
  assert(threwNotFound, 'getRestaurantIdForUser should throw a not-found error for a user with 0 restaurants')
  console.log('0-restaurant user: getRestaurantIdsForUser=[], getRestaurantIdForUser throws not-found -- OK')

  // 2b. Exactly one restaurant (the common case -- must be unaffected/deterministic)
  const oneRestaurantUserId = await createRealAuthUser('one-restaurant')
  const restaurantA = await createRealRestaurantWithOwnerRole(`${tag} Restaurant A`)
  await db.from('restaurant_users').insert({ restaurant_id: restaurantA, user_id: oneRestaurantUserId, role: 'owner' })

  const oneIds = await getRestaurantIdsForUser(db as any, oneRestaurantUserId)
  assert(oneIds.length === 1 && oneIds[0] === restaurantA, `expected [${restaurantA}], got ${JSON.stringify(oneIds)}`)
  const singleResolved = await getRestaurantIdForUser(db as any, oneRestaurantUserId)
  assert(singleResolved === restaurantA, `getRestaurantIdForUser should return ${restaurantA}, got ${singleResolved}`)
  console.log('1-restaurant user: getRestaurantIdForUser returns the correct single id -- OK')

  // 2c. Two real restaurants -- the actual bug being fixed
  const multiRestaurantUserId = await createRealAuthUser('multi-restaurant')
  const restaurantB = await createRealRestaurantWithOwnerRole(`${tag} Restaurant B`)
  const restaurantC = await createRealRestaurantWithOwnerRole(`${tag} Restaurant C`)
  // restaurant_users.role is FK'd to restaurant_roles(restaurant_id, role_slug) -- seed
  // 'manager' for C before inserting a membership row that uses it.
  const { error: managerRoleSeedError } = await db
    .from('restaurant_roles')
    .insert({ restaurant_id: restaurantC, role_slug: 'manager', display_name: 'Manager', permissions: [], is_system: false })
  if (managerRoleSeedError) throw managerRoleSeedError

  const { error: multiMembershipError } = await db.from('restaurant_users').insert([
    { restaurant_id: restaurantB, user_id: multiRestaurantUserId, role: 'owner' },
    { restaurant_id: restaurantC, user_id: multiRestaurantUserId, role: 'manager' },
  ])
  if (multiMembershipError) throw multiMembershipError

  const multiIds = await getRestaurantIdsForUser(db as any, multiRestaurantUserId)
  assert(multiIds.length === 2, `expected 2 restaurant ids, got ${multiIds.length}: ${JSON.stringify(multiIds)}`)
  assert(multiIds.includes(restaurantB) && multiIds.includes(restaurantC), 'both real restaurant ids should be present')
  assert(multiIds[0] === restaurantB, `owner-role restaurant should sort first (deterministic), got ${JSON.stringify(multiIds)}`)
  console.log('2-restaurant user: getRestaurantIdsForUser returns both, owner-first -- OK', multiIds)

  let threwAmbiguous = false
  let ambiguousIds: string[] = []
  try {
    await getRestaurantIdForUser(db as any, multiRestaurantUserId)
  } catch (err) {
    if (err instanceof AmbiguousRestaurantError) {
      threwAmbiguous = true
      ambiguousIds = err.restaurantIds
    }
  }
  assert(threwAmbiguous, 'getRestaurantIdForUser should throw AmbiguousRestaurantError for a real 2-restaurant user')
  assert(ambiguousIds.length === 2, 'AmbiguousRestaurantError should carry both real restaurant ids')
  console.log('2-restaurant user: getRestaurantIdForUser throws AmbiguousRestaurantError (not a silent arbitrary pick) -- OK')

  // requireCallerRestaurantId: explicit id -> should authorize against EITHER of the two,
  // proving it uses the full set, not the old single-scalar comparison.
  const resultForB = await requireCallerRestaurantId(db as any, multiRestaurantUserId, restaurantB)
  assert(typeof resultForB === 'string' && resultForB === restaurantB, `requireCallerRestaurantId should authorize restaurant B, got ${JSON.stringify(resultForB)}`)
  const resultForC = await requireCallerRestaurantId(db as any, multiRestaurantUserId, restaurantC)
  assert(typeof resultForC === 'string' && resultForC === restaurantC, `requireCallerRestaurantId should authorize restaurant C, got ${JSON.stringify(resultForC)}`)
  console.log('2-restaurant user: requireCallerRestaurantId authorizes BOTH real restaurants explicitly -- OK')

  // A restaurant this user does NOT belong to should be rejected (403), proving this isn't
  // a rubber-stamp -- cross-tenant safety still holds for a multi-restaurant user.
  const foreignRestaurantId = await createRealRestaurantWithOwnerRole(`${tag} Foreign Restaurant`)
  const rejectedResult = await requireCallerRestaurantId(db as any, multiRestaurantUserId, foreignRestaurantId)
  assert(
    rejectedResult && typeof rejectedResult === 'object' && 'status' in (rejectedResult as any) && (rejectedResult as any).status === 403,
    `requireCallerRestaurantId should 403 on a restaurant the caller does not belong to, got ${JSON.stringify(rejectedResult)}`,
  )
  console.log('2-restaurant user: requireCallerRestaurantId correctly 403s a restaurant NOT in their set -- OK')

  console.log('\nWS1_TENANCY_FOUNDATION_STAGING_VERIFY_OK', {
    restaurantIdSingle,
    restaurantA,
    restaurantB,
    restaurantC,
    foreignRestaurantId,
    multiRestaurantUserId,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('WS1_TENANCY_FOUNDATION_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
