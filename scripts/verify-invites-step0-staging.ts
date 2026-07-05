/**
 * Step 0 safety check: invite routes cross-tenant isolation on staging.
 *   npx tsx scripts/verify-invites-step0-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.test', override: true })

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `invites-step0-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let inviteBId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function cleanup() {
  if (inviteBId) await dbAdmin.from('staff_invites').delete().eq('id', inviteBId)
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('staff_invites').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of [ownerAId, ownerBId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function main() {
  const { data: a } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} A`, slug: `${tag}-a` })
    .select('id')
    .single()
  restAId = a!.id

  const { data: b } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} B`, slug: `${tag}-b` })
    .select('id')
    .single()
  restBId = b!.id

  for (const [email, label] of [
    [ownerAEmail, 'ownerA'],
    [ownerBEmail, 'ownerB'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerAId, email: ownerAEmail, role: 'owner', restaurant_id: restAId, full_name: 'OA' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', restaurant_id: restBId, full_name: 'OB' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
  ])

  const { data: inviteB, error: inviteErr } = await dbAdmin
    .from('staff_invites')
    .insert({
      restaurant_id: restBId,
      email: `${tag}.target@flashtap-test.invalid`,
      role: 'waiter',
      token: randomUUID(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      invited_by: ownerBId,
      accepted: false,
    })
    .select('id, email')
    .single()
  if (inviteErr) throw inviteErr
  inviteBId = inviteB.id

  const ownerAToken = await signIn(ownerAEmail)
  const ownerBToken = await signIn(ownerBEmail)

  const ownerAGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const ownerAGetBody = await ownerAGet.json()

  const ownerBGet = await fetch(`${APP}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${ownerBToken}` },
  })
  const ownerBGetBody = await ownerBGet.json()

  const crossPost = await fetch(`${APP}/api/admin/invites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.cross-post@flashtap-test.invalid`,
      role: 'waiter',
      restaurantId: restBId,
    }),
  })
  const crossPostBody = await crossPost.json().catch(() => ({}))

  const crossDelete = await fetch(`${APP}/api/admin/invites/${inviteBId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const crossDeleteBody = await crossDelete.json().catch(() => ({}))

  const { data: inviteAfter } = await dbAdmin
    .from('staff_invites')
    .select('id, restaurant_id')
    .eq('id', inviteBId)
    .maybeSingle()

  const report = {
    app: APP,
    tag,
    restaurantA: restAId,
    restaurantB: restBId,
    inviteOnB: { id: inviteBId, email: inviteB.email },
    ownerAListInvites: {
      status: ownerAGet.status,
      count: Array.isArray(ownerAGetBody.invites) ? ownerAGetBody.invites.length : null,
      leakedBEmail: Array.isArray(ownerAGetBody.invites)
        ? ownerAGetBody.invites.some((i: { email?: string }) => i.email === inviteB.email)
        : null,
    },
    ownerBListInvites: {
      status: ownerBGet.status,
      count: Array.isArray(ownerBGetBody.invites) ? ownerBGetBody.invites.length : null,
      hasBInvite: Array.isArray(ownerBGetBody.invites)
        ? ownerBGetBody.invites.some((i: { id?: string }) => i.id === inviteBId)
        : null,
    },
    ownerACrossPost: {
      status: crossPost.status,
      body: crossPostBody,
      note: 'POST has no restaurantId param in route — invite should land on caller restaurant A only',
    },
    ownerACrossDelete: {
      status: crossDelete.status,
      body: crossDeleteBody,
      inviteBStillExists: Boolean(inviteAfter),
    },
    assertRestaurantAdminSafe:
      'restaurantId from getRestaurantIdForUser(session); DELETE checks invite.restaurant_id === caller',
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    ownerAGet.status === 200 &&
    ownerAGetBody.invites?.length === 0 &&
    ownerBGet.status === 200 &&
    ownerBGetBody.invites?.length === 1 &&
    crossDelete.status === 403 &&
    inviteAfter?.restaurant_id === restBId

  if (crossPost.status === 200) {
    const { data: stray } = await dbAdmin
      .from('staff_invites')
      .select('restaurant_id')
      .eq('email', `${tag}.cross-post@flashtap-test.invalid`)
      .maybeSingle()
    if (stray?.restaurant_id === restBId) {
      console.error('VULNERABILITY: cross-tenant POST created invite on restaurant B')
      process.exitCode = 1
    } else if (stray?.restaurant_id === restAId) {
      console.log('Cross POST scoped to caller restaurant A (expected)')
      await dbAdmin.from('staff_invites').delete().eq('email', `${tag}.cross-post@flashtap-test.invalid`)
    }
  }

  if (!pass) {
    console.error('INVITES_STEP0_FAIL')
    process.exitCode = 1
  } else {
    console.log('INVITES_STEP0_OK — assertRestaurantAdmin + invite routes are cross-tenant safe')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await cleanup()
      console.log('Cleanup complete.')
    } catch (e) {
      console.error('Cleanup error:', e)
    }
  })
