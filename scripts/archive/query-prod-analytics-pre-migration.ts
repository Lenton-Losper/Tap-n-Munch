import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error('Not production')
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data: restaurants } = await admin.from('restaurants').select('id, name').order('name')
  console.log(`Restaurant count: ${restaurants?.length ?? 0}`)
  for (const r of restaurants ?? []) {
    console.log(`  - ${r.name} (${r.id})`)
  }

  const { data: roles } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .in('role_slug', ['owner', 'manager', 'kitchen', 'waiter', 'cashier', 'bar'])

  const byRest = new Map<string, Record<string, boolean>>()
  for (const row of roles ?? []) {
    const map = byRest.get(row.restaurant_id) ?? {}
    map[row.role_slug] = (row.permissions as string[])?.includes('analytics:view') ?? false
    byRest.set(row.restaurant_id, map)
  }

  console.log('\n=== analytics:view by restaurant (pre/post check) ===')
  for (const r of restaurants ?? []) {
    const map = byRest.get(r.id) ?? {}
    console.log(`${r.name}:`)
    console.log(`  owner=${map.owner ?? '?'} manager=${map.manager ?? '?'} kitchen=${map.kitchen ?? '?'} waiter=${map.waiter ?? '?'} cashier=${map.cashier ?? '?'} bar=${map.bar ?? '?'}`)
  }
}

main().catch(console.error)
