/**
 * Staging verification for Authorization v2 Phase 2 seed data.
 * Run after migrations 20260704160000 + 20260704161000:
 *   npx tsx scripts/verify-auth-v2-phase2-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`OK: ${message}`)
}

function expectedFromJson(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
  ) as Record<string, string[]>
}

function sorted(arr: string[]): string[] {
  return [...arr].sort()
}

async function main() {
  console.log('=== Auth v2 Phase 2 seed fidelity (staging) ===\n')

  const expected = expectedFromJson()
  const roleSlugs = Object.keys(expected)

  const { data: restaurants, error: restaurantsError } = await admin
    .from('restaurants')
    .select('id, name')

  if (restaurantsError) throw restaurantsError

  const { data: rows, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions, is_system')

  if (rolesError) throw rolesError

  const byRestaurant = new Map<string, NonNullable<typeof rows>>()
  for (const row of rows ?? []) {
    const list = byRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    byRestaurant.set(row.restaurant_id, list)
  }

  for (const restaurant of restaurants ?? []) {
    const roles = byRestaurant.get(restaurant.id) ?? []
    await assert(roles.length === 6, `${restaurant.name} (${restaurant.id}) has exactly 6 roles`)

    for (const slug of roleSlugs) {
      const dbRow = roles.find((r) => r.role_slug === slug)
      await assert(Boolean(dbRow), `${restaurant.name}: role ${slug} exists`)

      const dbPerms = sorted((dbRow!.permissions as string[]) ?? [])
      const jsonPerms = sorted(expected[slug] ?? [])
      await assert(
        JSON.stringify(dbPerms) === JSON.stringify(jsonPerms),
        `${restaurant.name}: ${slug} permissions match JSON (${dbPerms.length} keys)`,
      )

      if (slug === 'owner') {
        await assert(dbRow!.is_system === true, `${restaurant.name}: owner is_system=true`)
      } else {
        await assert(dbRow!.is_system === false, `${restaurant.name}: ${slug} is_system=false`)
      }
    }
  }

  console.log(`\nChecked ${restaurants?.length ?? 0} restaurants. Seed fidelity passed.`)
}

main().catch((error) => {
  console.error('\nVerification failed:', error)
  process.exit(1)
})
