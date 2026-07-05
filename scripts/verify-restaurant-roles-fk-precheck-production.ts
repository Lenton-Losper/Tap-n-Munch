/**
 * Production FK precheck before Phase 4A composite FK migration.
 *   npx tsx scripts/verify-restaurant-roles-fk-precheck-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.production.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(PROD_REF)) {
  throw new Error(`Refusing: not production Supabase (${url})`)
}
if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type ViolationRow = {
  table: string
  restaurant_id: string
  restaurant_name: string
  role: string
  row_count: number
}

async function findViolations(table: 'restaurant_users' | 'staff_invites' | 'staff_members') {
  const { data: rows, error } = await admin.from(table).select('restaurant_id, role')
  if (error) throw error

  const { data: restaurants, error: restErr } = await admin.from('restaurants').select('id, name')
  if (restErr) throw restErr
  const nameById = new Map((restaurants ?? []).map((r) => [r.id, r.name]))

  const { data: roles, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug')
  if (rolesError) throw rolesError

  const roleSet = new Set((roles ?? []).map((r) => `${r.restaurant_id}:${r.role_slug}`))
  const grouped = new Map<string, number>()

  for (const row of rows ?? []) {
    const restaurantId = String(row.restaurant_id || '')
    const role = String(row.role || '')
    if (!restaurantId || !role) continue
    const key = `${table}|${restaurantId}|${role}`
    if (!roleSet.has(`${restaurantId}:${role}`)) {
      grouped.set(key, (grouped.get(key) ?? 0) + 1)
    }
  }

  const violations: ViolationRow[] = []
  for (const [compound, row_count] of grouped) {
    const [tbl, restaurant_id, role] = compound.split('|')
    violations.push({
      table: tbl,
      restaurant_id,
      restaurant_name: nameById.get(restaurant_id) ?? '(unknown)',
      role,
      row_count,
    })
  }
  return violations
}

async function main() {
  console.log('=== Phase 4A FK precheck (PRODUCTION) ===')
  console.log(`Supabase ref: ${PROD_REF}\n`)

  const { data: restaurants, error: restErr } = await admin
    .from('restaurants')
    .select('id, name')
    .order('name')
  if (restErr) throw restErr

  console.log(`Restaurants: ${restaurants?.length ?? 0}`)
  for (const r of restaurants ?? []) {
    console.log(`  - ${r.name} (${r.id})`)
  }

  const { count: roleRowCount } = await admin
    .from('restaurant_roles')
    .select('id', { count: 'exact', head: true })

  console.log(`\nrestaurant_roles rows: ${roleRowCount ?? 0} (expected 60 for 10 restaurants × 6 roles)`)

  const tables = ['restaurant_users', 'staff_invites', 'staff_members'] as const
  const tableCounts: Record<string, number> = {}

  for (const table of tables) {
    const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true })
    if (error) throw error
    tableCounts[table] = count ?? 0
    console.log(`${table} rows: ${count ?? 0}`)
  }

  const all: ViolationRow[] = []
  for (const t of tables) {
    all.push(...(await findViolations(t)))
  }

  console.log('\n--- FK violations (missing restaurant_roles match) ---')
  if (all.length === 0) {
    console.log('NONE — zero violations across all 10 restaurants')
    console.log('PHASE4A_FK_PRECHECK_PRODUCTION_OK')
  } else {
    console.log(JSON.stringify(all, null, 2))
    console.error(`PHASE4A_FK_PRECHECK_PRODUCTION_FAIL (${all.length} violation groups)`)
    process.exitCode = 1
  }

  console.log('\n--- Summary ---')
  console.log(
    JSON.stringify(
      {
        restaurantCount: restaurants?.length ?? 0,
        restaurantRolesRows: roleRowCount,
        tableCounts,
        violationCount: all.length,
        violations: all,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
