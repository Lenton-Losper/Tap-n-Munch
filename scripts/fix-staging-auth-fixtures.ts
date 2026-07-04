import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

import { createStagingAdmin, restoreRestaurantRoles, STAGING_TEST_RESTAURANT_ID } from '../__tests__/helpers/staging-auth-fixtures'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'

const admin = createStagingAdmin()

const expected = Object.fromEntries(
  Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
)

async function main() {
  const { data: roles } = await admin
    .from('restaurant_roles')
    .select('*')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)

  if ((roles?.length ?? 0) === 6) {
    console.log('restaurant_roles already has 6 rows — restoring from snapshot')
    await restoreRestaurantRoles(admin, STAGING_TEST_RESTAURANT_ID, roles ?? [])
  } else {
    console.log(`restaurant_roles count=${roles?.length ?? 0} — re-seeding from JSON`)
    await admin.from('restaurant_roles').delete().eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    const rows = Object.entries(expected).map(([role_slug, permissions]) => ({
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      role_slug,
      display_name: role_slug.charAt(0).toUpperCase() + role_slug.slice(1),
      permissions,
      is_system: role_slug === 'owner',
    }))
    const { error } = await admin.from('restaurant_roles').insert(rows)
    if (error) throw error
  }

  const { data: members } = await admin
    .from('staff_members')
    .select('id, email')
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .ilike('email', 'staging.kitchen.test@gmail.com')

  if ((members?.length ?? 0) > 1) {
    const keep = members![0].id
    const extra = members!.slice(1).map((m) => m.id)
    await admin.from('staff_permissions').delete().in('staff_id', extra)
    await admin.from('staff_members').delete().in('id', extra)
    console.log(`deduped staff_members: kept ${keep}, removed ${extra.length}`)
  }

  console.log('STAGING_FIXTURE_CLEANUP_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
