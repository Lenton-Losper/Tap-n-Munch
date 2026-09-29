#!/usr/bin/env node
/**
 * READ-ONLY verification of the sprint migrations on PRODUCTION. Writes nothing.
 *
 * Every grant check carries a positive control (service_role MUST be able to execute), because a
 * refusal that cannot tell "closed" from "absent" is not a security check. Every body check looks
 * for text only the sprint's definition contains, so a stale definition fails rather than passes.
 *
 *   node scripts/staging/verify-sprint-staging.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('file:///D:/dev/pgclient/')
const { Client } = require('pg')
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
function secret(name) {
  for (const line of readFileSync('C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(name + ' not found')
}
async function connectProduction() {
  const c = new Client({ host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432, user: 'postgres.' + PROD_REF,
    password: secret('SUPABASE_DB_PASSWORD_PROD'), database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 })
  await c.connect()
  const l = new Set((await c.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version))
  if (l.has('20260705210000') || l.has('20260705220000')) throw new Error('REFUSING: not production')
  // READ ONLY: every statement below is a SELECT; the session is also made read-only.
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  return c
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

const c = await connectProduction()
try {
  const fn = async (name) =>
    (
      await c.query(
        `select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
                has_function_privilege('anon', p.oid, 'EXECUTE') anon,
                has_function_privilege('service_role', p.oid, 'EXECUTE') svc
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [name],
      )
    ).rows

  // ── The correct_invoice authorization hole (20260913100100 without 20260928140100) ──────────
  const ci = await fn('correct_invoice')
  check('correct_invoice: exactly one definition', ci.length === 1, ci.map((r) => r.sig).join(' | '))
  if (ci[0]) {
    check('correct_invoice: authenticated CANNOT execute', ci[0].auth === false)
    check('correct_invoice: anon CANNOT execute', ci[0].anon === false)
    check('correct_invoice: service_role CAN execute (positive control)', ci[0].svc === true)
    check('correct_invoice: body has the internal permission check', /user_has_permission/.test(ci[0].def))
    check('correct_invoice: body carries tab scope (140100)', /tab_id/.test(ci[0].def) && /order_ids/.test(ci[0].def))
  }

  // ── Function bodies: text only the sprint's definition contains ─────────────────────────────
  const bodies = [
    ['settle_order_payment', ['order_paid_by_other_payment', 'order_changed_since_preparation', 'ledger_row_promoted']],
    ['amend_order_lines', ['order_paid', 'line_settled', 'payment_in_flight']],
    ['settle_order_line_allocations', ['FOR UPDATE']],
    ['order_is_fully_paid_by_allocations', ['source_item_index']],
    ['record_manual_order_payment', ['non_gateway_payment_events', "flashtap.non_gateway_payment"]],
    ['release_stale_card_attempts', ['payment.stale_card_attempt_released']],
    ['record_terminal_refund_event', ['SALE_AMOUNT_UNVERIFIED']],
  ]
  for (const [name, needles] of bodies) {
    const rows = await fn(name)
    check(`${name}: exactly one definition`, rows.length === 1, rows.map((r) => r.sig).join(' | '))
    if (!rows[0]) continue
    for (const n of needles) check(`${name}: body contains ${n}`, rows[0].def.includes(n))
    check(`${name}: anon cannot execute`, rows[0].anon === false)
    check(`${name}: authenticated cannot execute`, rows[0].auth === false)
    check(`${name}: service_role can execute (positive control)`, rows[0].svc === true)
  }

  // ── Columns ──────────────────────────────────────────────────────────────────────────────────
  const cols = async (table) =>
    new Set(
      (
        await c.query(
          `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
          [table],
        )
      ).rows.map((r) => r.column_name),
    )
  const orders = await cols('orders')
  for (const col of ['settled_charge_cents', 'pending_charge_basis', 'pending_charge_at'])
    check(`orders.${col} exists`, orders.has(col))
  const pe = await cols('payment_events')
  for (const col of ['origin', 'device_amount_check']) check(`payment_events.${col} exists`, pe.has(col))
  const bd = await cols('business_documents')
  for (const col of ['order_id', 'tab_id', 'order_ids', 'cancelled_line_items'])
    check(`business_documents.${col} exists`, bd.has(col))
  const ng = await cols('non_gateway_payment_events')
  for (const col of ['origin', 'method', 'amount_cents', 'tip_cents', 'order_ids', 'recorded_by', 'idempotency_key'])
    check(`non_gateway_payment_events.${col} exists`, ng.has(col))

  // ── Ledger table: RLS, immutability triggers, grants, uniqueness ────────────────────────────
  const rls = (await c.query(`select relrowsecurity from pg_class where oid='public.non_gateway_payment_events'::regclass`)).rows[0]
  check('non_gateway_payment_events: RLS enabled', rls?.relrowsecurity === true)
  const trig = async (table) =>
    (await c.query(`select tgname from pg_trigger where tgrelid=$1::regclass and not tgisinternal`, [table])).rows.map((r) => r.tgname)
  const ngTrig = await trig('public.non_gateway_payment_events')
  check('non_gateway_payment_events: immutability triggers present', ngTrig.length >= 2, ngTrig.join(', '))
  const priv = async (role, table, p) =>
    (await c.query(`select has_table_privilege($1, $2, $3) ok`, [role, table, p])).rows[0].ok
  check('non_gateway_payment_events: authenticated cannot INSERT', (await priv('authenticated', 'public.non_gateway_payment_events', 'INSERT')) === false)
  check('non_gateway_payment_events: anon cannot SELECT', (await priv('anon', 'public.non_gateway_payment_events', 'SELECT')) === false)
  check('non_gateway_payment_events: service_role can INSERT (positive control)', (await priv('service_role', 'public.non_gateway_payment_events', 'INSERT')) === true)
  check('non_gateway_payment_events: service_role cannot UPDATE', (await priv('service_role', 'public.non_gateway_payment_events', 'UPDATE')) === false)
  const uniq = (
    await c.query(
      `select count(*)::int n from pg_indexes where schemaname='public' and tablename='non_gateway_payment_events' and indexdef ilike '%unique%idempotency_key%'`,
    )
  ).rows[0].n
  check('non_gateway_payment_events: unique (restaurant_id, idempotency_key)', uniq >= 1)

  // ── Orders triggers (charge basis, in-flight edit lock, settled charge, items-have-lines) ───
  const oTrig = await trig('public.orders')
  for (const t of ['orders_record_settled_charge', 'orders_items_immutable_when_lined'])
    check(`orders trigger ${t}`, oTrig.includes(t), oTrig.join(', '))
  check('orders: charge-basis triggers present (>= 3 new)', oTrig.filter((t) => /charge|basis|inflight|in_flight|paid_guard/i.test(t)).length >= 3, oTrig.join(', '))

  // ── Constraints validated ────────────────────────────────────────────────────────────────────
  const cons = (
    await c.query(
      `select conname, convalidated from pg_constraint where conrelid in ('public.orders'::regclass,'public.payment_events'::regclass,'public.non_gateway_payment_events'::regclass)
         and conname ~ '(settled_charge|origin|device_amount|non_gateway)'`,
    )
  ).rows
  check('new constraints present', cons.length >= 3, cons.map((r) => r.conname).join(', '))
  check('new constraints all validated', cons.every((r) => r.convalidated), cons.filter((r) => !r.convalidated).map((r) => r.conname).join(', '))

  // ── Index for tab invoices ───────────────────────────────────────────────────────────────────
  const tabIdx = (await c.query(`select count(*)::int n from pg_indexes where schemaname='public' and tablename='business_documents' and indexdef ilike '%(tab_id)%'`)).rows[0].n
  check('business_documents: tab_id index', tabIdx >= 1)

  // ── Ledger rows for every sprint migration ───────────────────────────────────────────────────
  const want = [
    '20260913100000', '20260913100100', '20260928135000', '20260928140000', '20260928140100',
    '20260928150000', '20260928160000', '20260929100000', '20260929110000', '20260929120000',
    '20260929120100', '20260929120200', '20260929120300', '20260929120400', '20260929130000',
    '20260929130100', '20260929140000', '20260929150000',
  ]
  const led = new Set((await c.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version))
  const missing = want.filter((v) => !led.has(v))
  check('ledger: all 18 sprint versions recorded', missing.length === 0, missing.join(' '))
} finally {
  await c.end()
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? '  -- ' + r.detail : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
