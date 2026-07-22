/**
 * Phase 5A production seed fidelity + per-restaurant diff report.
 *   npx tsx scripts/verify-phase5a-production-seed.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { PERMISSIONS } from '../lib/permissions'
import { getRolePermissionsFromConfig } from '../lib/permissions/role-permissions-config'

config({ path: '.env.production.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(PROD_REF) || !serviceKey) {
  throw new Error('Refusing: production credentials missing or wrong project ref')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const SYSTEM_SLUGS = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'] as const
const STATION_PERMS = new Set<string>([
  PERMISSIONS.ORDERS_STATION_KITCHEN,
  PERMISSIONS.ORDERS_STATION_BAR,
])

function sorted(arr: string[]) {
  return [...arr].sort()
}

function expectedForSlug(slug: string): string[] {
  const perms = getRolePermissionsFromConfig(slug)
  if (!perms) throw new Error(`Missing config for ${slug}`)
  return sorted([...perms])
}

function addedPermissions(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before)
  return sorted(after.filter((p) => !beforeSet.has(p)))
}

function removedPermissions(before: string[], after: string[]): string[] {
  const afterSet = new Set(after)
  return sorted(before.filter((p) => !afterSet.has(p)))
}

async function main() {
  const { data: restaurants, error: restaurantsError } = await admin
    .from('restaurants')
    .select('id, name')
    .order('name')

  if (restaurantsError) throw restaurantsError

  const { data: rows, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .order('role_slug')

  if (rolesError) throw rolesError

  const byRestaurant = new Map<string, NonNullable<typeof rows>>()
  for (const row of rows ?? []) {
    const list = byRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    byRestaurant.set(row.restaurant_id, list)
  }

  console.log('=== Phase 5A production seed fidelity ===')
  console.log(`Restaurants: ${restaurants?.length ?? 0}\n`)

  let allOk = true
  const barStaffRows: Array<{
    restaurant_id: string
    restaurant_name: string
    user_id: string
    email: string | null
    role: string
  }> = []

  for (const restaurant of restaurants ?? []) {
    const roles = byRestaurant.get(restaurant.id) ?? []
    let restaurantOk = true

    console.log(`--- ${restaurant.name} (${restaurant.id}) ---`)
    console.log(`Roles present: ${roles.length}/6`)

    if (roles.length !== 6) {
      restaurantOk = false
      console.log(`  FAIL: expected 6 system roles`)
    }

    for (const slug of SYSTEM_SLUGS) {
      const dbRow = roles.find((r) => r.role_slug === slug)
      const expected = expectedForSlug(slug)

      if (!dbRow) {
        restaurantOk = false
        console.log(`  ${slug}: MISSING`)
        continue
      }

      const actual = sorted((dbRow.permissions as string[]) ?? [])
      const match = JSON.stringify(actual) === JSON.stringify(expected)
      const hasStation = actual.some((p) => STATION_PERMS.has(p))
      const shouldHaveStation = slug === 'kitchen' || slug === 'bar'

      if (!match || hasStation !== shouldHaveStation) {
        restaurantOk = false
      }

      const status = match ? 'MATCH' : 'MISMATCH'
      console.log(`  ${slug}: ${status}`)
      if (!match) {
        console.log(`    expected: ${JSON.stringify(expected)}`)
        console.log(`    actual:   ${JSON.stringify(actual)}`)
      } else {
        console.log(`    permissions: ${JSON.stringify(actual)}`)
      }

      if (slug === 'bar') {
        const hadOrdersRead = actual.includes(PERMISSIONS.ORDERS_READ)
        const hasBarStation = actual.includes(PERMISSIONS.ORDERS_STATION_BAR)
        console.log(
          `    bar access grant: orders:read=${hadOrdersRead} orders:station:bar=${hasBarStation} (real access, not cosmetic)`,
        )
      }
      if (slug === 'kitchen') {
        console.log(
          `    kitchen station scope: ${actual.includes(PERMISSIONS.ORDERS_STATION_KITCHEN)}`,
        )
      }
      if (['owner', 'manager', 'waiter', 'cashier'].includes(slug) && hasStation) {
        restaurantOk = false
        console.log(`    FAIL: ${slug} must not have station scope`)
      }
    }

    console.log(`  Restaurant result: ${restaurantOk ? 'PASS' : 'FAIL'}\n`)
    if (!restaurantOk) allOk = false
  }

  const { data: barUsers, error: barUsersError } = await admin
    .from('restaurant_users')
    .select('restaurant_id, user_id, role, users(email)')
    .eq('role', 'bar')
    .eq('invite_accepted', true)

  if (barUsersError) throw barUsersError

  for (const row of barUsers ?? []) {
    const restaurant = restaurants?.find((r) => r.id === row.restaurant_id)
    const email =
      row.users && typeof row.users === 'object' && 'email' in row.users
        ? String((row.users as { email?: string }).email ?? '')
        : null
    barStaffRows.push({
      restaurant_id: row.restaurant_id,
      restaurant_name: restaurant?.name ?? row.restaurant_id,
      user_id: row.user_id,
      email,
      role: row.role,
    })
  }

  console.log('=== REAL bar-role staff on production (invite_accepted) ===')
  if (barStaffRows.length === 0) {
    console.log('None found.')
  } else {
    for (const row of barStaffRows) {
      console.log(
        `- ${row.restaurant_name} | ${row.email ?? row.user_id} | user_id=${row.user_id}`,
      )
    }
  }

  console.log(`\nOverall seed fidelity: ${allOk ? 'ALL PASS' : 'FAILURES DETECTED'}`)
  if (!allOk) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
