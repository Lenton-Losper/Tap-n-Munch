/**
 * ONE-OFF. Cancels Mingle order #694 — a CONFIRMED DUPLICATE CASH payment. WRITES.
 *
 * The venue reported that one N$210 cash payment was taken and a second staff member rang it up
 * again. The owner ruled on that report. This is not an automated decision and not a gateway
 * finding: the money WAS collected once, and what is being corrected is a second RECORD of it.
 *
 * Read-only verification first, and it REFUSES rather than proceeding if any premise fails:
 *   - the venue is Mingle and the order is #694
 *   - both #690 and #694 are cash, paid, and carry NO gateway reference of any kind
 *   - they are genuine duplicates: same total, same single line
 *   - #694 is not already cancelled
 *
 * #690 IS NOT TOUCHED. The earlier order is the real one.
 *
 * Usage:  node scripts/prod/cancel-694-mingle-duplicate.mjs            (dry run)
 *         node scripts/prod/cancel-694-mingle-duplicate.mjs --confirm  (writes)
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/')
const { Client } = require('pg')
const E = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec = n => { for (const l of readFileSync(E,'utf8').split(/\r?\n/)) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m&&m[1]===n) return m[2].trim().replace(/^["']|["']$/g,'') } return '' }
const CONFIRM = process.argv.includes('--confirm')
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const die = m => { console.error(`\nREFUSING: ${m}`); process.exit(1) }

const db = new Client({ host:'aws-0-eu-west-1.pooler.supabase.com', port:5432,
  user:`postgres.${PROD_REF}`, password:sec('SUPABASE_DB_PASSWORD_PROD'),
  database:'postgres', ssl:{rejectUnauthorized:false} })
await db.connect()
const q = async (s,p=[]) => (await db.query(s,p)).rows

try {
  const [venue] = await q(`SELECT id, name FROM restaurants WHERE name ILIKE '%mingle%'`)
  if (!venue) die('no venue matching "mingle"')
  console.log(`venue: ${venue.name}  ${venue.id}`)

  const rows = await q(`SELECT order_number, id, status, payment_status, payment_method,
      total::numeric, COALESCE(paycloud_merchant_order_no,'') mo, payment_attempt_started_at ats, items
    FROM orders WHERE restaurant_id=$1 AND order_number IN (690,694) ORDER BY order_number`, [venue.id])
  if (rows.length !== 2) die(`expected both #690 and #694, found ${rows.length}`)
  const [a, b] = rows

  console.log('\nPREMISE CHECKS — every one must pass or nothing is written:')
  const check = (ok, label) => { console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}`); if (!ok) die(label) }
  for (const o of rows) {
    check(o.payment_method === 'cash', `#${o.order_number} is CASH (found ${o.payment_method})`)
    check(String(o.payment_status) === 'paid', `#${o.order_number} is paid`)
    check(o.mo === '', `#${o.order_number} has NO gateway merchant order number`)
    check(o.ats === null, `#${o.order_number} never started a card attempt`)
  }
  check(Number(a.total) === Number(b.total), `same total (N$${a.total})`)
  const line = o => { try { const i = typeof o.items==='string'?JSON.parse(o.items):o.items
      return (Array.isArray(i)?i:[]).map(x=>`${x.quantity}x${x.name}`).join('|') } catch { return '?' } }
  check(line(a) === line(b) && line(a) !== '?', `identical line items (${line(a)})`)
  check(String(b.status) !== 'cancelled', '#694 is not already cancelled')

  const before = (await q(`SELECT COALESCE(sum(total),0)::numeric r FROM orders
     WHERE restaurant_id=$1 AND placed_at::date=CURRENT_DATE AND payment_status='paid' AND status<>'cancelled'`, [venue.id]))[0].r
  console.log(`\nMingle revenue today BEFORE: N$${before}`)

  if (!CONFIRM) { console.log('\nDRY RUN — all premises passed. Re-run with --confirm to cancel #694.'); process.exit(0) }

  const reason =
    'Duplicate cash payment. The venue reported that one N$210 cash payment was taken for ' +
    '"Coffee and muffin x7" and a second staff member rang it up again as #694. OPERATOR RULING by ' +
    'the owner on that report, 2026-08-25 — not an automated decision and not a gateway finding. ' +
    'The money was collected once; this cancels the duplicate RECORD. #690 is the real order and is ' +
    'untouched.'

  const cancelledAt = new Date().toISOString()
  const upd = await q(`UPDATE orders SET status='cancelled', payment_status='cancelled',
       cancelled_at=$3, cancellation_reason=$4
     WHERE id=$1 AND restaurant_id=$2 AND status <> 'cancelled' RETURNING id, order_number, total`,
    [b.id, venue.id, cancelledAt, reason])
  if (!upd.length) die('the UPDATE matched no row — someone else changed it first. Nothing written.')
  console.log(`\ncancelled #${upd[0].order_number} (${upd[0].id})`)

  await db.query(`INSERT INTO audit_logs (restaurant_id, entity_type, entity_id, action, metadata)
     VALUES ($1,'order',$2,'order.cancelled',$3)`, [venue.id, b.id, JSON.stringify({
      basis: 'operator_duplicate_ruling',
      basisNote:
        'A HUMAN RULED THIS A DUPLICATE. Not an automated decision and not a gateway finding -- the ' +
        'venue reported that one payment was taken and rung up twice, and the owner ruled on that ' +
        'report. The money WAS collected; what is being corrected is a second record of it. ' +
        'Deliberately distinct from `no_gateway_reference`, which asserts NO CHARGE IS POSSIBLE -- ' +
        'true of a card that never reached prepare-payment, and false here, where cash changed hands.',
      cancellationReason: reason,
      cancelledAt,
      orderTotal: b.total,
      businessOrderNo: null,
      duplicateOf: `#${a.order_number}`,
      duplicateOfId: a.id,
      reportedBy: 'venue (Mingle)',
      ruledBy: 'owner',
    })])
  console.log('audit row written: order.cancelled / operator_duplicate_ruling')

  const after = (await q(`SELECT COALESCE(sum(total),0)::numeric r FROM orders
     WHERE restaurant_id=$1 AND placed_at::date=CURRENT_DATE AND payment_status='paid' AND status<>'cancelled'`, [venue.id]))[0].r
  console.log(`\nMingle revenue today AFTER : N$${after}   (was N$${before}, expected N$${Number(before)-210})`)
  const [check690] = await q(`SELECT order_number, status, payment_status FROM orders WHERE id=$1`, [a.id])
  console.log(`#690 untouched: ${check690.status}/${check690.payment_status}`)
  console.log('\nCANCEL_694_OK')
} finally { await db.end().catch(()=>{}) }
