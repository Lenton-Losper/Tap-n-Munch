#!/usr/bin/env node
/**
 * DATABASE TESTS FOR sync_invoice_projection_payments (20260930120000, Sprint 2026-09-30 J8).
 *
 *   FT_TEST_DB=ft_invsync node supabase/tests/run-invoice-payment-sync-tests.mjs
 *   FT_TEST_DB=ft_invsync node supabase/tests/run-invoice-payment-sync-tests.mjs --mutate=all
 *   FT_TEST_DB=ft_invsync node supabase/tests/run-invoice-payment-sync-tests.mjs --mutate=IS1
 *
 * Builds a THROWAWAY database inside the local docker container (never a remote host), creates the
 * handful of tables the document engine references (the same fixture as
 * run-invoice-migration-tests.mjs), applies the REAL document-engine migrations and the one under
 * test, and exercises the function directly -- including in TWO REAL SESSIONS, which is the only
 * way to prove the row lock that stops two refreshes both inserting.
 *
 * --mutate re-applies the function with one guard removed and expects at least one named assertion
 * to go RED; a mutation that stays green means the assertion does not test the guard.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINER = process.env.FT_TEST_CONTAINER || 'ft-harden-pg'
const DB = process.env.FT_TEST_DB || 'ft_invoice_sync_test'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
if (!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error(`refusing odd database name ${DB}`)

const FILE = '20260930120000_invoice_projection_payment_sync.sql'
const MIGRATIONS = [
  '20260705280000_business_documents.sql',
  '20260722140000_business_documents_status_payments.sql',
  '20260725200000_document_engine_credit_notes_lineage.sql',
  '20260727160000_correct_invoice_internal_permission_check.sql',
  '20260913100000_business_documents_order_id.sql',
  '20260913100100_correct_invoice_carries_order_id.sql',
  '20260928140000_business_documents_tab_invoice.sql',
  '20260928140100_correct_invoice_carries_tab_scope.sql',
  FILE,
]

/** Each removes one guard. `expect` names an assertion that MUST fail under it. */
const MUTATIONS = {
  IS1: {
    what: 'no row lock: two concurrent refreshes both insert the missing payment',
    from: '     WHERE id = p_document_id AND restaurant_id = p_restaurant_id\n       FOR UPDATE;',
    to: '     WHERE id = p_document_id AND restaurant_id = p_restaurant_id;',
    expect: 'race/one_payment_row_after_two_sessions',
  },
  IS2: {
    what: 'the shortfall ignores what is already recorded (a refresh re-inserts every payment)',
    from: '        v_delta := v_rec.cents - v_existing;',
    to: '        v_delta := v_rec.cents;',
    expect: 'sync/second_call_inserts_nothing',
  },
  IS3: {
    what: 'no total cap: payments beyond the document total are recorded',
    from: '    IF v_recorded_before + v_planned_cents > v_total_cents THEN',
    to: '    IF false THEN',
    expect: 'sync/exceeding_total_refused',
  },
  IS4: {
    what: 'a void invoice is written to',
    from: "    IF v_doc.status IN ('void', 'converted', 'expired', 'declined', 'cancelled') THEN",
    to: '    IF false THEN',
    expect: 'sync/void_invoice_untouched',
  },
  IS5: {
    what: 'authenticated keeps EXECUTE (Supabase default privileges)',
    from: 'FROM PUBLIC, anon, authenticated;',
    to: 'FROM PUBLIC;',
    expect: 'security/authenticated_has_no_execute',
  },
}

function psql(sql, db = DB) {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
  )
}
const one = (sql) => psql(sql).trim().split('\n').pop()

const FIXTURE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $f$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $f$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') $f$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;
-- Supabase's default privileges: every new public function is directly executable by anon and
-- authenticated. Without this a migration that forgets its REVOKE passes here and not there.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.restaurants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.restaurant_users (user_id uuid, restaurant_id uuid, role text);
CREATE TABLE public.restaurant_roles (restaurant_id uuid, role_slug text, permissions text[] DEFAULT '{}');
CREATE TABLE public.tabs (id uuid PRIMARY KEY, restaurant_id uuid REFERENCES public.restaurants(id));
CREATE TABLE public.orders (id uuid PRIMARY KEY, restaurant_id uuid, tab_id uuid);
CREATE TABLE public.tax_rates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), restaurant_id uuid, name text,
  percentage numeric NOT NULL DEFAULT 0, is_inclusive boolean NOT NULL DEFAULT true, is_default boolean NOT NULL DEFAULT false);
