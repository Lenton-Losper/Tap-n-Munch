/**
 * Production post-migration verification for Phase 4A composite FK.
 *   npx tsx scripts/verify-restaurant-roles-fk-post-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { authorize } from '../lib/permissions/authorize'
import { PERMISSIONS } from '../lib/permissions'
import {
  PRODUCTION_PROJECT_REF,
  readLinkedProjectRef,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const SNAPSHOT_PATH = join('supabase', '.temp', 'phase4a-fk-production-pre-snapshot.json')
const CONSTRAINT_SQL = 'supabase/.temp/phase4a-fk-constraint-audit.sql'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase')
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

type PreSnapshot = {
  tableCounts: Record<string, number>
  authorizeMatrix: Record<string, boolean>
  assignmentCount: number
}

async function buildPostSnapshot() {
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

  return { tableCounts, authorizeMatrix, assignmentCount: assignments?.length ?? 0 }
}

function parseConstraintAudit(stdout: string) {
  const lines = stdout.split('\n').filter((l) => l.trim())
  const constraints: Array<{ table: string; name: string; type: string }> = []
  for (const line of lines) {
    const match = line.match(/(restaurant_users|staff_invites|staff_members)\s+\|\s+(\S+)\s+\|\s+(\w)/)
    if (match) {
      constraints.push({ table: match[1], name: match[2], type: match[3] })
    }
  }
  return constraints
}

async function main() {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`Missing pre-snapshot: ${SNAPSHOT_PATH} — run apply script first`)
  }
  const pre: PreSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))

  console.log('=== Phase 4A FK post-verify (PRODUCTION) ===\n')

  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)

  const linkedRef = readLinkedProjectRef()
  if (linkedRef !== PRODUCTION_PROJECT_REF) {
    throw new Error(`SAFE-SUPABASE-LINKED ABORT: linked ${linkedRef} != ${PRODUCTION_PROJECT_REF}`)
  }
  const { execSync } = await import('child_process')
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const auditOut = execSync(`npx supabase db query --linked -f ${CONSTRAINT_SQL}`, {
    encoding: 'utf8',
    shell,
  })

  const auditText = String(auditOut)
  console.log('--- Constraint audit (raw) ---')
  console.log(auditText)

  const hasCheck = /restaurant_users_role_check|staff_invites_role_check|staff_members_role_check/.test(
    auditText,
  )
  const hasFk =
    auditText.includes('restaurant_users_role_slug_fkey') &&
    auditText.includes('staff_invites_role_slug_fkey') &&
    auditText.includes('staff_members_role_slug_fkey')

  const post = await buildPostSnapshot()

  const authorizeMismatches: string[] = []
  for (const [key, before] of Object.entries(pre.authorizeMatrix)) {
    const after = post.authorizeMatrix[key]
    if (after !== before) {
      authorizeMismatches.push(`${key}: before=${before} after=${after}`)
    }
  }
  for (const key of Object.keys(post.authorizeMatrix)) {
    if (!(key in pre.authorizeMatrix)) {
      authorizeMismatches.push(`${key}: new key after migration`)
    }
  }

  const countMismatches: string[] = []
  for (const table of ['restaurant_users', 'staff_invites', 'staff_members']) {
    if (pre.tableCounts[table] !== post.tableCounts[table]) {
      countMismatches.push(
        `${table}: before=${pre.tableCounts[table]} after=${post.tableCounts[table]}`,
      )
    }
  }

  const report = {
    constraints: {
      checkConstraintsRemoved: !hasCheck,
      compositeFksPresent: hasFk,
    },
    tableCounts: { before: pre.tableCounts, after: post.tableCounts, mismatches: countMismatches },
    authorize: {
      keysBefore: Object.keys(pre.authorizeMatrix).length,
      keysAfter: Object.keys(post.authorizeMatrix).length,
      mismatches: authorizeMismatches,
    },
    assignmentCount: { before: pre.assignmentCount, after: post.assignmentCount },
  }

  console.log('\n--- Report ---')
  console.log(JSON.stringify(report, null, 2))

  const pass =
    !hasCheck &&
    hasFk &&
    countMismatches.length === 0 &&
    authorizeMismatches.length === 0 &&
    pre.assignmentCount === post.assignmentCount

  if (!pass) {
    console.error('PHASE4A_FK_POST_VERIFY_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE4A_FK_POST_VERIFY_PRODUCTION_OK')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
