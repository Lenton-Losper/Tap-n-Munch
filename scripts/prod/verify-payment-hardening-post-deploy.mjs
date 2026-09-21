/**
 * POST-DEPLOY VERIFICATION of the payment-hardening sprint on PRODUCTION. STRICTLY READ-ONLY.
 *
 * docs/payment-hardening-remediation.md §5, plus the object-level checks the ledger cannot make:
 * a ledger row says a file RAN, not that the objects it declares are actually there.
 *
 * Every check states the wrong answer that means stop.
 *
 *   node scripts/prod/verify-payment-hardening-post-deploy.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('file:///D:/dev/pgclient/')
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_ONLY = ['20260705210000', '20260705220000']
const ENV_FILE = 'D:/dev/flashtap/wt-harden/.env.local'
const VERSIONS = ['20260919090000', '20260919091000', '20260919092000', '20260919093000']
const SIG =
  'public.settle_order_payment(uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)'

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) {
    pass += 1
    console.log('  PASS  ' + n)
  } else {
    fail += 1
    console.log('  FAIL  ' + n + (d ? ' -- ' + d : ''))
  }
}

function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(name + ' not found')
}

const client = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.' + PROD_REF,
  password: secret('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})
await client.connect()
const q = async (sql, p) => (await client.query(sql, p)).rows

try {
  const so = await q('SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1)', [STAGING_ONLY])
  ok('identity: this is PRODUCTION (staging-only markers absent)', so.length === 0, JSON.stringify(so))

  const led = await q(
    'SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1) ORDER BY version',
    [VERSIONS],
  )
  ok('all four migrations are in the ledger', led.length === 4, led.map((r) => r.version).join(' '))

  // --- §5.1 the function exists and ONLY service_role can call it --------------------------
  const fn = await q(
    "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='settle_order_payment'",
  )
  ok('settle_order_payment exists', fn[0].n >= 1, 'overloads=' + fn[0].n)

  const g = await q(
    "SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') b, has_function_privilege('service_role',$1,'EXECUTE') c",
    [SIG],
  )
  ok('anon CANNOT execute the settlement RPC', g[0].a === false, 'anon=' + g[0].a)
  ok('authenticated CANNOT execute it', g[0].b === false, 'auth=' + g[0].b)
  ok('POSITIVE CONTROL: service_role CAN — the check is alive, not just absent', g[0].c === true, 'svc=' + g[0].c)

  // --- the deployed body is the 093000 one, not 090000's ------------------------------------
  const src = await q(
    "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='settle_order_payment' LIMIT 1",
  )
  const body = String(src[0]?.prosrc ?? '')
  // 093000's whole point: every transition is validated BEFORE the first write, so the guard
  // exists TWICE -- once in the 6b validation pass and once in the claim loop.
  const guardCount = (body.match(/illegal_transition/g) || []).length
  ok('the deployed body is 093000 (pre-write validation present, guard appears more than once)', guardCount >= 2, 'illegal_transition occurrences=' + guardCount)
  ok('the deployed body locks the intent row (FOR UPDATE present)', /FOR UPDATE/.test(body), 'no FOR UPDATE found')

  // --- §2 / 091000 objects -------------------------------------------------------------------
  const idx = await q('SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname = ANY($2)', [
    'public',
    [
      'orders_restaurant_idempotency_key_unique',
      'order_line_allocation_settlements_one_per_allocation',
      'payment_events_restaurant_transaction_id_unique',
      'idx_orders_idempotency_key',
      'orders_idempotency_key_unique',
    ],
  ])
  const have = idx.map((r) => r.indexname)
  for (const n of [
    'orders_restaurant_idempotency_key_unique',
    'order_line_allocation_settlements_one_per_allocation',
    'payment_events_restaurant_transaction_id_unique',
  ]) {
    ok('index ' + n + ' exists', have.includes(n), JSON.stringify(have))
  }
  ok(
    'the OLD global idempotency indexes are gone (091000 drops them)',
    !have.includes('idx_orders_idempotency_key') && !have.includes('orders_idempotency_key_unique'),
    JSON.stringify(have),
  )

  const chk = await q("SELECT convalidated FROM pg_constraint WHERE conname='orders_payment_status_enumerated'")
  ok('CHECK orders_payment_status_enumerated exists and is VALIDATED', chk.length === 1 && chk[0].convalidated === true, JSON.stringify(chk))

  // --- the five intent columns 090000 adds ---------------------------------------------------
  const cols = await q(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='terminal_payment_intents' AND column_name = ANY($1)",
    [['consumed_at', 'gateway_amount_cents', 'gateway_transaction_id', 'gateway_payment_method', 'settled_order_ids']],
  )
  ok('all five terminal_payment_intents columns exist', cols.length === 5, cols.map((c) => c.column_name).join(' '))

  // --- §5.2/5.3/5.4, scoped to AFTER the deploy ---------------------------------------------
  const sets = await q(
    "SELECT count(*)::int n FROM public.audit_logs WHERE action='payment.settlement_applied' AND created_at > now() - interval '1 hour' AND (metadata->'intended_order_ids') IS DISTINCT FROM (metadata->'applied_order_ids')",
  )
  ok('§5.2 no settlement in the last hour applied a set different from the one it intended', sets[0].n === 0, 'mismatched=' + sets[0].n)

  const gap = await q(
    "SELECT count(*)::int n FROM public.orders o WHERE o.payment_status='paid' AND o.payment_method='card' AND o.paid_at > now() - interval '1 hour' AND NOT EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.event_type='sale' AND pe.order_ids @> ARRAY[o.id])",
  )
  ok('§5.3 no card order paid in the last hour lacks a ledger row', gap[0].n === 0, 'gap=' + gap[0].n)

  const mis = await q(
    "SELECT count(*)::int n FROM public.orders WHERE payment_status='paid' AND payment_method <> 'card' AND paycloud_merchant_order_no IS NOT NULL AND paid_at > now() - interval '1 hour'",
  )
  ok('§5.4 no card payment recorded under a non-card method in the last hour', mis[0].n === 0, 'n=' + mis[0].n)
} finally {
  await client.end().catch(() => {})
}

console.log('\nPOST-DEPLOY VERIFICATION: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
