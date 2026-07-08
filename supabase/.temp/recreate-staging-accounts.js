const { createClient } = require('@supabase/supabase-js')
const { execSync } = require('child_process')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test'), override: true })

function requireStagingTestPassword() {
  const password = process.env.STAGING_TEST_PASSWORD?.trim()
  if (!password) {
    throw new Error('Refusing: STAGING_TEST_PASSWORD is not set (.env.test)')
  }
  return password
}

const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const RESTAURANT_NAME = 'staging test'

const ACCOUNTS = [
  {
    email: 'flashtap.staging.test@gmail.com',
    password: STAGING_TEST_PASSWORD,
    fullName: 'Staging Test Owner',
    role: 'owner',
  },
  {
    email: 'staging.manager.test@gmail.com',
    password: STAGING_TEST_PASSWORD,
    fullName: 'Staging Manager',
    role: 'manager',
  },
]

function getStagingKeys() {
  const raw = execSync(
    'npx supabase projects api-keys --project-ref mdqjpxwczrhkxkbqatqa',
    { encoding: 'utf8', cwd: __dirname + '/../..' },
  )
  const payload = JSON.parse(raw)
  const service = payload.keys.find((k) => k.name === 'service_role')
  if (!service?.api_key) throw new Error('Missing staging service_role key')
  return {
    url: 'https://mdqjpxwczrhkxkbqatqa.supabase.co',
    serviceRoleKey: service.api_key,
  }
}

async function deleteAuthUserIfExists(admin, email) {
  const { data, error } = await admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw error
  const existing = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!existing) return null
  const { error: delError } = await admin.deleteUser(existing.id)
  if (delError) throw delError
  return existing.id
}

async function createAuthUser(admin, account) {
  await deleteAuthUserIfExists(admin, account.email)

  const { data, error } = await admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: true,
    user_metadata: { full_name: account.fullName },
  })

  if (error || !data.user?.id) {
    throw error || new Error(`Failed to create auth user for ${account.email}`)
  }

  return data.user.id
}

async function cleanupRestaurantMemberships(db) {
  const { error: ownerClearError } = await db
    .from('restaurants')
    .update({ owner_id: null })
    .eq('id', RESTAURANT_ID)
  if (ownerClearError) throw ownerClearError

  const { error } = await db.from('restaurant_users').delete().eq('restaurant_id', RESTAURANT_ID)
  if (error) throw error

  for (const account of ACCOUNTS) {
    const { error: userDeleteError } = await db.from('users').delete().eq('email', account.email)
    if (userDeleteError) throw userDeleteError
  }
}

async function upsertPublicUser(db, userId, account, restaurantId) {
  const { error: deleteByIdError } = await db.from('users').delete().eq('id', userId)
  if (deleteByIdError) throw deleteByIdError

  const { error } = await db.from('users').insert({
    id: userId,
    email: account.email,
    full_name: account.fullName,
    name: account.fullName,
    restaurant_id: restaurantId,
    role: account.role,
  })

  if (error) throw error
}

async function upsertRestaurantUser(db, userId, role, restaurantId) {
  const { error: deleteError } = await db
    .from('restaurant_users')
    .delete()
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)
  if (deleteError) throw deleteError

  const { error } = await db.from('restaurant_users').insert({
    restaurant_id: restaurantId,
    user_id: userId,
    role,
    invite_accepted: true,
  })

  if (error) throw error
}

async function ensureRestaurant(db, ownerId) {
  const { data: existing, error: readError } = await db
    .from('restaurants')
    .select('id, name, owner_id')
    .eq('id', RESTAURANT_ID)
    .maybeSingle()

  if (readError) throw readError

  if (!existing) {
    const { error } = await db.from('restaurants').insert({
      id: RESTAURANT_ID,
      name: RESTAURANT_NAME,
      owner_id: ownerId,
      currency: 'NAD',
    })
    if (error) throw error
    return { created: true, owner_id: ownerId }
  }

  if (existing.owner_id !== ownerId) {
    const { error } = await db
      .from('restaurants')
      .update({ owner_id: ownerId, name: RESTAURANT_NAME })
      .eq('id', RESTAURANT_ID)
    if (error) throw error
    return { created: false, owner_id: ownerId, updated: true }
  }

  return { created: false, owner_id: existing.owner_id }
}

async function verifySignIn(url, anonKey, email, password) {
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data.user?.id
}

async function main() {
  const { url, serviceRoleKey } = getStagingKeys()
  const keysRaw = execSync('npx supabase projects api-keys --project-ref mdqjpxwczrhkxkbqatqa', {
    encoding: 'utf8',
    cwd: __dirname + '/../..',
  })
  const anonKey = JSON.parse(keysRaw).keys.find((k) => k.name === 'anon')?.api_key
  if (!anonKey) throw new Error('Missing anon key')

  const adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const db = adminClient
  const admin = adminClient.auth.admin

  await cleanupRestaurantMemberships(db)

  const ownerAccount = ACCOUNTS[0]
  const managerAccount = ACCOUNTS[1]

  const ownerId = await createAuthUser(admin, ownerAccount)
  await upsertPublicUser(db, ownerId, ownerAccount, RESTAURANT_ID)
  const restaurant = await ensureRestaurant(db, ownerId)
  await upsertRestaurantUser(db, ownerId, ownerAccount.role, RESTAURANT_ID)

  const managerId = await createAuthUser(admin, managerAccount)
  await upsertPublicUser(db, managerId, managerAccount, RESTAURANT_ID)
  await upsertRestaurantUser(db, managerId, managerAccount.role, RESTAURANT_ID)

  const ownerSignInId = await verifySignIn(url, anonKey, ownerAccount.email, ownerAccount.password)
  const managerSignInId = await verifySignIn(url, anonKey, managerAccount.email, managerAccount.password)

  const { data: restaurantRow, error: restaurantError } = await db
    .from('restaurants')
    .select('id, name, owner_id')
    .eq('id', RESTAURANT_ID)
    .single()
  if (restaurantError) throw restaurantError

  const { data: memberships, error: membershipError } = await db
    .from('restaurant_users')
    .select('user_id, role, invite_accepted, users!restaurant_users_user_id_fkey(email)')
    .eq('restaurant_id', RESTAURANT_ID)
    .order('role')
  if (membershipError) throw membershipError

  console.log(
    JSON.stringify(
      {
        restaurant: restaurantRow,
        restaurantUpsert: restaurant,
        memberships,
        owner: { userId: ownerId, signInUserId: ownerSignInId },
        manager: { userId: managerId, signInUserId: managerSignInId },
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
