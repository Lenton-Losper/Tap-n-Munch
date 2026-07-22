import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.local'), override: true })

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url?.includes('ihlmmpmolnpchzgwyhgh')) {
  console.log('SKIP: production credentials not loaded from .env.local')
  process.exit(0)
}

const admin = createClient(url, key!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  console.log('=== PRODUCTION: non-owner/manager roles with analytics:view ===')
  const { data: polluted } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .not('role_slug', 'in', '("owner","manager")')

  const bad = (polluted ?? []).filter((r) =>
    (r.permissions as string[] | null)?.includes('analytics:view'),
  )
  if (bad.length === 0) {
    console.log('  NONE — kitchen/waiter/cashier/bar have no analytics:view (migration not applied or correct)')
  } else {
    for (const row of bad) {
      console.log(`  POLLUTED: restaurant=${row.restaurant_id} role=${row.role_slug}`)
    }
  }

  const { data: omRoles } = await admin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
    .in('role_slug', ['owner', 'manager'])

  const withAnalytics = (omRoles ?? []).filter((r) =>
    (r.permissions as string[] | null)?.includes('analytics:view'),
  )
  console.log(`\nowner/manager rows with analytics:view: ${withAnalytics.length} / ${omRoles?.length ?? 0}`)
  console.log('(0 means analytics migration has NOT been applied on production)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
