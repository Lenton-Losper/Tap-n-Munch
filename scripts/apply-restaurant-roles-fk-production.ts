/**
 * Production: apply Phase 4A composite FK migration (after precheck passes).
 *   npx tsx scripts/apply-restaurant-roles-fk-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { authorize } from '../lib/permissions/authorize'
import { PERMISSIONS } from '../lib/permissions'
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const MIGRATION = 'supabase/migrations/20260705140000_restaurant_roles_composite_fk.sql'
const SNAPSHOT_PATH = join('supabase', '.temp', 'phase4a-fk-production-pre-snapshot.json')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase (.env.production.local)')
}

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const REGRESSION_PERMS = [
  PERMISSIONS.STAFF_MANAGE,
  PERMISSIONS.STOCK_VIEW,
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.SETTINGS_READ,
  PERMISSIONS.ORDERS_READ,
] as const

async function buildSnapshot() {
  const tables = ['restaurant_users', 'staff_invites', 'staff_members'] as const
  const tableCounts: Record<string, number> = {}
  for (const table of tables) {
    const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true })
    if (error) throw error
    tableCounts[table] = count ?? 0
  }

  const { data: assignments, error } = await admin
    .from('restaurant_users')
    .select('user_id, restaurant_id, role')
    .is('deleted_at', null)
  if (error) throw error

  const authorizeMatrix: Record<string, boolean> = {}
  for (const row of assignments ?? []) {
    const userId = String(row.user_id)
    const restaurantId = String(row.restaurant_id)
    for (const perm of REGRESSION_PERMS) {
      const key = `${userId}|${restaurantId}|${perm}`
      authorizeMatrix[key] = await authorize(userId, restaurantId, perm)
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    tableCounts,
    authorizeMatrix,
    assignmentCount: assignments?.length ?? 0,
  }
}

async function main() {
  console.log('=== Phase 4A FK apply (PRODUCTION) ===')
  console.log(`Expected ref: ${PRODUCTION_PROJECT_REF}\n`)

  const snapshot = await buildSnapshot()
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`Pre-migration snapshot written: ${SNAPSHOT_PATH}`)
  console.log(JSON.stringify(snapshot, null, 2))

  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', MIGRATION])
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    '20260705140000',
  ])

  console.log('RESTAURANT_ROLES_FK_PRODUCTION_OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
