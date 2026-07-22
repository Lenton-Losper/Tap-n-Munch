import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const APP = 'https://www.flashtap.app'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function setup() {
  const testEmail = `analytics.prod.verify.${Date.now()}@flashtap-test.invalid`
  const testPassword = `Verify${randomUUID().slice(0, 8)}!1`
  const { data: created } = await admin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  })
  const userId = created.user.id
  await admin.from('users').insert({ id: userId, email: testEmail, full_name: 't', role: 'waiter' })
  await admin.from('restaurant_users').insert({
    restaurant_id: RIVIERA,
    user_id: userId,
    role: 'waiter',
    invite_accepted: true,
  })
  const { data: staff } = await admin
    .from('staff_members')
    .insert({ restaurant_id: RIVIERA, email: testEmail, role: 'waiter', active: true })
    .select('id')
    .single()
  return { testEmail, testPassword, userId, staffId: staff!.id }
}

async function check(staffId: string, label: string) {
  const { data } = await admin.from('staff_members').select('id').eq('id', staffId).maybeSingle()
  console.log(label, data ? 'EXISTS' : 'MISSING')
}

async function main() {
  const fx = await setup()
  await check(fx.staffId, 'after setup')

  const { data: signInData } = await anon.auth.signInWithPassword({
    email: fx.testEmail,
    password: fx.testPassword,
  })
  await check(fx.staffId, 'after signIn')

  await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${signInData.session!.access_token}` },
  })
  await check(fx.staffId, 'after /api/auth/role')

  await fetch(`${APP}/api/analytics/orders-summary?restaurantId=${RIVIERA}`, {
    headers: { Authorization: `Bearer ${signInData.session!.access_token}` },
  })
  await check(fx.staffId, 'after analytics API')

  await fetch(`${APP}/analytics`, {
    headers: { Authorization: `Bearer ${signInData.session!.access_token}` },
    redirect: 'manual',
  })
  await check(fx.staffId, 'after /analytics page')

  await admin.from('staff_members').delete().eq('id', fx.staffId).catch(() => undefined)
  await admin.from('restaurant_users').delete().eq('user_id', fx.userId)
  await admin.from('users').delete().eq('id', fx.userId)
  await admin.auth.admin.deleteUser(fx.userId)
}

main().catch(console.error)
