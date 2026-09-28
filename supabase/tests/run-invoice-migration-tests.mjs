#!/usr/bin/env node
/**
 * DATABASE TESTS FOR THE TAB-INVOICE MIGRATIONS (20260928140000 / 20260928140100).
 *
 *   FT_TEST_DB=ft_inv node supabase/tests/run-invoice-migration-tests.mjs
 *   FT_TEST_DB=ft_inv node supabase/tests/run-invoice-migration-tests.mjs --mutate=without-140100
 *
 * Builds a THROWAWAY database inside the local docker container (never a remote host), creates the
 * handful of tables the document engine references, applies the REAL document-engine migrations in
 * order -- including the two under test -- and then exercises `correct_invoice()` on a tab invoice.
 *
 * What is asserted:
 *   1. The three new columns exist and a tab invoice row carrying them can be written.
 *   2. correct_invoice() carries tab_id / order_ids / cancelled_line_items onto the replacement and
 *      tab_id / order_ids onto the credit note (so a correction still blocks a duplicate).
 *   3. The internal permission check 20260727160000 added is PRESENT: a direct `authenticated` call
 *      by a user without documents:write is refused with 42501.
 *   4. EXECUTE is service_role only -- `authenticated` holds no grant (20260913100100 re-granted it).
 *
 * `--mutate=without-140100` stops before 20260928140100, i.e. the state 20260913100100 leaves. The
 * suite MUST go red there (lineage lost, permission check gone, authenticated re-granted); if it
 * does not, these assertions are not testing the file.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINER = process.env.FT_TEST_CONTAINER || 'ft-harden-pg'
const DB = process.env.FT_TEST_DB || 'ft_invoice_test'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mutation = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length)

if (!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error(`refusing odd database name ${DB}`)

const MIGRATIONS = [
  '20260705280000_business_documents.sql',
  '20260722140000_business_documents_status_payments.sql',
  '20260725200000_document_engine_credit_notes_lineage.sql',
  '20260727160000_correct_invoice_internal_permission_check.sql',
  '20260913100000_business_documents_order_id.sql',
  '20260913100100_correct_invoice_carries_order_id.sql',
  '20260928140000_business_documents_tab_invoice.sql',
  ...(mutation === 'without-140100' ? [] : ['20260928140100_correct_invoice_carries_tab_scope.sql']),
]

function psql(sql, db = DB) {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
  )
}

/** The minimum the document migrations reference, shaped like the real tables. */
const FIXTURE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
-- Same mechanism as Supabase: PostgREST sets request.jwt.claims per request.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $f$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $f$ SELECT coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') $f$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

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

const SEED = `
INSERT INTO public.restaurants VALUES ('11111111-1111-4111-8111-111111111111', 'Riviera');
INSERT INTO public.users VALUES ('55555555-5555-4555-8555-555555555555', 'manager@example.test'),
                                ('66666666-6666-4666-8666-666666666666', 'stranger@example.test');
INSERT INTO public.restaurant_users VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'manager');
INSERT INTO public.tabs VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
INSERT INTO public.orders VALUES
  ('aaaaaaaa-0000-4000-8000-000000000154', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
  ('aaaaaaaa-0000-4000-8000-000000000155', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.business_documents
  (id, restaurant_id, document_type, document_number, business_name, ship_to, bill_to, line_items,
   subtotal, vat_amount, total, balance, created_by, status, tab_id, order_ids, cancelled_line_items)
VALUES
  ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'invoice', '1001',
   'Riviera', '{}', '{"name":"Acme"}',
   '[{"description":"Seared Salmon","quantity":1,"unit_price":720,"line_total":720}]',
   626.09, 93.91, 720, 720, '55555555-5555-4555-8555-555555555555', 'sent',
   '22222222-2222-4222-8222-222222222222',
   ARRAY['aaaaaaaa-0000-4000-8000-000000000154','aaaaaaaa-0000-4000-8000-000000000155']::uuid[],
   '[{"description":"Modena Pasta","quantity":1,"unit_price":240,"line_total":240,"order_number":160,"reason":"voided"}]'),
  -- The permission probe's target, so a probe that WRONGLY succeeds cannot consume the lineage test's.
  ('dddddddd-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'invoice', '1002',
   'Riviera', '{}', '{}', '[{"description":"x","quantity":1,"unit_price":10,"line_total":10}]',
   8.70, 1.30, 10, 10, '55555555-5555-4555-8555-555555555555', 'sent', NULL, NULL, NULL);
`

const results = []
const expect = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