CREATE FUNCTION public.user_restaurant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS
  $f$ SELECT restaurant_id FROM public.restaurant_users WHERE user_id = auth.uid() $f$;
CREATE FUNCTION public.user_has_permission(p_restaurant_id uuid, p_permission text) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
    SELECT EXISTS (SELECT 1 FROM public.restaurant_users ru
                    WHERE ru.user_id = auth.uid() AND ru.restaurant_id = p_restaurant_id
                      AND ru.role IN ('owner', 'manager'))
  $f$;
`

const R = '11111111-1111-4111-8111-111111111111'
const OTHER_R = '11111111-1111-4111-8111-222222222222'
const U = '55555555-5555-4555-8555-555555555555'
const DOC = (n) => `dddddddd-0000-4000-8000-00000000000${n}`
const SEED = `
INSERT INTO public.restaurants VALUES ('${R}', 'Chaos Bistro'), ('${OTHER_R}', 'Elsewhere');
INSERT INTO public.users VALUES ('${U}', 'manager@example.test');
INSERT INTO public.business_documents
  (id, restaurant_id, document_type, document_number, business_name, ship_to, bill_to, line_items,
   subtotal, vat_amount, total, balance, created_by, status)
SELECT d.id, '${R}', 'invoice', d.num, 'Chaos Bistro', '{}', '{"name":"Acme"}',
       '[{"description":"Tab","quantity":1,"unit_price":720,"line_total":720}]', 626.09, 93.91, 720, 720, '${U}', d.status
  FROM (VALUES ('${DOC(1)}'::uuid, '2001', 'draft'), ('${DOC(2)}'::uuid, '2002', 'draft'),
               ('${DOC(3)}'::uuid, '2003', 'void'), ('${DOC(4)}'::uuid, '2004', 'draft'),
               ('${DOC(5)}'::uuid, '2005', 'sent')) AS d(id, num, status);
