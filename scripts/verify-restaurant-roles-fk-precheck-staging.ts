/**
 * Pre-migration FK violation check (staging).
 *   npx tsx scripts/verify-restaurant-roles-fk-precheck-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging')

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Violation = { table: string; restaurant_id: string; role: string; count: number }

async function findViolations(table: 'restaurant_users' | 'staff_invites' | 'staff_members') {
  const { data: rows, error } = await admin.from(table).select('restaurant_id, role')
  if (error) throw error

  const { data: roles, error: rolesError } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug')
  if (rolesError) throw rolesError

  const roleSet = new Set((roles ?? []).map((r) => `${r.restaurant_id}:${r.role_slug}`))
  const violations: Violation[] = []
  const grouped = new Map<string, number>()

  for (const row of rows ?? []) {
    const restaurantId = row.restaurant_id as string | null
    const role = row.role as string | null
    if (!restaurantId || !role) continue
    const key = `${restaurantId}:${role}`
    if (!roleSet.has(key)) {
      grouped.set(`${table}|${key}`, (grouped.get(`${table}|${key}`) ?? 0) + 1)
    }
  }

  for (const [compound, count] of grouped) {
    const [tbl, pair] = compound.split('|')
    const [restaurant_id, role] = pair.split(':')
    violations.push({ table: tbl, restaurant_id, role, count })
  }
  return violations
}

async function main() {
  console.log('=== Step 0/1.3: FK precheck (staging) ===\n')

  const tables = ['restaurant_users', 'staff_invites', 'staff_members'] as const
  for (const table of tables) {
    const { data, error } = await admin.from(table).select('*').limit(1)
    if (error) throw error
    console.log(`\n--- ${table} columns (sample keys) ---`)
    console.log(Object.keys(data?.[0] ?? {}).sort().join(', ') || '(empty table)')
  }

  const all: Violation[] = []
  for (const t of tables) {
    all.push(...(await findViolations(t)))
  }

  console.log('\n--- Violations (missing restaurant_roles match) ---')
  if (all.length === 0) {
    console.log('NONE — safe to apply composite FK migration')
  } else {
    console.log(JSON.stringify(all, null, 2))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
