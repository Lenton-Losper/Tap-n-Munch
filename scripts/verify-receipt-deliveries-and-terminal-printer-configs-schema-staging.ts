/**
 * Staging verification: receipt_deliveries + terminal_printer_configs schema (Phase 2).
 *   npx tsx scripts/verify-receipt-deliveries-and-terminal-printer-configs-schema-staging.ts
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

type Row = Record<string, unknown>

function runQuery(sql: string): Row[] {
  const tmp = join(process.cwd(), 'supabase', '.temp', `_receipt_deliveries_q_${Date.now()}.sql`)
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

function tableReport(table: string) {
  const tableExists = runQuery(`SELECT to_regclass('public.${table}') AS t;`)
  const columns = runQuery(`
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position;
`)
  const rls = runQuery(`
SELECT c.relrowsecurity AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = '${table}';
`)
  const policies = runQuery(`
SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' ORDER BY policyname;
`)
  return {
    exists: tableExists[0]?.t === table,
    columns: columns.map((c) => String(c.column_name)),
    rlsEnabled: rls[0]?.enabled === true,
    policies: policies.map((p) => `${p.policyname}:${p.cmd}`),
  }
}

function main() {
  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)

  const deliveries = tableReport('receipt_deliveries')
  const printerConfigs = tableReport('terminal_printer_configs')

  console.log(JSON.stringify({ deliveries, printerConfigs }, null, 2))

  const EXPECTED_DELIVERIES_COLUMNS = [
    'id', 'receipt_document_id', 'method', 'destination', 'status', 'attempt_number',
    'provider', 'provider_reference', 'device_id', 'requested_by', 'error_code',
    'error_message', 'requested_at', 'completed_at', 'created_at',
  ]
  const EXPECTED_PRINTER_CONFIG_COLUMNS = [
    'id', 'terminal_id', 'purpose', 'connection_type', 'printer_name', 'printer_address',
    'paper_width_mm', 'character_width', 'is_default', 'last_connected_at', 'created_at',
    'updated_at',
  ]

  const deliveriesColSet = new Set(deliveries.columns)
  const printerColSet = new Set(printerConfigs.columns)

  const pass =
    deliveries.exists &&
    EXPECTED_DELIVERIES_COLUMNS.every((c) => deliveriesColSet.has(c)) &&
    deliveries.rlsEnabled &&
    deliveries.policies.length === 1 &&
    deliveries.policies[0].endsWith(':SELECT') &&
    printerConfigs.exists &&
    EXPECTED_PRINTER_CONFIG_COLUMNS.every((c) => printerColSet.has(c)) &&
    printerConfigs.rlsEnabled &&
    printerConfigs.policies.length === 1 &&
    printerConfigs.policies[0].endsWith(':SELECT')

  if (!pass) {
    console.error('RECEIPT_DELIVERIES_AND_TERMINAL_PRINTER_CONFIGS_SCHEMA_STAGING_VERIFY_FAIL')
    process.exitCode = 1
  } else {
    console.log('RECEIPT_DELIVERIES_AND_TERMINAL_PRINTER_CONFIGS_SCHEMA_STAGING_VERIFY_OK')
  }
}

main()
