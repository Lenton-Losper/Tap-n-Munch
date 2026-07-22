import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const APP = 'https://www.flashtap.app'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function check(staffId: string, label: string) {
  const { data } = await admin.from('staff_members').select('id').eq('id', staffId).maybeSingle()
  console.log(label, data ? 'EXISTS' : 'MISSING')
}

async function main() {
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
  const staffId = staff!.id
  await check(staffId, 'after setup')

  const { data: ownerRow } = await admin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  const { data: userRow } = await admin.from('users').select('email').eq('id', ownerRow!.user_id).maybeSingle()
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: userRow!.email })
  const { data: sess } = await admin.auth.verifyOtp({
    token_hash: link!.properties!.hashed_token,
    type: 'magiclink',
  })
  await fetch(`${APP}/api/analytics/orders-summary?restaurantId=${RIVIERA}`, {
    headers: { Authorization: `Bearer ${sess!.session!.access_token}` },
  })
  await check(staffId, 'after owner analytics API')

  const { data: signInData } = await anon.auth.signInWithPassword({ email: testEmail, password: testPassword })
  await check(staffId, 'after waiter signIn')

  await admin.from('staff_members').delete().eq('id', staffId)
  await admin.from('restaurant_users').delete().eq('user_id', userId)
  await admin.from('users').delete().eq('id', userId)
  await admin.auth.admin.deleteUser(userId)
}

main().catch(console.error)
