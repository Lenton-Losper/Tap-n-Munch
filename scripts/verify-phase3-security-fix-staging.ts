/**
 * Staging verification for Phase 3 security fixes (restaurant-settings + report-schedules).
 *   npx tsx scripts/verify-phase3-security-fix-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.test', override: true })

const APP = process.env.FLASHTAP_BASE_URL ?? 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const ts = Date.now()
const tag = `sec-fix-${ts}`

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error(`Refusing: expected staging Supabase (${STAGING_REF}), got ${url}`)
}

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const pw = `Fix${randomUUID().slice(0, 8)}!1`
const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let scheduleBId: string | null = null
const originalBName = `${tag} Restaurant B`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function setup() {
  const { data: a, error: aErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant A`, slug: `${tag}-a` })
    .select('id')
    .single()
  if (aErr) throw aErr
  restAId = a.id

  const { data: b, error: bErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: originalBName, slug: `${tag}-b` })
    .select('id')
    .single()
  if (bErr) throw bErr
  restBId = b.id

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
    { id: ownerAId, email: ownerAEmail, role: 'owner', restaurant_id: restAId, full_name: 'A' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', restaurant_id: restBId, full_name: 'B' },
  ])
  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
  ])

  const { data: sched, error: schedErr } = await dbAdmin
    .from('report_schedules')
    .insert({
      restaurant_id: restBId,
      email: `${tag}.reports@flashtap-test.invalid`,
      format: 'csv',
      send_time: '20:00',
      timezone: 'Africa/Windhoek',
      enabled: true,
    })
    .select('id')
    .single()
  if (schedErr) throw schedErr
  scheduleBId = sched.id
}

async function cleanup() {
  if (scheduleBId) await dbAdmin.from('report_schedules').delete().eq('id', scheduleBId)
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('report_schedules').delete().eq('restaurant_id', rid)
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
  await setup()
  const ownerAToken = await signIn(ownerAEmail)
  const ownerBToken = await signIn(ownerBEmail)

  const unauthSettings = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: restBId, updates: { name: `${tag}-UNAUTH` } }),
  })

  const crossSettings = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerAToken}`,
    },
    body: JSON.stringify({ restaurantId: restBId, updates: { name: `${tag}-CROSS` } }),
  })

  const legitSettings = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerAToken}`,
    },
    body: JSON.stringify({
      restaurantId: restAId,
      updates: { name: `${tag} Restaurant A Updated` },
    }),
  })
  const legitSettingsBody = await legitSettings.json().catch(() => ({}))

  const crossRsGet = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const crossRsPost = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: `${tag}.evil@flashtap-test.invalid`, format: 'csv' }),
  })

  const legitRsGet = await fetch(`${APP}/api/admin/restaurants/${restAId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const legitRsPost = await fetch(`${APP}/api/admin/restaurants/${restAId}/report-schedules`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: `${tag}.legit@flashtap-test.invalid`, format: 'csv' }),
  })
  const legitRsPostBody = await legitRsPost.json().catch(() => ({}))
  const injectedId = legitRsPostBody?.schedule?.id as string | undefined

  const ownerBLegit = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerBToken}` },
  })
  const ownerBLegitBody = await ownerBLegit.json().catch(() => ({}))

  if (injectedId) {
    await dbAdmin.from('report_schedules').delete().eq('id', injectedId)
  }

  const report = {
    app: APP,
    exploitBlocked: {
      unauthSettings: unauthSettings.status,
      crossSettings: crossSettings.status,
      crossRsGet: crossRsGet.status,
      crossRsPost: crossRsPost.status,
    },
    legitimate: {
      ownerASettings: { status: legitSettings.status, name: legitSettingsBody?.data?.name },
      ownerAReportSchedulesGet: legitRsGet.status,
      ownerAReportSchedulesPost: legitRsPost.status,
      ownerBReportSchedulesGet: {
        status: ownerBLegit.status,
        count: Array.isArray(ownerBLegitBody?.schedules) ? ownerBLegitBody.schedules.length : null,
      },
    },
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    [401, 403].includes(unauthSettings.status) &&
    crossSettings.status === 403 &&
    crossRsGet.status === 403 &&
    crossRsPost.status === 403 &&
    legitSettings.status === 200 &&
    legitRsGet.status === 200 &&
    legitRsPost.status === 200 &&
    ownerBLegit.status === 200

  if (!pass) {
    console.error('SECURITY_FIX_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('SECURITY_FIX_STAGING_OK')
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
