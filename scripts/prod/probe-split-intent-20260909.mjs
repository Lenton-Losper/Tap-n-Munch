/**
 * WHAT HAPPENED TO THE SPLIT-CARD ATTEMPT AT DIGI COFEE. READ ONLY.
 *
 * Reported 2026-09-09 ~04:49: the waiter tapped Settle Selected on 131, WiseCashier never opened,
 * and the screen said "The card was declined and nothing was charged."
 *
 * The intent row is the only server-side record of whether the terminal got as far as asking. Three
 * possibilities, and they need different fixes:
 *
 *   no row at all      prepare-split-payment was never called, or it refused. The failure is before
 *                      any reference was minted.
 *   row, 'launched'    an intent was minted and nothing ever resolved it. The device asked for a
 *                      reference, then failed before or during the reader launch, and never
 *                      reported back.
 *   row, 'failed'      the device REPORTED a failure. It decided the charge failed and said so --
 *                      which, if the reader never opened, means it reported something it could not
 *                      know.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/8c74c58f-c231-44c3-982b-5acb1968c530/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'

function readSecret(name) {
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found`)
}

const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '-')

async function main() {
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
    const { rows: rc } = await client.query('SELECT count(*)::int AS n FROM public.restaurants')
    console.log(`identity: ${rc[0].n} restaurants (production is 11)`)
    if (rc[0].n !== 11) {
      console.log('REFUSING — not production')
      process.exitCode = 2
      return
    }

    console.log('\n' + '='.repeat(78))
    console.log('EVERY terminal_payment_intents ROW EVER')
    console.log('='.repeat(78))
    const { rows } = await client.query(
      `SELECT i.id, i.merchant_order_no, i.amount_cents, i.scope, i.status,
              i.created_at, i.resolved_at,
              array_length(i.allocation_ids, 1) AS n_allocs,
              r.name AS restaurant
         FROM public.terminal_payment_intents i
         LEFT JOIN public.restaurants r ON r.id = i.restaurant_id
        ORDER BY i.created_at DESC
        LIMIT 40`,
    )
    if (rows.length === 0) {
      console.log('  (no rows at all — no intent has ever been minted on production)')
    }
    for (const r of rows) {
      console.log(
        `  ${fmt(r.created_at)}  ${String(r.status).padEnd(9)} ${String(r.amount_cents).padStart(7)}c  ` +
          `allocs=${r.n_allocs ?? 0}  ${r.merchant_order_no}  ${r.restaurant ?? '?'}  resolved=${fmt(r.resolved_at)}`,
      )
    }

    console.log('\n' + '='.repeat(78))
    console.log('ALLOCATIONS CREATED AT DIGI COFEE TODAY (the allocate step runs BEFORE prepare)')
    console.log('='.repeat(78))
    const { rows: allocs } = await client.query(
      `SELECT a.id, a.order_id, a.allocated_to, a.amount_cents, a.created_at
         FROM public.order_line_allocations a
         JOIN public.orders o ON o.id = a.order_id
         JOIN public.restaurants r ON r.id = o.restaurant_id
        WHERE r.name ILIKE '%digi%'
          AND a.created_at > now() - interval '2 days'
        ORDER BY a.created_at DESC
        LIMIT 20`,
    )
    if (allocs.length === 0) console.log('  (none in the last 2 days)')
    for (const a of allocs) {
      console.log(
        `  ${fmt(a.created_at)}  ${String(a.amount_cents).padStart(7)}c  to=${a.allocated_to}  order=${String(a.order_id).slice(0, 8)}`,
      )
    }

    console.log('\n' + '='.repeat(78))
    console.log('AUDIT TRAIL — anything split-card shaped in the last 2 days')
    console.log('='.repeat(78))
    const { rows: audit } = await client.query(
      `SELECT created_at, action
         FROM public.audit_logs
        WHERE created_at > now() - interval '2 days'
          AND (action ILIKE '%split%' OR action ILIKE '%intent%' OR action ILIKE '%payment%')
        ORDER BY created_at DESC
        LIMIT 25`,
    )
    if (audit.length === 0) console.log('  (none)')
    for (const a of audit) {
      console.log(`  ${fmt(a.created_at)}  ${a.action}`)
    }
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exitCode = 1
})
