/**
 * READ ONLY. Watch for #121's fix firing for the first time on production.
 *
 * #121: the cash "Ready to Pay" button on the QR order-confirmation screen used to write straight
 * to the database with the browser anon client, and never once worked — the only anon UPDATE policy
 * on `orders` carries `WITH CHECK (status = 'ready_for_terminal')`, which a cash order's status
 * never satisfies. Worse than failing: on staging RLS filtered the row and PostgREST reported
 * success, so the component took its SUCCESS path and told the customer staff were coming while
 * nothing had been recorded.
 *
 * It was fixed on 2026-08-25 (760ed135) to POST to a service-role route. Measured 2026-08-26:
 * `customer_ready_to_pay` is true on ZERO production rows, and every QR cash order predates the
 * fix — so the fixed path has never run. Not evidence it failed; not evidence it works.
 *
 * This watches for the first real one. The owner places a QR cash order at Digi Cofee and presses
 * the button; this prints what the database actually recorded.
 *
 * WHAT IT PRINTS, AND WHY IT PRINTS THE ORDER EVEN WHEN THE FLAG IS FALSE. A watcher that only
 * announced success would be silent in the two cases that matter most — the order arriving and the
 * flag never flipping (the fix still broken), and the order never arriving at all (the button not
 * rendering, or the order not being a cash order). So it reports EVERY new cash order at the venue
 * and states the flag's value either way. Silence here means "no order yet", and nothing else.
 *
 * Usage: node scripts/prod/watch-121-cash-ready-20260826.mjs [venueName]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const VENUE = process.argv[2] || 'Digi Cofee'
const sec = (n) => {
  for (const l of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(n)
}

const c = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.ihlmmpmolnpchzgwyhgh',
  password: sec('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})
await c.connect()

const SINCE = new Date(Date.now() - 5 * 60 * 1000).toISOString()
const seen = new Map()

// Baseline, so a pre-existing row cannot be mistaken for the one just placed.
const { rows: base } = await c.query(
  `SELECT count(*) FILTER (WHERE customer_ready_to_pay)::int AS flagged, count(*)::int AS total
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
    WHERE r.name = $1`,
  [VENUE],
)
console.log(
  `WATCHING ${VENUE} — baseline: ${base[0].total} orders, ${base[0].flagged} with customer_ready_to_pay=true`,
)
console.log(`only orders placed after ${SINCE} count. Silence = no order yet.\n`)

for (;;) {
  const { rows } = await c.query(
    `SELECT o.id, o.order_number, o.total, o.channel, o.payment_method, o.payment_channel,
            o.payment_status, o.status, o.customer_ready_to_pay, o.placed_at
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE r.name = $1 AND o.placed_at > $2
      ORDER BY o.placed_at`,
    [VENUE, SINCE],
  )
  for (const o of rows) {
    const key = String(o.id)
    const flag = o.customer_ready_to_pay === true
    const prev = seen.get(key)
    if (prev === undefined) {
      const isCash =
        String(o.payment_method || '').toLowerCase() === 'cash' ||
        String(o.payment_channel || '').toLowerCase() === 'cash' ||
        String(o.payment_status || '').toLowerCase() === 'cash_pending'
      console.log(
        `NEW ORDER  #${o.order_number}  N$${o.total}  channel=${o.channel}  ` +
          `method=${o.payment_method}  payment_status=${o.payment_status}  ` +
          `${isCash ? 'CASH' : '*** NOT A CASH ORDER — the button will not render ***'}  ` +
          `customer_ready_to_pay=${flag}`,
      )
      seen.set(key, flag)
      continue
    }
    if (prev !== flag) {
      seen.set(key, flag)
      if (flag) {
        console.log(
          `*** FLAG FLIPPED TRUE  #${o.order_number}  N$${o.total} — #121's fix has fired on production for the first time ***`,
        )
      } else {
        console.log(`FLAG WENT FALSE  #${o.order_number} — unexpected, worth reading`)
      }
    }
  }
  await new Promise((r) => setTimeout(r, 4000))
}
