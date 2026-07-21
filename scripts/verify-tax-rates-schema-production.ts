/**
 * Production verification: tax_rates schema (table, constraints, RLS) + menu_items.tax_rate_id.
 *   npx tsx scripts/verify-tax-rates-schema-production.ts
 */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { PRODUCTION_PROJECT_REF, runShellCommand } from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase (.env.production.local)')
}

const EXPECTED_COLUMNS = [
  'id',
  'restaurant_id',
  'name',
  'percentage',
  'is_inclusive',
  'is_default',
  'created_at',
]

type Row = Record<string, unknown>

function runQuery(sql: string): Row[] {
  const tmp = join(process.cwd(), 'supabase', '.temp', `_tax_rates_prod_q_${Date.now()}.sql`)
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
  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)

  const tableExists = runQuery(`SELECT to_regclass('public.tax_rates') AS tax_rates;`)

  const columns = runQuery(`
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tax_rates'
ORDER BY ordinal_position;
`)

  const indexes = runQuery(`
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'tax_rates'
ORDER BY indexname;
`)

  const constraints = runQuery(`
SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public' AND rel.relname = 'tax_rates'
ORDER BY con.conname;
`)

  const rls = runQuery(`
SELECT c.relname AS table_name, c.relrowsecurity AS enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'tax_rates';
`)

  const policies = runQuery(`
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'tax_rates'
ORDER BY policyname;
`)

  const menuItemsTaxRateColumn = runQuery(`
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'menu_items' AND column_name = 'tax_rate_id';
`)

  const menuItemsTaxRateFk = runQuery(`
SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public' AND rel.relname = 'menu_items' AND con.contype = 'f'
  AND pg_get_constraintdef(con.oid) LIKE '%tax_rates%';
`)

  const menuItemsTaxRateIndex = runQuery(`
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'menu_items' AND indexname = 'idx_menu_items_tax_rate';
`)

  const report = {
    tableExists: tableExists[0]?.tax_rates === 'tax_rates',
    columns: columns.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable })),
    indexes: indexes.map((r) => ({ name: r.indexname, def: r.indexdef })),
    constraints: constraints.map((c) => ({ name: c.conname, type: c.contype, def: c.def })),
    rlsEnabled: rls[0]?.enabled === true,
    policies: policies.map((p) => [p.tablename, p.policyname, p.cmd]),
    menuItemsTaxRateColumn: menuItemsTaxRateColumn[0] ?? null,
    menuItemsTaxRateFk: menuItemsTaxRateFk[0]?.def ?? null,
    menuItemsTaxRateIndexed: menuItemsTaxRateIndex.length > 0,
  }

  console.log(JSON.stringify(report, null, 2))

  const columnNames = new Set(columns.map((c) => String(c.column_name)))
  const policySet = new Set(policies.map((p) => `${p.tablename}:${p.policyname}:${p.cmd}`))
  const hasPartialUniqueDefault = indexes.some(
    (i) =>
      String(i.indexdef).includes('UNIQUE') &&
      String(i.indexdef).includes('restaurant_id') &&
      String(i.indexdef).toLowerCase().includes('where') &&
      String(i.indexdef).toLowerCase().includes('is_default'),
  )
  const hasPercentageCheck = constraints.some(
    (c) => c.contype === 'c' && String(c.def).includes('percentage'),
  )

  const pass =
    report.tableExists &&
    EXPECTED_COLUMNS.every((col) => columnNames.has(col)) &&
    hasPartialUniqueDefault &&
    hasPercentageCheck &&
    report.rlsEnabled &&
    policySet.has('tax_rates:Owners can manage own restaurant tax rates:ALL') &&
    report.menuItemsTaxRateColumn !== null &&
    (report.menuItemsTaxRateColumn as Row)?.is_nullable === 'YES' &&
    report.menuItemsTaxRateFk !== null &&
    String(report.menuItemsTaxRateFk).includes('SET NULL') &&
    report.menuItemsTaxRateIndexed

  if (!pass) {
    console.error('TAX_RATES_SCHEMA_PRODUCTION_VERIFY_FAIL')
    process.exitCode = 1
  } else {
    console.log('TAX_RATES_SCHEMA_PRODUCTION_VERIFY_OK')
  }
}

main()