`
const sync = (doc, records, restaurant = R) =>
  `SELECT public.sync_invoice_projection_payments('${doc}', '${restaurant}', '${JSON.stringify(records)}'::jsonb, '${U}')::text;`
const recorded = (doc) => Number(one(`SELECT coalesce(sum(round(amount*100)),0)::int FROM public.document_payments WHERE document_id = '${doc}';`))
const rows = (doc) => Number(one(`SELECT count(*) FROM public.document_payments WHERE document_id = '${doc}';`))

function buildDatabase(mutation) {
  psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres')
  psql(`CREATE DATABASE ${DB};`, 'postgres')
  psql(FIXTURE)
  for (const file of MIGRATIONS) {
    let sql = readFileSync(join(REPO, 'supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n')
    if (mutation && file === FILE) {
      const hits = sql.split(mutation.from).length - 1
      if (hits !== 1) throw new Error(`mutation ${mutation.id}: expected one match, found ${hits}`)
      sql = sql.replace(mutation.from, mutation.to)
      const line = sql.split('\n').find((l) => l.includes(mutation.to.split('\n')[0].trim()))
      console.log(`  MUTATED ${file}: ${line?.trim()}`)
    }
    psql(sql)
  }
  psql(SEED)
}

/** Two real sessions: A holds its refresh open for 2s; B refreshes the same invoice meanwhile. */
function raceProbe() {
  const records = [{ method: 'card', reference: 'TXN-RACE', amount_cents: 72000 }]
  const runSession = (sql) =>
    new Promise((resolve) => {
      const child = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'])
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code, out }))
      child.stdin.end(sql)
    })
  const a = runSession(`BEGIN;\n${sync(DOC(4), records)}\nSELECT pg_sleep(2);\nCOMMIT;\n`)
  return new Promise((resolve) => setTimeout(resolve, 600)).then(async () => {
    const b = await runSession(sync(DOC(4), records))
    const [ra] = await Promise.all([a])
    return { a: ra, b }
  })
}

async function runSuite() {
  const results = []
  const expect = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })
  // Grants.
  const fn = 'public.sync_invoice_projection_payments(uuid, uuid, jsonb, uuid)'
  expect('security/authenticated_has_no_execute', one(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`) === 'f')
  expect('security/anon_has_no_execute', one(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE');`) === 'f')
  expect('security/service_role_can_execute', one(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE');`) === 't')

  // 1. The missing payment is added, once.
  const first = JSON.parse(one(sync(DOC(1), [{ method: 'card', reference: 'TXN-1', amount_cents: 72000, paid_at: '2026-09-30T10:00:00Z' }])))
  expect('sync/missing_payment_inserted', first.ok === true && first.inserted === 1 && recorded(DOC(1)) === 72000, JSON.stringify(first))
  const second = JSON.parse(one(sync(DOC(1), [{ method: 'card', reference: 'TXN-1', amount_cents: 72000 }])))
  expect('sync/second_call_inserts_nothing', second.inserted === 0 && rows(DOC(1)) === 1 && recorded(DOC(1)) === 72000,
    `${JSON.stringify(second)} rows=${rows(DOC(1))} recorded=${recorded(DOC(1))}`)

  // 2. Only the shortfall: a payment recorded at issue counts; the later one is added.
  psql(`INSERT INTO public.document_payments (document_id, amount, method, reference, recorded_by) VALUES ('${DOC(2)}', 200, 'cash', 'CASH-1', '${U}');`)
  const partial = JSON.parse(one(sync(DOC(2), [
    { method: 'cash', reference: 'CASH-1', amount_cents: 20000 },
    { method: 'card', reference: 'TXN-2', amount_cents: 52000 },
  ])))
  expect('sync/only_the_shortfall_inserted', partial.inserted === 1 && partial.inserted_cents === 52000 && recorded(DOC(2)) === 72000,
    `${JSON.stringify(partial)} recorded=${recorded(DOC(2))}`)

  // 3. Never more than the invoice bills; refused whole, nothing written.
  const over = JSON.parse(one(sync(DOC(5), [
    { method: 'card', reference: 'TXN-5a', amount_cents: 50000 },
    { method: 'card', reference: 'TXN-5b', amount_cents: 30000 },
  ])))
  expect('sync/exceeding_total_refused', over.ok === false && over.reason === 'exceeds_document_total' && rows(DOC(5)) === 0,
    `${JSON.stringify(over)} rows=${rows(DOC(5))}`)

  // 4. A bad record refuses the call, including the good record beside it.
  const bad = JSON.parse(one(sync(DOC(5), [
    { method: 'card', reference: 'TXN-5c', amount_cents: 1000 },
    { method: '', reference: 'x', amount_cents: 500 },
  ])))
  expect('sync/invalid_record_refused_whole', bad.ok === false && bad.reason === 'invalid_record' && rows(DOC(5)) === 0,
    `${JSON.stringify(bad)} rows=${rows(DOC(5))}`)

  // 5. A void invoice is never written to.
  const voided = JSON.parse(one(sync(DOC(3), [{ method: 'card', reference: 'TXN-3', amount_cents: 1000 }])))
  expect('sync/void_invoice_untouched', voided.skipped === 'terminal_status' && rows(DOC(3)) === 0, `${JSON.stringify(voided)} rows=${rows(DOC(3))}`)

  // 6. Another venue's invoice is not found, and not written.
  const foreign = JSON.parse(one(sync(DOC(5), [{ method: 'card', reference: 'TXN-X', amount_cents: 100 }], OTHER_R)))
  expect('security/other_restaurant_not_found', foreign.ok === false && foreign.reason === 'not_found' && rows(DOC(5)) === 0, JSON.stringify(foreign))

  // 7. Two real sessions.
  const race = await raceProbe()
  expect('race/both_sessions_completed', race.a.code === 0 && race.b.code === 0, `${race.a.out} | ${race.b.out}`)
  expect('race/one_payment_row_after_two_sessions', rows(DOC(4)) === 1 && recorded(DOC(4)) === 72000,
    `rows=${rows(DOC(4))} recorded=${recorded(DOC(4))}; B said ${race.b.out.trim()}`)
  return results
}

async function main() {
  const arg = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length)
  const ids = !arg ? [] : arg === 'all' ? Object.keys(MUTATIONS) : arg.split(',')
  let failed = 0
  try {
    if (ids.length === 0) {
      buildDatabase(null)
      const results = await runSuite()
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` -- ${r.detail}`}`)
      const bad = results.filter((r) => !r.ok).length
      console.log(`${results.length - bad}/${results.length} passed`)
      if (results.length === 0 || bad > 0) failed += 1
    }
    for (const id of ids) {
      const m = MUTATIONS[id]
      if (!m) throw new Error(`unknown mutation ${id}; known: ${Object.keys(MUTATIONS).join(', ')}`)
      console.log(`\n=== MUTATION ${id}: ${m.what}`)
      buildDatabase({ id, ...m })
      const results = await runSuite()
      const target = results.find((r) => r.name === m.expect)
      if (target && !target.ok) {
        console.log(`  RED as expected: FAIL ${target.name} -- ${target.detail}`)
      } else {
        console.log(`  STILL GREEN at ${m.expect} -- mutation ${id} NOT caught`)
        failed += 1
      }
    }
  } finally {
    try { psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres') } catch { /* best effort */ }
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
