/**
 * Production seed fidelity for Phase 4B is_invite_eligible.
 *   npx tsx scripts/verify-phase4b-production-seed.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.production.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const INVITE_ELIGIBLE = new Set(['manager', 'waiter'])
const SYSTEM_ROLES = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'] as const

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(PROD_REF)) {
  throw new Error(`Refusing: SUPABASE_URL is not production (${url})`)
}
if (!serviceKey) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env.production.local')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: restaurants, error: restErr } = await admin
    .from('restaurants')
    .select('id, name')
    .order('name')

  if (restErr) throw restErr

  const { data: rows, error: rolesErr } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, is_invite_eligible, is_system, permissions, display_name')
    .order('role_slug')

  if (rolesErr) throw rolesErr

  const byRestaurant = new Map<string, NonNullable<typeof rows>>()
  for (const row of rows ?? []) {
    const list = byRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    byRestaurant.set(row.restaurant_id, list)
  }

  const violations: string[] = []
  const report: Array<{
    name: string
    id: string
    roleCount: number
    inviteEligible: string[]
    ok: boolean
  }> = []

  console.log('=== Phase 4B production seed fidelity (is_invite_eligible) ===\n')
  console.log(`Restaurants: ${restaurants?.length ?? 0}`)
  console.log(`Total restaurant_roles rows: ${rows?.length ?? 0}\n`)

  for (const restaurant of restaurants ?? []) {
    const roles = byRestaurant.get(restaurant.id) ?? []
    const inviteEligible = roles
      .filter((r) => r.is_invite_eligible)
      .map((r) => r.role_slug)
      .sort()

    let ok = true

    if (roles.length !== 6) {
      violations.push(`${restaurant.name}: expected 6 roles, got ${roles.length}`)
      ok = false
    }

    for (const slug of SYSTEM_ROLES) {
      const row = roles.find((r) => r.role_slug === slug)
      if (!row) {
        violations.push(`${restaurant.name}: missing role ${slug}`)
        ok = false
        continue
      }
      const shouldInvite = INVITE_ELIGIBLE.has(slug)
      if (Boolean(row.is_invite_eligible) !== shouldInvite) {
        violations.push(
          `${restaurant.name}:${slug} is_invite_eligible=${row.is_invite_eligible}, expected ${shouldInvite}`,
        )
        ok = false
      }
    }

    for (const row of roles) {
      if (!SYSTEM_ROLES.includes(row.role_slug as (typeof SYSTEM_ROLES)[number])) {
        if (row.is_invite_eligible) {
          violations.push(
            `${restaurant.name}: custom role ${row.role_slug} must not be invite-eligible by default`,
          )
          ok = false
        }
      }
    }

    report.push({
      name: restaurant.name,
      id: restaurant.id,
      roleCount: roles.length,
      inviteEligible,
      ok,
    })

    console.log(
      `${ok ? 'OK' : 'FAIL'}  ${restaurant.name} — roles=${roles.length}, invite-eligible=[${inviteEligible.join(', ')}]`,
    )
  }

  const unexpectedEligible = (rows ?? []).filter(
    (r) => r.is_invite_eligible && !INVITE_ELIGIBLE.has(r.role_slug),
  )
  if (unexpectedEligible.length > 0) {
    for (const r of unexpectedEligible) {
      violations.push(`Unexpected invite-eligible: ${r.restaurant_id}:${r.role_slug}`)
    }
  }

  console.log('\n--- Summary ---')
  console.log(JSON.stringify({ restaurantCount: restaurants?.length, report, violations }, null, 2))

  if (violations.length === 0) {
    console.log('\nPHASE4B_PRODUCTION_SEED_OK')
  } else {
    console.error('\nPHASE4B_PRODUCTION_SEED_FAIL')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
