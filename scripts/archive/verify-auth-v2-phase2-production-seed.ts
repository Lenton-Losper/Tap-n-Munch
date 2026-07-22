/**
 * Production seed fidelity report for Authorization v2 Phase 2.
 *   npx tsx scripts/verify-auth-v2-phase2-production-seed.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

if (!url.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error(`Refusing to run: SUPABASE_URL is not production (${url})`)
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function expectedFromJson(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
  ) as Record<string, string[]>
}

function sorted(arr: string[]): string[] {
  return [...arr].sort()
}

async function main() {
  console.log('=== Auth v2 Phase 2 production seed fidelity ===')
  console.log(`Supabase: ${url}\n`)

  const expected = expectedFromJson()
  const roleSlugs = Object.keys(expected).sort()

  const { data: restaurants, error: restaurantsError } = await admin
    .from('restaurants')
    .select('id, name')
    .order('name')

  if (restaurantsError) throw restaurantsError

  const { data: rows, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, display_name, permissions, is_system')
    .order('role_slug')

  if (rolesError) throw rolesError

  const byRestaurant = new Map<string, NonNullable<typeof rows>>()
  for (const row of rows ?? []) {
    const list = byRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    byRestaurant.set(row.restaurant_id, list)
  }

  let allOk = true
  const summary: Array<{
    name: string
    id: string
    roleCount: number
    ok: boolean
    roles: Array<{ slug: string; ok: boolean; details: string }>
  }> = []

  for (const restaurant of restaurants ?? []) {
    const roles = byRestaurant.get(restaurant.id) ?? []
    const roleResults: Array<{ slug: string; ok: boolean; details: string }> = []

    console.log(`\n--- ${restaurant.name} (${restaurant.id}) ---`)
    console.log(`Row count: ${roles.length} (expected 6)`)

    if (roles.length !== 6) {
      allOk = false
      console.log(`MISMATCH: expected 6 roles, found ${roles.length}`)
      console.log(`Present slugs: ${roles.map((r) => r.role_slug).sort().join(', ') || '(none)'}`)
    }

    for (const slug of roleSlugs) {
      const dbRow = roles.find((r) => r.role_slug === slug)
      const jsonPerms = sorted(expected[slug] ?? [])
      const expectedIsSystem = slug === 'owner'

      if (!dbRow) {
        allOk = false
        roleResults.push({ slug, ok: false, details: 'MISSING ROW' })
        console.log(`  ${slug}: MISSING ROW`)
        console.log(`    expected permissions: ${JSON.stringify(jsonPerms)}`)
        continue
      }

      const dbPerms = sorted((dbRow.permissions as string[]) ?? [])
      const permsMatch = JSON.stringify(dbPerms) === JSON.stringify(jsonPerms)
      const isSystemOk = dbRow.is_system === expectedIsSystem

      const ok = permsMatch && isSystemOk
      if (!ok) allOk = false

      if (ok) {
        roleResults.push({
          slug,
          ok: true,
          details: `permissions=${JSON.stringify(dbPerms)} is_system=${dbRow.is_system}`,
        })
        console.log(`  ${slug}: MATCH`)
        console.log(`    permissions: ${JSON.stringify(dbPerms)}`)
        console.log(`    is_system: ${dbRow.is_system}`)
        console.log(`    display_name: ${dbRow.display_name}`)
      } else {
        roleResults.push({ slug, ok: false, details: 'PERMISSION OR is_system MISMATCH' })
        console.log(`  ${slug}: MISMATCH`)
        console.log(`    DB permissions:      ${JSON.stringify(dbPerms)}`)
        console.log(`    JSON permissions:    ${JSON.stringify(jsonPerms)}`)
        console.log(`    DB is_system:        ${dbRow.is_system}`)
        console.log(`    Expected is_system:  ${expectedIsSystem}`)
        console.log(`    display_name:        ${dbRow.display_name}`)
      }
    }

    summary.push({
      name: String(restaurant.name),
      id: restaurant.id,
      roleCount: roles.length,
      ok: roles.length === 6 && roleResults.every((r) => r.ok),
      roles: roleResults,
    })
  }

  console.log('\n=== SUMMARY TABLE ===')
  for (const row of summary) {
    console.log(
      `${row.ok ? 'PASS' : 'FAIL'} | ${row.name} | roles=${row.roleCount}/6 | ${row.id}`,
    )
  }

  console.log(`\nRestaurants checked: ${summary.length}`)
  console.log(`Overall: ${allOk ? 'ALL PASS' : 'FAILURES DETECTED'}`)

  if (!allOk) process.exit(1)
}

main().catch((error) => {
  console.error('\nVerification failed:', error)
  process.exit(1)
})
