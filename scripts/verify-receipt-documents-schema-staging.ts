/**
 * Staging verification: receipt_documents schema (table, constraints, RLS).
 *   npx tsx scripts/verify-receipt-documents-schema-staging.ts
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
  'outlet_id',
  'order_id',
  'document_type',
  'document_number',
  'version',
  'status',
  'currency',
  'snapshot_json',
  'issued_at',
  'created_at',
]

const EXPECTED_INDEXES = ['receipt_documents_restaurant_id_idx', 'receipt_documents_order_id_idx']

const EXPECTED_POLICIES = [
  ['receipt_documents', 'Staff can read receipt documents for their restaurant', 'SELECT'],
]

type Row = Record<string, unknown>

function runQuery(sql: string): Row[] {
  const tmp = join(process.cwd(), 'supabase', '.temp', `_receipt_documents_q_${Date.now()}.sql`)
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

  const tableExists = runQuery(`SELECT to_regclass('public.receipt_documents') AS receipt_documents;`)

  const columns = runQuery(`
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'receipt_documents'
ORDER BY ordinal_position;
`)

  const indexes = runQuery(`
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'receipt_documents'
ORDER BY indexname;
`)

  const constraints = runQuery(`
SELECT con.conname, con.contype
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public' AND rel.relname = 'receipt_documents'
ORDER BY con.conname;
`)

  const rls = runQuery(`
SELECT c.relname AS table_name, c.relrowsecurity AS enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'receipt_documents';
`)

  const policies = runQuery(`
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'receipt_documents'
ORDER BY policyname;
`)

  const numberFunction = runQuery(`
SELECT proname FROM pg_proc
WHERE proname = 'generate_document_number' AND pronamespace = 'public'::regnamespace;
`)

  const report = {
    tableExists: tableExists[0]?.receipt_documents === 'receipt_documents',
    columns: columns.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable })),
    indexes: indexes.map((r) => r.indexname),
    constraints: constraints.map((c) => ({ name: c.conname, type: c.contype })),
    rlsEnabled: rls[0]?.enabled === true,
    policies: policies.map((p) => [p.tablename, p.policyname, p.cmd]),
    hasGenerateDocumentNumberFunction: numberFunction.length > 0,
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
      (c) => c.conname === 'receipt_documents_order_id_document_type_version_key' && c.contype === 'u',
    ) &&
    constraints.some((c) => c.conname === 'receipt_documents_document_type_check' && c.contype === 'c') &&
    constraints.some((c) => c.conname === 'receipt_documents_status_check' && c.contype === 'c') &&
    report.rlsEnabled &&
    EXPECTED_POLICIES.every(([t, p, c]) => policySet.has(`${t}:${p}:${c}`)) &&
    // No write policies should exist -- insert-only from the service role.
    !policies.some((p) => p.cmd !== 'SELECT') &&
    report.hasGenerateDocumentNumberFunction

  if (!pass) {
    console.error('RECEIPT_DOCUMENTS_SCHEMA_STAGING_VERIFY_FAIL')
    process.exitCode = 1
  } else {
    console.log('RECEIPT_DOCUMENTS_SCHEMA_STAGING_VERIFY_OK')
  }
}

main()
