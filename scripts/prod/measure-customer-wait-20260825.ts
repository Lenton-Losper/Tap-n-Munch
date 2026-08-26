// @ts-nocheck
/**
 * READ ONLY. THE CUSTOMER'S 42 SECONDS — is there one, and does it produce the same behaviour?
 *
 * The terminal's number is established: 61% of Mingle's non-settling card sales are re-rung within
 * five minutes, median gap 42s. The claim to test here is that the QR customer sits in the same
 * silence. It should NOT be assumed by analogy — the customer's journey differs in a way that
 * matters, because for a hosted-checkout card payment the customer spends the wait on FINATIC'S
 * page, which we neither render nor time.
 *
 * Three questions:
 *   1. How long does a QR order actually take to flip to paid? That is the customer's wait.
 *   2. How many QR orders never flip at all, and how old do they get? A "Pending" badge that polls
 *      forever is only a problem if orders really do sit there.
 *   3. Does the customer re-place, the way staff re-ring? Same venue, same total, same session,
 *      short window — the customer-side twin of the terminal measurement.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import { isStressFixtureOrder, countStressFixtures } from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const WINDOW_MIN = 10

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production')
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })

  const { data: venues } = await db.from('restaurants').select('id,name')
  const byId = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from('orders')
      .select('id,restaurant_id,firebase_restaurant_id,order_number,total,status,payment_status,payment_method,payment_channel,channel,session_id,placed_at,paid_at,payment_checkout_url')
      .order('placed_at')
      .range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }

  /*
   * CORRECTED 2026-08-26. THIS SCRIPT'S FIRST RUN COUNTED 1358 QR ORDERS AND 891 QR CARD ORDERS.
   * 1314 of them were stress fixtures from 2026-04-27 and the real figures are 44 and 15.
   *
   * The damage was not the size of the number, it was the CONTROL. Section 3 reported "only 43 of
   * 1358 QR orders carry a session_id" and concluded the re-place scan was blind because session
   * ids are mostly absent. They are not: 43 of the 44 real QR orders carry one, 97.7%. The scan is
   * blind because production has forty-four QR orders. Same conclusion, wrong reason, and the wrong
   * reason pointed at instrumentation work that would have fixed nothing.
   *
   * The exclusion is imported rather than written here, because a filter each script remembers to
   * write is a filter some script forgets.
   */
  const isQr = (o) => {
    const ch = String(o.channel ?? '').toLowerCase()
    return ch !== 'pos' && ch !== 'terminal'
  }
  console.log('stress fixtures excluded: ' + countStressFixtures(rows) + ' of ' + rows.length + ' rows read')
  const qr = rows.filter((o) => isQr(o) && !isStressFixtureOrder(o))
  console.log('orders total ' + rows.length + '   customer-placed (QR/kiosk) ' + qr.length)

  const qrCard = qr.filter((o) => String(o.payment_method ?? '').toLowerCase() === 'card')
  console.log('of those, card ' + qrCard.length + '   cash ' + (qr.length - qrCard.length))

  // ---------------------------------------------------------------- 1. the wait
  const waits = qrCard
    .filter((o) => o.payment_status === 'paid' && o.paid_at && o.placed_at)
    .map((o) => (new Date(o.paid_at).getTime() - new Date(o.placed_at).getTime()) / 1000)
    .filter((s) => s >= 0 && s < 3600)
    .sort((a, b) => a - b)
  const pct = (p) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor((p / 100) * waits.length))] : 0)
  console.log('\n' + '='.repeat(88))
  console.log('1. THE CUSTOMER WAIT — QR card order, placed_at to paid_at   (n=' + waits.length + ')')
  console.log('='.repeat(88))
  /*
   * READ THIS BEFORE READING THE PERCENTILES. They are not customer waits.
   *
   * Established 2026-08-26: ten of the fourteen paid QR card orders were stamped paid_at by the
   * PRE-50f826f6 Close Table route, which bulk-wrote status/payment_status/paid_at/completed_at on
   * every open order at a table with no payment guard. Their `payments` rows show the gateway
   * completed 0.8-2.5 minutes after the order was placed; paid_at lands up to 129 minutes later,
   * shared to the millisecond across orders on DIFFERENT tabs, mixing card and cash.
   *
   * So placed_at -> paid_at measures when a member of staff pressed Close Table. The customer's
   * real wait, where it can be recovered at all, is placed_at -> payments.completed_at.
   */
  console.log('  *** THESE ARE NOT CUSTOMER WAITS. paid_at on 10 of these rows was written by the')
  console.log('  *** pre-2026-07-30 Close Table route, not by settlement. docs/the-876-2026-08-26.md')
  if (waits.length) {
    console.log('  p50 ' + pct(50).toFixed(0) + 's   p75 ' + pct(75).toFixed(0) + 's   p90 ' + pct(90).toFixed(0) +
      's   p95 ' + pct(95).toFixed(0) + 's   max ' + waits[waits.length - 1].toFixed(0) + 's')
    for (const b of [15, 30, 45, 60, 120, 300]) {
      const n = waits.filter((s) => s <= b).length
      console.log('    settled by ' + String(b).padStart(4) + 's: ' + ((100 * n) / waits.length).toFixed(1) + '%')
    }
  } else {
    console.log('  NO QR CARD ORDER HAS EVER SETTLED. That is the finding, not a gap in the data.')
  }

  // ---------------------------------------------------------------- 2. the ones that never flip
  const now = Date.now()
  const stuck = qrCard.filter((o) => o.payment_status !== 'paid' && o.status !== 'cancelled' && o.payment_status !== 'cancelled')
  console.log('\n' + '='.repeat(88))
  console.log('2. QR CARD ORDERS THAT NEVER FLIPPED — the "Pending" badge with nothing behind it')
  console.log('='.repeat(88))
  console.log('  ' + stuck.length + ' of ' + qrCard.length + ' QR card orders are not paid and not cancelled')
  for (const o of stuck.slice(0, 15)) {
    const ageH = (now - new Date(o.placed_at).getTime()) / 3600000
    console.log('    ' + (byId.get(o.restaurant_id) ?? '?').slice(0, 18).padEnd(19) +
      '#' + String(o.order_number).padEnd(6) + ' N$' + String(o.total).padEnd(7) +
      String(o.payment_status).padEnd(12) +
      (ageH < 48 ? ageH.toFixed(1) + 'h' : (ageH / 24).toFixed(1) + 'd').padEnd(8) +
      ' checkoutUrl=' + (o.payment_checkout_url ? 'yes' : 'no'))
  }
  if (stuck.length > 15) console.log('    ... and ' + (stuck.length - 15) + ' more')

  // ---------------------------------------------------------------- 3. does the customer re-place?
  console.log('\n' + '='.repeat(88))
  console.log('3. DOES THE CUSTOMER RE-PLACE? same session, same total, within ' + WINDOW_MIN + ' minutes')
  console.log('='.repeat(88))
  const bySession = new Map()
  for (const o of qr) {
    const key = String(o.session_id ?? '')
    if (!key) continue
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key).push(o)
  }
  let repeats = 0
  let repeatsAfterUnpaid = 0
  const examples = []
  for (const [, list] of bySession) {
    list.sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at))
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const dt = (new Date(list[j].placed_at).getTime() - new Date(a.placed_at).getTime()) / 1000
        if (dt > WINDOW_MIN * 60) break
        if (Number(list[j].total) !== Number(a.total)) continue
        repeats++
        if (a.payment_status !== 'paid') {
          repeatsAfterUnpaid++
          examples.push({
            venue: byId.get(a.restaurant_id) ?? '?',
            at: String(a.placed_at).slice(0, 19),
            from: a.order_number, fromS: a.payment_status,
            to: list[j].order_number, toS: list[j].payment_status,
            total: a.total, gapS: dt,
          })
        }
        break
      }
    }
  }
  /**
   * THE POSITIVE CONTROL, AND IT IS THE POINT OF THIS SECTION. A count of zero repeats is the
   * reassuring answer, and the reassuring answer is the one that gets shipped unchecked. Before
   * believing it, show that the scan COULD have found something: how many QR orders carry a
   * session_id at all, and how many sessions hold more than one order. If that last number is
   * near zero the scan was blind and "no customer re-places" means "not measurable".
   */
  const withSession = qr.filter((o) => String(o.session_id ?? '').trim())
  const multiOrderSessions = [...bySession.values()].filter((l) => l.length > 1).length
  console.log('  CONTROL — QR orders carrying a session_id: ' + withSession.length + ' of ' + qr.length)
  console.log('  CONTROL — distinct sessions ' + bySession.size + ', of which hold >1 order: ' + multiOrderSessions)
  if (multiOrderSessions < 5) {
    console.log('  *** THE SCAN IS BLIND. With ' + multiOrderSessions + ' multi-order session(s) it could not have')
    console.log('  *** found a re-place even if customers do it. Read the zero below as NOT MEASURABLE.')
  }
  console.log('  sessions with a same-total repeat inside the window: ' + repeats)
  console.log('  of those, where the FIRST order was not paid:        ' + repeatsAfterUnpaid)
  console.log('  (the terminal-side equivalent was 84/138 = 61% at Mingle)')
  for (const e of examples.slice(0, 15)) {
    console.log('    ' + e.at + '  ' + e.venue.slice(0, 18).padEnd(19) +
      '#' + e.from + '(' + e.fromS + ') -> #' + e.to + '(' + e.toS + ')  N$' + String(e.total).padEnd(6) +
      ' after ' + e.gapS.toFixed(0) + 's')
  }

  console.log('\nCUSTOMER_WAIT_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
