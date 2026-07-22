/**
 * Staging only: add orders:amend + orders:refund to manager restaurant_roles rows.
 *   npx tsx scripts/apply-manager-amend-refund-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { STAGING_PROJECT_REF, runShellCommand } from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const MIGRATION = 'supabase/migrations/20260705260000_manager_orders_amend_refund_permissions.sql'

async function listManagerRows(label: string) {
  const { data, error } = await admin
    .from('restaurant_roles')
    .select('id, restaurant_id, role_slug, permissions')
    .eq('role_slug', 'manager')
    .order('restaurant_id')

  if (error) throw error

  console.log(`\n=== ${label} (${data?.length ?? 0} manager row(s)) ===`)
  for (const row of data ?? []) {
    const perms = [...((row.permissions as string[]) ?? [])]
    console.log(
      JSON.stringify(
        {
          restaurant_id: row.restaurant_id,
          permissions: perms,
          orders_amend: perms.includes('orders:amend'),
          orders_refund: perms.includes('orders:refund'),
        },
        null,
        2,
      ),
    )
  }
}

async function main() {
  console.log('permissions column: text[] (PostgreSQL array — use = ANY(permissions) + array_append)')

  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)

  await listManagerRows('BEFORE update')

  runShellCommand(`npx supabase db query --linked -f "${MIGRATION}"`)

  await listManagerRows('AFTER update')

  console.log('\nMANAGER_AMEND_REFUND_STAGING_SYNC_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
