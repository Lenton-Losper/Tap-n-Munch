/**
 * Staging verification: refund_events ledger migration.
 *   npx tsx scripts/verify-refund-events-staging.ts
 */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STAGING_PROJECT_REF, runShellCommand } from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const EXPECTED_COLUMNS = [
  'id',
  'restaurant_id',
  'order_id',
  'payment_id',
  'amount',
  'reason',
  'refunded_by',
  'idempotency_key',
  'status',
  'created_at',
  'refund_method',
  'gateway_reference',
]

const EXPECTED_INDEXES = ['idx_refund_events_order_id', 'idx_refund_events_payment_id']

const EXPECTED_POLICIES = [
  ['refund_events', 'staff_view_refund_events', 'SELECT'],
  ['refund_events', 'staff_insert_refund_events', 'INSERT'],
]

type Row = Record<string, unknown>

function runQuery(sql: string): Row[] {
  const tmp = join(process.cwd(), 'supabase', '.temp', `_refund_events_q_${Date.now()}.sql`)
  writeFileSync(tmp, sql, 'utf8')
  try {
    const raw = execSync(`npx supabase db query --linked -f "${tmp}" -o json`, {
      encoding: 'utf8',
      shell: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh',
    })
    const match = raw.match(/\{[\s\S]*"rows"[\s\S]*\}/)
    if (!match) return []
    const parsed = JSON.parse(match[0]) as { rows?: Row[] }
    return parsed.rows ?? []
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function main() {
  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)

  const tableExists = runQuery(`
SELECT to_regclass('public.refund_events') AS refund_events;
`)

  const columns = runQuery(`
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'refund_events'
ORDER BY ordinal_position;
`)

  const indexes = runQuery(`
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'refund_events'
ORDER BY indexname;
`)

  const constraints = runQuery(`
SELECT con.conname, con.contype
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public' AND rel.relname = 'refund_events'
ORDER BY con.conname;
`)

  const rls = runQuery(`
SELECT c.relname AS table_name, c.relrowsecurity AS enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'refund_events';
`)

  const policies = runQuery(`
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'refund_events'
ORDER BY policyname;
`)

  const paymentsUnchanged = runQuery(`
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'payments'
ORDER BY ordinal_position;
`)

  const report = {
    tableExists: tableExists[0]?.refund_events === 'refund_events',
    columns: columns.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable,
    })),
    indexes: indexes.map((r) => r.indexname),
    constraints: constraints.map((c) => ({ name: c.conname, type: c.contype })),
    rlsEnabled: rls[0]?.enabled === true,
    policies: policies.map((p) => [p.tablename, p.policyname, p.cmd]),
    paymentsColumnCount: paymentsUnchanged.length,
    paymentsHasRefundColumn: paymentsUnchanged.some((c) =>
      String(c.column_name).includes('refund'),
    ),
  }

  console.log(JSON.stringify(report, null, 2))

  const columnNames = new Set(columns.map((c) => String(c.column_name)))
  const indexNames = new Set(indexes.map((r) => String(r.indexname)))
  const policySet = new Set(policies.map((p) => `${p.tablename}:${p.policyname}:${p.cmd}`))

  const pass =
    report.tableExists &&
    EXPECTED_COLUMNS.every((col) => columnNames.has(col)) &&
    EXPECTED_INDEXES.every((idx) => indexNames.has(idx)) &&
    constraints.some(
      (c) => c.conname === 'refund_events_idempotency_key_unique' && c.contype === 'u',
    ) &&
    constraints.some((c) => c.conname === 'refund_events_amount_check' && c.contype === 'c') &&
    constraints.some((c) => c.conname === 'refund_events_status_check' && c.contype === 'c') &&
    constraints.some(
      (c) => c.conname === 'refund_events_refund_method_check' && c.contype === 'c',
    ) &&
    constraints.some(
      (c) => c.conname === 'refund_events_gateway_reference_check' && c.contype === 'c',
    ) &&
    report.rlsEnabled &&
    EXPECTED_POLICIES.every(([t, p, c]) => policySet.has(`${t}:${p}:${c}`)) &&
    report.paymentsHasRefundColumn === false

  if (!pass) {
    console.error('REFUND_EVENTS_STAGING_VERIFY_FAIL')
    process.exitCode = 1
  } else {
    console.log('REFUND_EVENTS_STAGING_VERIFY_OK')
  }
}

main()
