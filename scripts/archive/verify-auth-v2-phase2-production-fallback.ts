/**
 * Verify no restaurant would hit JSON fallback (all have seeded restaurant_roles).
 *   npx tsx scripts/verify-auth-v2-phase2-production-fallback.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error('Refusing to run: not production Supabase')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ROLE_SLUGS = Object.keys(rolePermissionsConfig).filter((k) => !k.startsWith('$'))

function sorted(arr: string[]): string[] {
  return [...arr].sort()
}

function expectedFromJson(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
  ) as Record<string, string[]>
}

async function main() {
  const expected = expectedFromJson()

  const { data: restaurants, error } = await admin.from('restaurants').select('id, name').order('name')
  if (error) throw error

  const { data: rows, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')

  if (rolesError) throw rolesError

  const byRestaurant = new Map<string, Map<string, string[]>>()
  for (const row of rows ?? []) {
    let map = byRestaurant.get(row.restaurant_id)
    if (!map) {
      map = new Map()
      byRestaurant.set(row.restaurant_id, map)
    }
    map.set(row.role_slug, (row.permissions ?? []) as string[])
  }

  console.log('=== Production fallback path check ===\n')

  let missingRows = 0
  let mismatches = 0

  for (const restaurant of restaurants ?? []) {
    const roleMap = byRestaurant.get(restaurant.id) ?? new Map()

    for (const slug of ROLE_SLUGS) {
      const dbPerms = roleMap.get(slug)
      const jsonPerms = expected[slug] ?? []

      if (!dbPerms) {
        missingRows++
        console.log(`${restaurant.name} / ${slug}: MISSING ROW (would JSON-fallback)`)
        continue
      }

      const match = JSON.stringify(sorted(dbPerms)) === JSON.stringify(sorted(jsonPerms))
      console.log(
        `${restaurant.name} / ${slug}: ${match ? 'DB row OK' : 'MISMATCH'} (${dbPerms.length} perms)`,
      )
      if (!match) mismatches++
    }
  }

  console.log(`\nRestaurants: ${restaurants?.length ?? 0}`)
  console.log(`Missing restaurant_roles rows: ${missingRows}`)
  console.log(`Permission mismatches vs JSON: ${mismatches}`)

  if (missingRows > 0 || mismatches > 0) {
    process.exit(1)
  }

  console.log(
    `Checked ${restaurants?.length ?? 0} restaurants × ${ROLE_SLUGS.length} roles — no fallback path would trigger.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
