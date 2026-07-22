import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const testEmail = `analytics.prod.verify.${Date.now()}@flashtap-test.invalid`
const testPassword = `Verify${randomUUID().slice(0, 8)}!1`

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log('OK', name)
  } catch (e) {
    console.error('FAIL', name, e)
    throw e
  }
}

async function main() {
  let userId = ''
  let staffId = ''

  await step('createUser', async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (error) throw error
    userId = data.user.id
  })

  await step('users insert', async () => {
    const { error } = await admin.from('users').insert({
      id: userId,
      email: testEmail,
      full_name: 'test',
      role: 'waiter',
    })
    if (error) throw error
  })

  await step('restaurant_users insert', async () => {
    const { error } = await admin.from('restaurant_users').insert({
      restaurant_id: RIVIERA,
      user_id: userId,
      role: 'waiter',
      invite_accepted: true,
    })
    if (error) throw error
  })

  await step('staff_members insert', async () => {
    const { data, error } = await admin
      .from('staff_members')
      .insert({ restaurant_id: RIVIERA, email: testEmail, role: 'waiter', active: true })
      .select('id')
      .single()
    if (error) throw error
    staffId = data.id
  })

  await step('staff_permissions insert', async () => {
    const { error } = await admin.from('staff_permissions').insert({
      staff_id: staffId,
      restaurant_id: RIVIERA,
      permission: PERMISSIONS.ANALYTICS_VIEW,
      effect: 'allow',
    })
    if (error) throw error
  })

  await admin.from('staff_permissions').delete().eq('staff_id', staffId)
  await admin.from('staff_members').delete().eq('id', staffId)
  await admin.from('restaurant_users').delete().eq('user_id', userId)
  await admin.from('users').delete().eq('id', userId)
  await admin.auth.admin.deleteUser(userId)
  console.log('CLEANED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
