import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

import { createStagingAdmin, STAGING_TEST_EMAIL, STAGING_TEST_RESTAURANT_ID, STAGING_TEST_USER_ID } from '../__tests__/helpers/staging-auth-fixtures'

const admin = createStagingAdmin()

async function main() {
  console.log('=== STAGING_TEST_USER ===')
  const { data: ru } = await admin
    .from('restaurant_users')
    .select('user_id, role, restaurant_id')
    .eq('user_id', STAGING_TEST_USER_ID)
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .maybeSingle()
  console.log(JSON.stringify(ru, null, 2))

  console.log('\n=== kitchen restaurant_roles for STAGING_TEST_RESTAURANT_ID ===')
  const { data: kitchenRole } = await admin
    .from('restaurant_roles')
    .select('role_slug, permissions')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .eq('role_slug', 'kitchen')
    .maybeSingle()
  console.log(JSON.stringify(kitchenRole, null, 2))
  console.log('kitchen has analytics:view:', kitchenRole?.permissions?.includes('analytics:view') ?? false)

  console.log('\n=== all restaurant_roles for STAGING_TEST_RESTAURANT_ID ===')
  const { data: allRoles } = await admin
    .from('restaurant_roles')
    .select('role_slug, permissions')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .order('role_slug')
  for (const row of allRoles ?? []) {
    const has = (row.permissions as string[] | null)?.includes('analytics:view') ?? false
    console.log(`  ${row.role_slug}: analytics:view=${has}`)
  }

  console.log('\n=== staff_members for test email ===')
  const { data: members } = await admin
    .from('staff_members')
    .select('id, email, role, active')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', STAGING_TEST_EMAIL)
  console.log(JSON.stringify(members, null, 2))

  const memberIds = (members ?? []).map((m) => m.id)
  if (memberIds.length > 0) {
    console.log('\n=== staff_permissions for test staff member(s) ===')
    const { data: perms } = await admin
      .from('staff_permissions')
      .select('*')
      .in('staff_id', memberIds)
    console.log(JSON.stringify(perms, null, 2))

    const analyticsAllows = (perms ?? []).filter(
      (p) => p.permission === 'analytics:view' && p.effect === 'allow',
    )
    console.log('analytics:view allow overrides:', analyticsAllows.length)
  } else {
    console.log('\n(no staff_members row — overrides N/A)')
  }

  console.log('\n=== ALL restaurants: non-owner/manager roles with analytics:view ===')
  const { data: polluted } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .not('role_slug', 'in', '("owner","manager")')
  const bad = (polluted ?? []).filter((r) =>
    (r.permissions as string[] | null)?.includes('analytics:view'),
  )
  if (bad.length === 0) {
    console.log('  NONE — kitchen/waiter/cashier/bar clean across all restaurants')
  } else {
    for (const row of bad) {
      console.log(`  POLLUTED: restaurant=${row.restaurant_id} role=${row.role_slug}`)
    }
  }

  console.log('\n=== owner/manager analytics:view coverage (staging) ===')
  const { data: omRoles } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .in('role_slug', ['owner', 'manager'])
  const missing = (omRoles ?? []).filter(
    (r) => !(r.permissions as string[] | null)?.includes('analytics:view'),
  )
  console.log(`  owner/manager rows total: ${omRoles?.length ?? 0}`)
  console.log(`  missing analytics:view: ${missing.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
