/**
 * Staging verification for the sync-profile owner_id reassignment guard (#8).
 *
 * Reproduces "account was recreated, relinked by email" for two roles:
 *   1. Manager repair: relinking a manager's recreated auth account must NOT
 *      touch restaurants.owner_id (the bug #8 reports).
 *   2. Owner repair: relinking the actual owner's recreated auth account must
 *      still update restaurants.owner_id to the new auth id (regression guard
 *      — the fix must not break the legitimate case).
 *
 *   npx tsx scripts/verify-sync-profile-owner-guard-staging.ts
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const STAGING_TEST_PASSWORD = requireStagingTestPassword()

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: STAGING_TEST_PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user?.id) throw error || new Error('createUser failed')
  return data.user.id
}

async function getAccessTokenFor(email: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password: STAGING_TEST_PASSWORD })
  if (error || !data.session?.access_token) throw error || new Error('sign-in failed')
  return data.session.access_token
}

async function callSyncProfile(accessToken: string): Promise<{ status: number; body: any }> {
  const { POST } = await import('@/app/api/auth/sync-profile/route')
  const req = new Request('http://localhost/api/auth/sync-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({}),
  })
  const res = await POST(req)
  const body = await res.json()
  return { status: res.status, body }
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  const authUserIds: string[] = []
  let restaurantId: string | null = null

  console.log(`[${ts()}] === sync-profile owner_id guard staging verification (#8) ===`)

  try {
    // --- Setup: restaurant owned by a real owner account ---
    const ownerEmail = `sync-profile-owner-${tag}@example.com`
    const ownerAuthId = await createAuthUser(ownerEmail)
    authUserIds.push(ownerAuthId)

    const { data: restaurant, error: restErr } = await admin
      .from('restaurants')
      .insert({ name: `Sync Profile Guard Test ${tag}`, currency: 'NAD' })
      .select('id')
      .single()
    if (restErr || !restaurant?.id) throw restErr || new Error('restaurant insert failed')
    restaurantId = String(restaurant.id)

    await admin.from('users').insert({
      id: ownerAuthId,
      email: ownerEmail,
      name: 'Test Owner',
      role: 'owner',
      restaurant_id: restaurantId,
    })

    await admin.from('restaurants').update({ owner_id: ownerAuthId }).eq('id', restaurantId)

    // --- Case 1: manager account gets "recreated" (new auth id, same email) ---
    const managerEmail = `sync-profile-manager-${tag}@example.com`
    // Stale public.users row id, not backed by any live auth user — same
    // shape as the "account was recreated" scenario the route handles.
    const managerOldAuthId = randomUUID()
    await admin.from('users').insert({
      id: managerOldAuthId,
      email: managerEmail,
      name: 'Test Manager',
      role: 'manager',
      restaurant_id: restaurantId,
    })

    const managerNewAuthId = await createAuthUser(managerEmail)
    authUserIds.push(managerNewAuthId)
    const managerToken = await getAccessTokenFor(managerEmail)

    const managerResult = await callSyncProfile(managerToken)
    await assert(managerResult.status === 200 && managerResult.body?.relinked === true, 'manager relink succeeded')

    const { data: restaurantAfterManagerRepair } = await admin
      .from('restaurants')
      .select('owner_id')
      .eq('id', restaurantId)
      .single()
    await assert(
      restaurantAfterManagerRepair?.owner_id === ownerAuthId,
      'manager repair did NOT reassign restaurants.owner_id (this is the exact bug #8 reports)',
    )

    const { data: relinkedManager } = await admin
      .from('users')
      .select('id, role, restaurant_id')
      .eq('id', managerNewAuthId)
      .maybeSingle()
    await assert(relinkedManager?.role === 'manager', 'relinked manager row kept role=manager')
    await assert(relinkedManager?.restaurant_id === restaurantId, 'relinked manager row kept restaurant_id')

    // --- Case 2 (regression guard): owner account gets "recreated" too ---
    // Delete the current public.users owner row and auth user to simulate
    // "account was recreated": a fresh auth user with the same email repairs.
    await admin.from('users').delete().eq('id', ownerAuthId)
    await admin.auth.admin.deleteUser(ownerAuthId).catch(() => {})
    authUserIds.splice(authUserIds.indexOf(ownerAuthId), 1)

    // Re-insert a stale owner row (simulating the pre-recreation public.users row)
    // under a placeholder id distinct from any live auth user.
    const staleOwnerId = randomUUID()
    await admin.from('users').insert({
      id: staleOwnerId,
      email: ownerEmail,
      name: 'Test Owner',
      role: 'owner',
      restaurant_id: restaurantId,
    })

    const ownerNewAuthId = await createAuthUser(ownerEmail)
    authUserIds.push(ownerNewAuthId)
    const ownerToken = await getAccessTokenFor(ownerEmail)

    const ownerResult = await callSyncProfile(ownerToken)
    await assert(ownerResult.status === 200 && ownerResult.body?.relinked === true, 'owner relink succeeded')

    const { data: restaurantAfterOwnerRepair } = await admin
      .from('restaurants')
      .select('owner_id')
      .eq('id', restaurantId)
      .single()
    await assert(
      restaurantAfterOwnerRepair?.owner_id === ownerNewAuthId,
      'owner repair DID reassign restaurants.owner_id to the new auth id (regression guard: legitimate case still works)',
    )

    console.log(`\n[${ts()}] sync-profile owner_id guard verification passed.`)
  } finally {
    if (restaurantId) {
      await admin.from('restaurants').delete().eq('id', restaurantId)
    }
    for (const userId of authUserIds) {
      await admin.from('users').delete().eq('id', userId)
      await admin.auth.admin.deleteUser(userId).catch(() => {})
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