try {
  psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres')
  psql(`CREATE DATABASE ${DB};`, 'postgres')
  psql(FIXTURE)
  for (const file of MIGRATIONS) psql(readFileSync(join(REPO, 'supabase/migrations', file), 'utf8'))
  psql(SEED)

  // Positive control first: the fixture row itself round-trips.
  expect(
    'fixture/tab_invoice_written',
    psql(`SELECT tab_id FROM business_documents WHERE document_number = '1001';`).trim() ===
      '22222222-2222-4222-8222-222222222222',
  )

  // 4. Grants.
  const authExec = psql(
    `SELECT has_function_privilege('authenticated', 'public.correct_invoice(uuid, jsonb, text, uuid)', 'EXECUTE');`,
  ).trim()
  const svcExec = psql(
    `SELECT has_function_privilege('service_role', 'public.correct_invoice(uuid, jsonb, text, uuid)', 'EXECUTE');`,
  ).trim()
  expect('security/authenticated_has_no_execute', authExec === 'f', `authenticated EXECUTE = ${authExec}`)
  expect('security/service_role_can_execute', svcExec === 't', `service_role EXECUTE = ${svcExec}`)

  // 3. A direct authenticated call from a user of NO venue must be refused by the function itself.
  let strangerRefused = false
  let strangerDetail = ''
  try {
    // The grant is the OUTER wall; the function's own check is the inner one. To test the inner one
    // it must be reachable, so EXECUTE is granted for the probe (as a grant regression would) and
    // revoked straight after. Refused-by-grant alone would pass with the check deleted.
    psql(`GRANT EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) TO authenticated;`)
    psql(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}', false);
      SELECT public.correct_invoice('dddddddd-0000-4000-8000-000000000002',
        '[{"description":"x","quantity":1,"unit_price":1}]'::jsonb, 'probe',
        '66666666-6666-4666-8666-666666666666');
    `)
  } catch (err) {
    strangerDetail = String(err.stderr || err.message)
    strangerRefused = /Insufficient permission|permission denied/.test(strangerDetail)
  }
  psql(`REVOKE EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) FROM authenticated;`)
  expect('security/stranger_cannot_correct', strangerRefused, strangerDetail.split('\n')[0])
  expect(
    'security/stranger_refused_by_the_function_itself',
    /Insufficient permission/.test(strangerDetail),
    strangerDetail.split('\n')[0] || 'the call SUCCEEDED',
  )

  // 2. Correct the tab invoice the way the route does (service_role).
  const out = psql(`
    SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
    SELECT (public.correct_invoice('dddddddd-0000-4000-8000-000000000001',
      '[{"description":"Seared Salmon","quantity":1,"unit_price":700}]'::jsonb, 'price agreed',
      '55555555-5555-4555-8555-555555555555'))::text;
  `)
  const json = JSON.parse(out.trim().split('\n').pop())
  const replacement = json.replacement_invoice
  const credit = json.credit_note
  expect('lineage/replacement_tab_id', replacement.tab_id === '22222222-2222-4222-8222-222222222222', replacement.tab_id)
  expect('lineage/replacement_order_ids', JSON.stringify(replacement.order_ids) ===
    JSON.stringify(['aaaaaaaa-0000-4000-8000-000000000154', 'aaaaaaaa-0000-4000-8000-000000000155']),
    JSON.stringify(replacement.order_ids))
  expect('lineage/replacement_cancelled_lines',
    Array.isArray(replacement.cancelled_line_items) && replacement.cancelled_line_items[0]?.description === 'Modena Pasta',
    JSON.stringify(replacement.cancelled_line_items))
  expect('lineage/credit_note_tab_id', credit.tab_id === '22222222-2222-4222-8222-222222222222', credit.tab_id)
  expect('lineage/credit_note_order_ids', Array.isArray(credit.order_ids) && credit.order_ids.length === 2,
    JSON.stringify(credit.order_ids))
  expect('lineage/credit_note_has_no_cancelled_lines', credit.cancelled_line_items == null,
    JSON.stringify(credit.cancelled_line_items))
  expect('lineage/original_voided',
    psql(`SELECT status FROM business_documents WHERE id = 'dddddddd-0000-4000-8000-000000000001';`).trim() === 'void')
} catch (err) {
  expect('run/threw', false, String(err.stderr || err.message).split('\n').slice(0, 3).join(' | '))
} finally {
  try {
    psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres')
  } catch {
    /* best effort */
  }
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` -- ${r.detail}`}`)
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed${mutation ? ` (mutation: ${mutation})` : ''}`)
if (results.length === 0) process.exit(2)
process.exit(failed > 0 ? 1 : 0)
