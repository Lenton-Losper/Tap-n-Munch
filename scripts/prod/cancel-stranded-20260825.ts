// @ts-nocheck
/**
 * CANCEL THE STRANDED card_manual ORDERS AT FNB CHOWNOW AND MINGLE — 2026-08-25.
 * Read-only unless invoked with --write.
 *
 * THE RULE. An order is cancelled only on a CONJUNCTION, re-established for that order inside this
 * same run, immediately before its own write:
 *
 *   (a) it is still pending, and carries neither payment_reference nor payment_voucher_no; AND
 *   (b) a live Finatic order.query on its own merchant order number answers E04111.
 *
 * WHY (a) IS NOT ENOUGH, and this is the whole reason the gateway leg exists. Measured on
 * production today: ChowNow #456, #500 and #546 are PAID, carry neither marker, and the gateway
 * returns PAID for all three. Marker-absence alone would have cancelled N$201 of real charges.
 *
 * WHY (b) IS NOT ENOUGH EITHER. E04111 is an error, not a not-paid status. A broken query path —
 * wrong credentials, expired session, gateway outage — answers "error" for everything, and that is
 * exactly the answer that would authorise a cancel. So EVERY iteration first re-queries a LIVE
 * POSITIVE CONTROL: an order known to be paid, at the same venue, with the same credentials. If a
 * control does not come back PAID, the run aborts and nothing further is written. ChowNow's control
 * is deliberately #546 — paid, and carrying NEITHER marker — so the control exercises precisely the
 * false positive that would do the damage.
 *
 * ANYTHING ELSE IS SKIPPED AND NAMED. paid, not_paid, a non-E04111 error, a marker that appeared, a
 * status that moved: all skip. Unreachable is not "not charged".
 *
 * The write goes through cancelOrderWithTrail with guard 'require_pending', so a terminal callback
 * that settles the order a millisecond earlier WINS and this reports cancelled:false.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const WRITE = process.argv.includes('--write')
const VENUES = [
  /**
   * `only` IS AN AUTHORISATION BOUNDARY, NOT A FILTER. The owner's instruction named every
   * non-settled ChowNow order, and at Mingle named exactly three. Mingle has SIX MORE that meet
   * every technical test (#435 #462 #494 #523 #548 #615, N$315 total, 4-12 days old) and they are
   * deliberately NOT cancelled here: passing the evidence test is not the same as being ruled on.
   * They are reported at the end so the omission is visible rather than silent.
   */
  { id: 'b161c758-582d-4dfa-839a-9fa35c492a49', label: 'FNB ChowNow', controlOrderNo: 546, only: null },
  { id: '131c39d1-b816-407d-8c5f-e628fc38967e', label: 'Mingle Brew & Pour', controlOrderNo: 678, only: [667, 676, 677] },
]

