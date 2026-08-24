/**
 * PROVE THE 2026-08-24 MIGRATIONS LANDED ON PRODUCTION. READ ONLY.
 *
 * Deliberately verified two ways, because they answer different questions:
 *
 *   over POSTGRES   the schema is really there -- columns, functions, grants
 *   over POSTGREST  the DEPLOYED APP can see it. A column that exists but is not exposed through
 *                   PostgREST's schema cache is invisible to every route, and a function the app
 *                   cannot call is not deployed as far as the app is concerned.
 *
 * The PostgREST half is the one that matters for the worker deploy, and it is the half a psql-only
 * check would miss entirely.
 *
 * FOR THE FUNCTIONS, THE DISCRIMINATOR IS THE ERROR. Calling with a nil uuid:
 *   PGRST202 / "Could not find the function"  -> NOT deployed
 *   anything else (a raised exception, "not found" from inside the function) -> deployed
 * A function that exists RAISES; a function that does not is a routing failure. Those look similar
 * in a log and mean opposite things.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'

function readSecret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

let failures = 0
const check = (ok, label, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}${detail ? '  ' + detail : ''}`)
}

async function main() {
  console.log('='.repeat(78))
  console.log(`EFFECT PROOF — production ${PROD_REF}. READ ONLY.`)
  console.log('='.repeat(78))

  const client = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROD_REF}`,
    password: readSecret('SUPABASE_DB_PASSWORD_PROD'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  await client.connect()

  try {
    console.log('\nOVER POSTGRES — is the schema really there?')
    const { rows: cols } = await client.query(
      `SELECT column_name, data_type, is_generated
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='restaurants'
          AND column_name IN ('is_counter_service','card_payments_available')
        ORDER BY column_name`,
    )
    check(cols.length === 2, 'both columns exist on restaurants', cols.map((c) => c.column_name).join(', '))
    const generated = cols.find((c) => c.column_name === 'card_payments_available')
    check(
      String(generated?.is_generated).toUpperCase() === 'ALWAYS',
      'card_payments_available is GENERATED, so it cannot drift from the credentials',
      String(generated?.is_generated),
    )

    const { rows: fns } = await client.query(
      `SELECT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.proname IN ('reap_abandoned_tab','reject_transfer','return_transfer_stock_to_source','cancel_transfer')
        ORDER BY p.proname`,
    )
    const names = fns.map((f) => f.proname)
    for (const fn of ['reap_abandoned_tab', 'reject_transfer', 'return_transfer_stock_to_source', 'cancel_transfer']) {
      check(names.includes(fn), `function ${fn} exists`)
    }

    // The 20260727140000 lesson: anon once cancelled a real cross-tenant transfer through PostgREST.
    const { rows: grants } = await client.query(
      `SELECT p.proname, r.rolname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL (VALUES ('anon'),('authenticated')) AS r(rolname)
        WHERE n.nspname='public'
          AND p.proname IN ('reap_abandoned_tab','reject_transfer','return_transfer_stock_to_source','cancel_transfer')
          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    )
    check(
      grants.length === 0,
      'anon and authenticated CANNOT execute any of the four functions',
      grants.length ? grants.map((g) => `${g.rolname}->${g.proname}`).join(', ') : 'none can',
    )

    const { rows: statusCheck } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='stock_transfers_status_check'`,
    )
    check(
      String(statusCheck[0]?.def ?? '').includes('REJECTED'),
      'stock_transfers_status_check accepts REJECTED',
      String(statusCheck[0]?.def ?? '').slice(0, 60),
    )

    const { rows: reasonCheck } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='stock_movements_reason_check'`,
    )
    check(
      String(reasonCheck[0]?.def ?? '').includes('transfer_return'),
      'stock_movements_reason_check accepts transfer_return',
    )

    const { rows: counter } = await client.query(
      `SELECT name, is_counter_service, card_payments_available FROM public.restaurants ORDER BY name`,
    )
    console.log(`\n  venues: ${counter.length}`)
    console.log(`  counter service today: ${counter.filter((r) => r.is_counter_service).length}  (step 3 sets the two named)`)
    console.log('  card_payments_available, derived from the Finatic credentials:')
    for (const r of counter) {
      console.log(
        `    ${String(r.name).slice(0, 34).padEnd(36)} counter=${String(r.is_counter_service).padEnd(5)} card=${r.card_payments_available}`,
      )
    }

    // ---------------------------------------------------------------- the half that matters
    console.log('\nOVER POSTGREST — can the DEPLOYED APP see it?')
    const url = `https://${PROD_REF}.supabase.co`
    const key = readSecret('SUPABASE_SERVICE_ROLE_KEY')
    if (!key) {
      console.log('  SKIPPED — no service role key available here.')
      console.log('  This half is NOT optional: a column present in Postgres but absent from')
      console.log('  PostgREST\'s schema cache is invisible to every route. Run it before deploying.')
      failures++
    } else {
      const rest = async (path, init) => {
        const res = await fetch(`${url}${path}`, {
          ...init,
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        })
        return { status: res.status, body: await res.text() }
      }

      for (const col of ['is_counter_service', 'card_payments_available']) {
        const r = await rest(`/rest/v1/restaurants?select=id,${col}&limit=1`)
        check(r.status === 200, `PostgREST can select restaurants.${col}`, `HTTP ${r.status} ${r.body.slice(0, 70)}`)
      }

      const NIL = '00000000-0000-0000-0000-000000000000'
      for (const [fn, args] of [
        ['reap_abandoned_tab', { p_tab_id: NIL, p_inactive_hours: 4 }],
        ['reject_transfer', { p_transfer_id: NIL, p_user_id: NIL, p_reason: 'probe' }],
        ['return_transfer_stock_to_source', { p_transfer_id: NIL, p_user_id: NIL, p_reason: 'probe' }],
      ]) {
        const r = await rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
        const missing = /PGRST202|Could not find the function/i.test(r.body)
        check(!missing, `${fn} is callable (not PGRST202)`, `HTTP ${r.status} ${r.body.slice(0, 60)}`)
      }
    }

    console.log(failures === 0 ? '\nVERIFY_MIGRATIONS_APPLIED_OK' : `\n*** ${failures} CHECK(S) FAILED ***`)
    if (failures > 0) process.exitCode = 1
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
