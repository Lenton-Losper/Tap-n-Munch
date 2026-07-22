/**
 * Staging verification: post-payment order lifecycle migration.
 *   npx tsx scripts/verify-post-payment-order-lifecycle-staging.ts
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

const EXPECTED_INDEXES = [
  'idx_invoice_requests_order_id',
  'idx_invoice_requests_restaurant_id',
  'idx_invoice_requests_status',
  'idx_order_revisions_order_id',
]

const EXPECTED_POLICIES = [
  ['invoice_requests', 'staff_view_invoice_requests', 'SELECT'],
  ['invoice_requests', 'staff_update_invoice_requests', 'UPDATE'],
  ['order_revisions', 'staff_view_order_revisions', 'SELECT'],
  ['order_revisions', 'staff_insert_order_revisions', 'INSERT'],
]

type Row = Record<string, unknown>

function runQuery(sql: string): Row[] {
  const tmp = join(process.cwd(), 'supabase', '.temp', `_ppol_q_${Date.now()}.sql`)
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

  const columns = runQuery(`
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('document_sequences', 'invoice_requests', 'order_revisions')
ORDER BY table_name, ordinal_position;
`)

  const shortCodeCol = runQuery(`
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'restaurants' AND column_name = 'short_code';
`)

  const indexes = runQuery(`
SELECT tablename, indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('invoice_requests', 'order_revisions')
ORDER BY tablename, indexname;
`)

  const constraints = runQuery(`
SELECT rel.relname AS table_name, con.conname, con.contype
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname IN ('invoice_requests', 'order_revisions', 'document_sequences')
ORDER BY rel.relname, con.conname;
`)

  const rls = runQuery(`
SELECT c.relname AS table_name, c.relrowsecurity AS enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('invoice_requests', 'order_revisions');
`)

  const policies = runQuery(`
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('invoice_requests', 'order_revisions')
ORDER BY tablename, policyname;
`)

  const functional = runQuery(`
DO $$
DECLARE
  v_rest_id uuid;
  v_order_id uuid;
  v_staff_id uuid;
  v_rev1 integer;
  v_rev2 integer;
  v_doc text;
  v_tag text := 'ppol-staging-verify';
BEGIN
  INSERT INTO restaurants (name, slug, short_code)
  VALUES (v_tag || ' Restaurant', v_tag, 'RIV')
  RETURNING id INTO v_rest_id;

  INSERT INTO restaurant_roles (restaurant_id, role_slug, display_name, permissions, is_system)
  VALUES (v_rest_id, 'manager', 'Manager', ARRAY['orders:read']::text[], false);

  INSERT INTO staff_members (restaurant_id, email, role, active)
  VALUES (v_rest_id, v_tag || '@flashtap-test.invalid', 'manager', true)
  RETURNING id INTO v_staff_id;

  v_doc := generate_document_number(v_rest_id, 'RIV', 'invoice', 'INV');

  INSERT INTO orders (restaurant_id, table_number, status, payment_status, total, items, customer_name)
  VALUES (v_rest_id, 9999, 'completed', 'paid', 0, '[]'::jsonb, v_tag)
  RETURNING id INTO v_order_id;

  INSERT INTO order_revisions (restaurant_id, order_id, amended_by, changes)
  VALUES (v_rest_id, v_order_id, v_staff_id, '[{"action":"quantity_changed"}]'::jsonb)
  RETURNING revision_number INTO v_rev1;

  INSERT INTO order_revisions (restaurant_id, order_id, amended_by, changes)
  VALUES (v_rest_id, v_order_id, v_staff_id, '[{"action":"removed"}]'::jsonb)
  RETURNING revision_number INTO v_rev2;

  CREATE TEMP TABLE _ppol_out (doc_number text, rev1 int, rev2 int);
  INSERT INTO _ppol_out VALUES (v_doc, v_rev1, v_rev2);

  DELETE FROM order_revisions WHERE order_id = v_order_id;
  DELETE FROM orders WHERE id = v_order_id;
  DELETE FROM document_sequences WHERE restaurant_id = v_rest_id;
  DELETE FROM staff_members WHERE id = v_staff_id;
  DELETE FROM restaurant_roles WHERE restaurant_id = v_rest_id;
  DELETE FROM restaurants WHERE id = v_rest_id;
END $$;
SELECT doc_number, rev1, rev2 FROM _ppol_out;
`)

  const tableNames = new Set(columns.map((r) => String(r.table_name)))
  const indexNames = new Set(indexes.map((r) => String(r.indexname)))
  const policySet = new Set(policies.map((p) => `${p.tablename}:${p.policyname}:${p.cmd}`))

  const report = {
    tables: {
      document_sequences: tableNames.has('document_sequences'),
      invoice_requests: tableNames.has('invoice_requests'),
      order_revisions: tableNames.has('order_revisions'),
      columnCount: columns.length,
    },
    shortCodeColumnExists: shortCodeCol.some((r) => r.column_name === 'short_code'),
    indexes: [...indexNames],
    constraints: constraints.map((c) => ({
      table: c.table_name,
      name: c.conname,
      type: c.contype,
    })),
    rls: Object.fromEntries(rls.map((r) => [r.table_name, r.enabled])),
    policies: policies.map((p) => [p.tablename, p.policyname, p.cmd]),
    docNumber: functional[0]?.doc_number,
    revisionAutoInc: functional[0]
      ? { rev1: functional[0].rev1, rev2: functional[0].rev2 }
      : null,
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    report.tables.document_sequences &&
    report.tables.invoice_requests &&
    report.tables.order_revisions &&
    report.tables.columnCount >= 20 &&
    report.shortCodeColumnExists &&
    EXPECTED_INDEXES.every((idx) => indexNames.has(idx)) &&
    constraints.some(
      (c) =>
        c.conname === 'invoice_requests_idempotency_key_unique' && c.contype === 'u',
    ) &&
    constraints.some(
      (c) => c.conname === 'order_revisions_order_revision_unique' && c.contype === 'u',
    ) &&
    report.rls.invoice_requests === true &&
    report.rls.order_revisions === true &&
    EXPECTED_POLICIES.every(([t, p, c]) => policySet.has(`${t}:${p}:${c}`)) &&
    report.docNumber === 'INV-RIV-000001' &&
    report.revisionAutoInc?.rev1 === 1 &&
    report.revisionAutoInc?.rev2 === 2

  if (!pass) {
    console.error('POST_PAYMENT_ORDER_LIFECYCLE_STAGING_VERIFY_FAIL')
    process.exitCode = 1
  } else {
    console.log('POST_PAYMENT_ORDER_LIFECYCLE_STAGING_VERIFY_OK')
  }
}

main()