const REASON =
  'Operator ruling on direct confirmation: staff cancelled this card payment at the reader before ' +
  'anything was sent to the gateway, so no charge exists and the order was stranded pending. ' +
  'Confirmed for this order in the same run by a live Finatic order.query answering E04111 with ' +
  'neither payment marker set, alongside a passing live positive control. Ruled by a person, not ' +
  'an automated sweep.'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { queryFinaticOrderPaid } = await import('../../lib/payments/query-finatic-order-paid')
  const { cancelOrderWithTrail } = await import('../../lib/orders/cancel-order-with-trail')

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production - ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log(WRITE ? '*** WRITE MODE ***' : '--- DRY RUN (pass --write to act) ---')

  const todayStart = '2026-08-25T00:00:00Z'
  const revenue = async (rid) => {
    const { data } = await db
      .from('orders')
      .select('total')
      .eq('restaurant_id', rid)
      .eq('payment_status', 'paid')
      .gte('placed_at', todayStart)
    return (data ?? []).reduce((s, o) => s + Number(o.total || 0), 0)
  }
  const outstanding = async (rid) => {
    const { data } = await db
      .from('orders')
      .select('order_number,total')
      .eq('restaurant_id', rid)
      .eq('payment_status', 'pending')
      .neq('status', 'cancelled')
    return { n: (data ?? []).length, value: (data ?? []).reduce((s, o) => s + Number(o.total || 0), 0) }
  }

  const summary = []
  for (const v of VENUES) {
    console.log('\n' + '='.repeat(78) + '\n' + v.label + '\n' + '='.repeat(78))
    const { data: venue } = await db
      .from('restaurants')
      .select('finatic_merchant_no,finatic_store_no')
      .eq('id', v.id)
      .single()
    if (!venue?.finatic_merchant_no || !venue?.finatic_store_no) {
      console.log('  SKIPPING VENUE: no Finatic credentials, so nothing here is verifiable.')
      continue
    }
    const gw = { merchantNo: String(venue.finatic_merchant_no), storeNo: String(venue.finatic_store_no) }
    const ask = async (bno) => {
      try {
        const r = await queryFinaticOrderPaid({ merchantOrderNo: bno, ...gw })
        return { verdict: r.paid ? 'PAID' : 'not_paid', amount: r.amount }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        return { verdict: m.includes('E04111') ? 'E04111' : 'ERROR', msg: m }
      }
    }

    const { data: ctl } = await db
      .from('orders')
      .select('order_number,total,payment_status,paycloud_merchant_order_no,payment_reference,payment_voucher_no')
      .eq('restaurant_id', v.id)
      .eq('order_number', v.controlOrderNo)
      .single()
    if (!ctl?.paycloud_merchant_order_no || ctl.payment_status !== 'paid') {
      throw new Error('control #' + v.controlOrderNo + ' is not a usable control')
    }
    console.log(
      'control: #' + ctl.order_number + ' N$' + ctl.total + ' paid, markers ' +
        (ctl.payment_reference || ctl.payment_voucher_no ? 'present' : 'ABSENT (the hard case)'),
    )

    const revBefore = await revenue(v.id)
    const outBefore = await outstanding(v.id)
    console.log(
      'BEFORE  revenue today N$' + revBefore.toFixed(2) +
        '   outstanding pending: ' + outBefore.n + ' order(s) N$' + outBefore.value.toFixed(2),
    )

    const { data: cands } = await db
      .from('orders')
      .select('id,order_number,total,status,payment_status,paycloud_merchant_order_no,payment_reference,payment_voucher_no,placed_at')
      .eq('restaurant_id', v.id)
      .eq('payment_status', 'pending')
      .neq('status', 'cancelled')
      .order('order_number')
    console.log('candidates: ' + (cands ?? []).length + '\n')

    const notRuled = []
    for (const o of cands ?? []) {
      const tag = '#' + String(o.order_number).padEnd(6) + ' N$' + String(o.total).padEnd(6)
      if (v.only && !v.only.includes(o.order_number)) {
        notRuled.push(o)
        console.log(tag + ' NOT RULED ON - no ruling from the owner covers this order at this venue. Left pending.')
        continue
      }

      // 1. LIVE POSITIVE CONTROL, re-run for THIS candidate, immediately before its own write.
      const c = await ask(ctl.paycloud_merchant_order_no)
      if (c.verdict !== 'PAID') {
        console.log(
          tag + ' ABORT RUN - control #' + ctl.order_number + ' came back ' + c.verdict +
            '. The query path is not trustworthy; nothing further will be written.',
        )
        throw new Error('positive control failed at ' + v.label + ' before #' + o.order_number)
      }

      // 2. Re-read the row itself. It may have settled since the enumeration above.
      const { data: fresh } = await db
        .from('orders')
        .select('status,payment_status,payment_reference,payment_voucher_no,paycloud_merchant_order_no')
        .eq('id', o.id)
        .single()
      if (fresh.payment_status !== 'pending' || fresh.status === 'cancelled') {
        console.log(tag + ' SKIP - moved to ' + fresh.status + '/' + fresh.payment_status + ' since enumeration')
        continue
      }
      if (fresh.payment_reference || fresh.payment_voucher_no) {
        console.log(
          tag + ' SKIP - a payment marker is now set (ref=' + (fresh.payment_reference ?? '-') +
            ' voucher=' + (fresh.payment_voucher_no ?? '-') + '). This one reached the gateway.',
        )
        continue
      }
      if (!fresh.paycloud_merchant_order_no) {
        console.log(tag + ' SKIP - no merchant order number, so the gateway leg cannot be run at all.')
        continue
      }

      // 3. Gateway truth for THIS order, now.
      const r = await ask(fresh.paycloud_merchant_order_no)
      if (r.verdict === 'PAID') {
        console.log(tag + ' SKIP - GATEWAY SAYS PAID (amount ' + r.amount + '). Needs settling, not cancelling.')
        continue
      }
      if (r.verdict !== 'E04111') {
        console.log(
          tag + ' SKIP - gateway answered ' + r.verdict + ' (' + (r.msg ?? r.amount) +
            '). Not "no charge"; unreachable is not not-charged.',
        )
        continue
      }

      if (!WRITE) {
        console.log(tag + ' WOULD CANCEL - control PAID, markers absent, gateway E04111')
        continue
      }
      const res = await cancelOrderWithTrail(db, {
        orderId: o.id,
        restaurantId: v.id,
        cancellationReason: REASON,
        basis: 'e04111_no_attempt_reached_gateway',
        guard: 'require_pending',
        actorKind: 'system',
        actorUserId: null,
        metadata: {
          ruledBy: 'owner (Lenton) - operator ruling on direct confirmation, 2026-08-25',
          venue: v.label,
          businessOrderNo: fresh.paycloud_merchant_order_no,
          gatewayAnswer: 'E04111 Merchant order number is invalid',
          gatewayAskedAt: new Date().toISOString(),
          positiveControl: {
            orderNumber: ctl.order_number,
            verdict: 'PAID',
            note: 'live control re-queried in this same iteration; a broken query path would have aborted the run',
          },
          markersAtCancel: { payment_reference: null, payment_voucher_no: null },
          script: 'scripts/prod/cancel-stranded-20260825.ts',
        },
      })
      console.log(tag + (res.cancelled ? ' CANCELLED' : ' NOT CANCELLED - lost the guard race, order settled concurrently'))
    }

    if (notRuled.length > 0) {
      console.log(
        '\nLEFT PENDING because no ruling covers them: ' +
          notRuled.map((o) => '#' + o.order_number + ' N$' + o.total).join(', ') +
          '   (total N$' + notRuled.reduce((s2, o) => s2 + Number(o.total || 0), 0).toFixed(2) + ')',
      )
    }

    const revAfter = await revenue(v.id)
    const outAfter = await outstanding(v.id)
    console.log(
      '\nAFTER   revenue today N$' + revAfter.toFixed(2) +
        '   outstanding pending: ' + outAfter.n + ' order(s) N$' + outAfter.value.toFixed(2),
    )
    console.log(
      revAfter === revBefore
        ? '        revenue UNCHANGED, as it must be - every order touched was pending, never paid.'
        : '        *** REVENUE MOVED - investigate, a pending cancel must not change takings ***',
    )
    summary.push({ v: v.label, revBefore, revAfter, outBefore, outAfter })
  }

  console.log('\n' + '='.repeat(78) + '\nSUMMARY\n' + '='.repeat(78))
  for (const s of summary) {
    console.log(
      '  ' + s.v.padEnd(20) + ' revenue N$' + s.revBefore.toFixed(2) + ' -> N$' + s.revAfter.toFixed(2) +
        '   pending ' + s.outBefore.n + ' (N$' + s.outBefore.value.toFixed(2) + ') -> ' +
        s.outAfter.n + ' (N$' + s.outAfter.value.toFixed(2) + ')',
    )
  }
  console.log('\nCANCEL_STRANDED_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
