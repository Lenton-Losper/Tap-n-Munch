/**
 * Production: apply Settings permission migrations + seed fidelity report.
 *   npx tsx scripts/apply-settings-permissions-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { PERMISSIONS } from '../lib/permissions'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const WATCH_KEYS = [
  PERMISSIONS.PAYMENTS_VIEW,
  PERMISSIONS.PAYMENTS_CONFIGURE,
  PERMISSIONS.SETTINGS_WRITE,
] as const

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
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

type RoleRow = {
  restaurant_id: string
  role_slug: string
  permissions: string[] | null
}

function sorted(arr: string[]) {
  return [...arr].sort()
}

function expectedFromJson(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([k]) => !k.startsWith('$')),
  ) as Record<string, string[]>
}

function watchSnapshot(rows: RoleRow[]) {
  const byRestaurant = new Map<
    string,
    Record<string, { paymentsView: boolean; paymentsConfigure: boolean; settingsWrite: boolean }>
  >()

  for (const row of rows) {
    const perms = (row.permissions ?? []) as string[]
    const restaurant = byRestaurant.get(row.restaurant_id) ?? {}
    restaurant[row.role_slug] = {
      paymentsView: perms.includes(PERMISSIONS.PAYMENTS_VIEW),
      paymentsConfigure: perms.includes(PERMISSIONS.PAYMENTS_CONFIGURE),
      settingsWrite: perms.includes(PERMISSIONS.SETTINGS_WRITE),
    }
    byRestaurant.set(row.restaurant_id, restaurant)
  }
  return byRestaurant
}

async function fetchRoles() {
  const { data, error } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
  if (error) throw error
  return (data ?? []) as RoleRow[]
}

async function applyPaymentsMigration() {
  const { data: owners, error } = await admin
    .from('restaurant_roles')
    .select('id, permissions')
    .eq('role_slug', 'owner')
  if (error) throw error

  let updated = 0
  for (const row of owners ?? []) {
    const perms = [...((row.permissions as string[]) ?? [])]
    let changed = false
    if (!perms.includes(PERMISSIONS.PAYMENTS_VIEW)) {
      perms.push(PERMISSIONS.PAYMENTS_VIEW)
      changed = true
    }
    if (!perms.includes(PERMISSIONS.PAYMENTS_CONFIGURE)) {
      perms.push(PERMISSIONS.PAYMENTS_CONFIGURE)
      changed = true
    }
    if (changed) {
      const { error: uerr } = await admin
        .from('restaurant_roles')
        .update({ permissions: perms })
        .eq('id', row.id)
      if (uerr) throw uerr
      updated++
    }
  }
  return { ownerRows: owners?.length ?? 0, updated }
}

async function applyManagerSettingsWriteMigration() {
  const { data: managers, error } = await admin
    .from('restaurant_roles')
    .select('id, permissions')
    .eq('role_slug', 'manager')
  if (error) throw error

  let updated = 0
  for (const row of managers ?? []) {
    const perms = [...((row.permissions as string[]) ?? [])]
    if (!perms.includes(PERMISSIONS.SETTINGS_WRITE)) {
      perms.push(PERMISSIONS.SETTINGS_WRITE)
      const { error: uerr } = await admin
        .from('restaurant_roles')
        .update({ permissions: perms })
        .eq('id', row.id)
      if (uerr) throw uerr
      updated++
    }
  }
  return { managerRows: managers?.length ?? 0, updated }
}

async function main() {
  console.log('=== Settings permissions production migration ===')
  console.log(`Project ref: ${PROD_REF}`)
  console.log(`Supabase URL: ${url}\n`)

  const { data: restaurants, error: restaurantsError } = await admin
    .from('restaurants')
    .select('id, name')
    .order('name')
  if (restaurantsError) throw restaurantsError

  const beforeRows = await fetchRoles()
  const before = watchSnapshot(beforeRows)

  console.log('--- PRE-MIGRATION watch keys ---')
  for (const restaurant of restaurants ?? []) {
    const roles = before.get(restaurant.id) ?? {}
    console.log(`\n${restaurant.name} (${restaurant.id})`)
    for (const slug of ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar']) {
      const r = roles[slug]
      if (!r) {
        console.log(`  ${slug}: (no row)`)
        continue
      }
      console.log(
        `  ${slug}: payments:view=${r.paymentsView} payments:configure=${r.paymentsConfigure} settings:write=${r.settingsWrite}`,
      )
    }
  }

  console.log('\n--- Applying migration 20260705120000 (owner payments:view/configure) ---')
  const paymentsResult = await applyPaymentsMigration()
  console.log(JSON.stringify(paymentsResult))

  console.log('\n--- Applying migration 20260705130000 (manager settings:write) ---')
  const managerResult = await applyManagerSettingsWriteMigration()
  console.log(JSON.stringify(managerResult))

  const afterRows = await fetchRoles()
  const after = watchSnapshot(afterRows)
  const expected = expectedFromJson()

  console.log('\n--- PER-RESTAURANT DIFF (watch keys + full JSON fidelity) ---')
  let allOk = true
  const report: Array<Record<string, unknown>> = []

  for (const restaurant of restaurants ?? []) {
    const beforeRoles = before.get(restaurant.id) ?? {}
    const afterRoles = after.get(restaurant.id) ?? {}
    const dbRoles = afterRows.filter((r) => r.restaurant_id === restaurant.id)

    const ownerBefore = beforeRoles.owner
    const ownerAfter = afterRoles.owner
    const managerBefore = beforeRoles.manager
    const managerAfter = afterRoles.manager

    const ownerOk =
      ownerAfter?.paymentsView === true && ownerAfter?.paymentsConfigure === true
    const managerOk = managerAfter?.settingsWrite === true

    let nonPrivilegedLeak = false
    for (const slug of ['cashier', 'waiter', 'kitchen', 'bar'] as const) {
      const r = afterRoles[slug]
      if (!r) continue
      if (r.paymentsView || r.paymentsConfigure || r.settingsWrite) {
        nonPrivilegedLeak = true
      }
    }

    let jsonFidelityOk = true
    const roleDiffs: Array<{ slug: string; ok: boolean; db: string[]; json: string[] }> = []
    for (const slug of Object.keys(expected)) {
      const dbRow = dbRoles.find((r) => r.role_slug === slug)
      const dbPerms = sorted((dbRow?.permissions as string[]) ?? [])
      const jsonPerms = sorted(expected[slug] ?? [])
      const ok = JSON.stringify(dbPerms) === JSON.stringify(jsonPerms)
      if (!ok) jsonFidelityOk = false
      roleDiffs.push({ slug, ok, db: dbPerms, json: jsonPerms })
    }

    const restaurantOk = ownerOk && managerOk && !nonPrivilegedLeak && jsonFidelityOk
    if (!restaurantOk) allOk = false

    const entry = {
      restaurant: restaurant.name,
      id: restaurant.id,
      pass: restaurantOk,
      owner: {
        before: ownerBefore,
        after: ownerAfter,
        paymentsAdded:
          (!ownerBefore?.paymentsView && ownerAfter?.paymentsView) ||
          (!ownerBefore?.paymentsConfigure && ownerAfter?.paymentsConfigure),
      },
      manager: {
        before: managerBefore,
        after: managerAfter,
        settingsWriteAdded: !managerBefore?.settingsWrite && managerAfter?.settingsWrite,
      },
      nonPrivilegedLeak,
      jsonFidelityOk,
      mismatchedRoles: roleDiffs.filter((r) => !r.ok).map((r) => r.slug),
    }
    report.push(entry)

    console.log(`\n${restaurantOk ? 'PASS' : 'FAIL'} | ${restaurant.name}`)
    console.log(
      `  owner payments:view ${ownerBefore?.paymentsView ?? false} -> ${ownerAfter?.paymentsView ?? false}`,
    )
    console.log(
      `  owner payments:configure ${ownerBefore?.paymentsConfigure ?? false} -> ${ownerAfter?.paymentsConfigure ?? false}`,
    )
    console.log(
      `  manager settings:write ${managerBefore?.settingsWrite ?? false} -> ${managerAfter?.settingsWrite ?? false}`,
    )
    console.log(`  non-privileged leak (cashier/waiter/kitchen/bar): ${nonPrivilegedLeak ? 'YES' : 'no'}`)
    if (!jsonFidelityOk) {
      for (const d of roleDiffs.filter((r) => !r.ok)) {
        console.log(`  JSON mismatch ${d.slug}:`)
        console.log(`    DB:   ${JSON.stringify(d.db)}`)
        console.log(`    JSON: ${JSON.stringify(d.json)}`)
      }
    }
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Restaurants: ${restaurants?.length ?? 0}`)
  console.log(`Payments migration updated owner rows: ${paymentsResult.updated}/${paymentsResult.ownerRows}`)
  console.log(
    `Manager migration updated manager rows: ${managerResult.updated}/${managerResult.managerRows}`,
  )
  console.log(`Overall: ${allOk ? 'ALL PASS' : 'FAILURES DETECTED'}`)
  console.log('\nJSON report:')
  console.log(JSON.stringify(report, null, 2))

  if (!allOk) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
