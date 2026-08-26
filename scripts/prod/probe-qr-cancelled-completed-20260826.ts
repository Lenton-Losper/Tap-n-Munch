// @ts-nocheck
/**
 * READ ONLY. THE 876.
 *
 * 876 of 891 QR card orders carry payment_status='cancelled' while status='completed'. Two
 * readings, and they have opposite consequences:
 *
 *   A. The field means something other than what it says -- the orders were paid, and some later
 *      writer stamps 'cancelled' over a settled row. Then the money is fine and the REPORTING is
 *      wrong, everywhere payment_status is read.
 *   B. The QR card path has been broken since launch -- customers never actually pay, the cron
 *      cancels the abandoned checkout, and something else marks the order completed anyway. Then
 *      the money is missing and the kitchen has been serving food that was never paid for.
 *
 * The two are told apart by EVIDENCE OF PAYMENT that is independent of payment_status: paid_at, a
 * gateway reference, a payments row, a receipt document, an audit trail. If a cancelled order
 * carries gateway evidence, it was paid. If it carries none, it was not.
 *
 * And by ORDER OF WRITES: cancelled_at vs completed_at says which writer went last, which is the
 * difference between "cancel stamped over a sale" and "completed stamped over a cancel".
 *
 * The venue breakdown is not decoration. Riviera and Digi Cofee are TEST accounts; 876 orders at a
 * test venue is a different finding from 876 at a live one, and the count alone cannot tell them
 * apart.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const H = (t) => { console.log('\n' + '='.repeat(100)); console.log(t); console.log('='.repeat(100)) }

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)

  const { data: venues } = await db.from('restaurants').select('id,name')
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const COLS = 'id,restaurant_id,order_number,table_number,tab_id,session_id,status,payment_status,' +
    'payment_method,payment_channel,channel,total,is_closed,table_closed,placed_at,accepted_at,' +
    'completed_at,paid_at,cancelled_at,cancellation_reason,payment_attempt_started_at,' +
    'payment_attempt_source,payment_provider,payment_reference,paycloud_merchant_order_no,' +
    'paycloud_transaction_id,payment_trans_no,payment_voucher_no,payment_checkout_url,updated_at'

  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders').select(COLS).order('placed_at').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  console.log('orders read: ' + rows.length)

  const isQr = (o) => { const c = String(o.channel ?? '').toLowerCase(); return c !== 'pos' && c !== 'terminal' }
  const isCard = (o) => String(o.payment_method ?? '').toLowerCase() === 'card'
  const qrCard = rows.filter((o) => isQr(o) && isCard(o))
  const posCard = rows.filter((o) => !isQr(o) && isCard(o))

  // ------------------------------------------------------------------ 1. reproduce the number
  H('1. THE CROSS-TAB -- payment_status x status, QR card orders (n=' + qrCard.length + ')')
  const tab = new Map()
  for (const o of qrCard) {
    const k = String(o.payment_status) + ' | ' + String(o.status)
    tab.set(k, (tab.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...tab].sort((a, b) => b[1] - a[1])) console.log('  ' + pad(k, 34) + String(n).padStart(5))

  const cohort = qrCard.filter((o) => o.payment_status === 'cancelled' && o.status === 'completed')
  console.log('\n  COHORT (cancelled + completed): ' + cohort.length +
    '   N$' + cohort.reduce((s, o) => s + Number(o.total ?? 0), 0).toFixed(2) + ' of order value')

  const posCohort = posCard.filter((o) => o.payment_status === 'cancelled' && o.status === 'completed')
  console.log('  CONTROL -- POS card orders in the same state: ' + posCohort.length + ' of ' + posCard.length)

  // ------------------------------------------------------------------ 2. who and when
  H('2. WHERE THE COHORT LIVES -- venue, month, channel, reason')
  const count = (list, f) => {
    const m = new Map()
    for (const o of list) { const k = String(f(o)); m.set(k, (m.get(k) ?? 0) + 1) }
    return [...m].sort((a, b) => b[1] - a[1])
  }
  const dims = [
    ['venue', (o) => vname.get(o.restaurant_id) ?? o.restaurant_id],
    ['channel', (o) => o.channel],
    ['payment_channel', (o) => o.payment_channel],
    ['cancellation_reason', (o) => o.cancellation_reason],
    ['payment_attempt_source', (o) => o.payment_attempt_source],
    ['payment_provider', (o) => o.payment_provider],
    ['month placed', (o) => String(o.placed_at).slice(0, 7)],
  ]
  for (const [label, f] of dims) {
    console.log('\n  by ' + label + ':')
    for (const [k, n] of count(cohort, f).slice(0, 16)) console.log('    ' + pad(k, 42) + String(n).padStart(5))
  }

  // ------------------------------------------------------------------ 3. evidence of payment
  H('3. EVIDENCE OF PAYMENT, independent of payment_status (n=' + cohort.length + ')')
  const has = (o, k) => { const v = o[k]; return v !== null && v !== undefined && String(v).trim() !== '' }
  const signals = ['paid_at', 'payment_attempt_started_at', 'payment_checkout_url', 'payment_reference',
    'paycloud_merchant_order_no', 'paycloud_transaction_id', 'payment_trans_no', 'payment_voucher_no',
    'accepted_at', 'completed_at', 'cancelled_at', 'is_closed', 'table_closed']
  for (const s of signals) {
    const n = cohort.filter((o) => has(o, s) && o[s] !== false).length
    console.log('  ' + pad(s, 30) + String(n).padStart(5) + ' of ' + cohort.length +
      '  (' + ((100 * n) / Math.max(1, cohort.length)).toFixed(1) + '%)')
  }
  const anyGateway = cohort.filter((o) =>
    has(o, 'paycloud_transaction_id') || has(o, 'payment_trans_no') || has(o, 'payment_voucher_no') || has(o, 'paid_at'))
  console.log('\n  carrying ANY settlement signal (txn id / trans no / voucher / paid_at): ' + anyGateway.length)
  for (const o of anyGateway.slice(0, 12)) {
    console.log('    #' + pad(o.order_number, 7) + pad(vname.get(o.restaurant_id) ?? '?', 16) +
      'paid_at=' + pad(String(o.paid_at ?? '-').slice(0, 16), 18) +
      'txn=' + pad(o.paycloud_transaction_id, 20) + 'trans=' + pad(o.payment_trans_no, 18))
  }

  // the same evidence, for the PAID QR card orders -- the positive control on the evidence test
  const paidCohort = qrCard.filter((o) => o.payment_status === 'paid')
  console.log('\n  POSITIVE CONTROL -- the same signals on the ' + paidCohort.length + ' QR card orders marked PAID:')
  for (const s of signals) {
    const n = paidCohort.filter((o) => has(o, s) && o[s] !== false).length
    console.log('    ' + pad(s, 30) + String(n).padStart(4) + ' of ' + paidCohort.length)
  }

  // ------------------------------------------------------------------ 4. which writer went last
  H('4. ORDER OF WRITES -- cancelled_at vs completed_at')
  let cancelFirst = 0, completeFirst = 0, sameOrMissing = 0
  const gaps = []
  for (const o of cohort) {
    if (!o.cancelled_at || !o.completed_at) { sameOrMissing++; continue }
    const d = (new Date(o.completed_at).getTime() - new Date(o.cancelled_at).getTime()) / 1000
    gaps.push(d)
    if (d > 0) cancelFirst++
    else if (d < 0) completeFirst++
    else sameOrMissing++
  }
  console.log('  cancelled_at BEFORE completed_at (cancel, then completed): ' + cancelFirst)
  console.log('  completed_at BEFORE cancelled_at (completed, then cancel): ' + completeFirst)
  console.log('  one of the two timestamps missing / identical:            ' + sameOrMissing)
  if (gaps.length) {
    gaps.sort((a, b) => a - b)
    const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor((p / 100) * gaps.length))]
    console.log('  gap seconds  min ' + q(0).toFixed(0) + '  p25 ' + q(25).toFixed(0) + '  p50 ' + q(50).toFixed(0) +
      '  p75 ' + q(75).toFixed(0) + '  max ' + gaps[gaps.length - 1].toFixed(0))
  }

  const placedToCancel = cohort.filter((o) => o.cancelled_at && o.placed_at)
    .map((o) => (new Date(o.cancelled_at).getTime() - new Date(o.placed_at).getTime()) / 60000)
    .sort((a, b) => a - b)
  if (placedToCancel.length) {
    const q = (p) => placedToCancel[Math.min(placedToCancel.length - 1, Math.floor((p / 100) * placedToCancel.length))]
    console.log('\n  placed_at -> cancelled_at, MINUTES:  min ' + q(0).toFixed(1) + '  p25 ' + q(25).toFixed(1) +
      '  p50 ' + q(50).toFixed(1) + '  p75 ' + q(75).toFixed(1) + '  max ' + placedToCancel[placedToCancel.length - 1].toFixed(1))
    console.log('  (expireHostedPendingOrders fires at 10 minutes. a tight cluster just past 10 IS that cron.)')
    for (const b of [1, 5, 10, 10.5, 11, 12, 15, 30, 60]) {
      console.log('    within ' + String(b).padStart(5) + ' min: ' + placedToCancel.filter((m) => m <= b).length)
    }
  }

  const placedToComplete = cohort.filter((o) => o.completed_at && o.placed_at)
    .map((o) => (new Date(o.completed_at).getTime() - new Date(o.placed_at).getTime()) / 60000)
    .sort((a, b) => a - b)
  if (placedToComplete.length) {
    const q = (p) => placedToComplete[Math.min(placedToComplete.length - 1, Math.floor((p / 100) * placedToComplete.length))]
    console.log('\n  placed_at -> completed_at, MINUTES:  min ' + q(0).toFixed(1) + '  p25 ' + q(25).toFixed(1) +
      '  p50 ' + q(50).toFixed(1) + '  p75 ' + q(75).toFixed(1) + '  max ' + placedToComplete[placedToComplete.length - 1].toFixed(1))
  }

  // ------------------------------------------------------------------ 5. corroborating tables
  H('5. THE OTHER TABLES -- payments, receipt_documents, audit_logs')
  const ids = new Set(cohort.map((o) => String(o.id)))

  const pays = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('payments')
      .select('id,restaurant_id,order_ids,amount,method,status,gateway_reference,payment_reference,created_at,completed_at').range(f, f + 999)
    if (error) { console.log('  payments: ERROR ' + error.message); break }
    pays.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const payByOrder = new Map()
  for (const p of pays) for (const oid of (p.order_ids ?? [])) {
    const k = String(oid)
    if (!payByOrder.has(k)) payByOrder.set(k, [])
    payByOrder.get(k).push(p)
  }
  const cohortWithPayment = [...ids].filter((i) => payByOrder.has(i))
  console.log('  payments rows on production: ' + pays.length + '   distinct order ids referenced: ' + payByOrder.size)
  console.log('  COHORT orders with a payments row: ' + cohortWithPayment.length + ' of ' + cohort.length)
  console.log('  CONTROL -- of the ' + paidCohort.length + ' QR card orders marked PAID, with a payments row: ' +
    paidCohort.filter((o) => payByOrder.has(String(o.id))).length)

  const receipts = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('receipt_documents').select('id,order_id,document_type,status,issued_at').range(f, f + 999)
    if (error) { console.log('  receipt_documents: ERROR ' + error.message); break }
    receipts.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const receiptedIds = new Set(receipts.map((r) => String(r.order_id)))
  console.log('  receipt_documents rows: ' + receipts.length + '   COHORT orders with one: ' +
    [...ids].filter((i) => receiptedIds.has(i)).length)

  const audits = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('audit_logs').select('id,action,entity_type,entity_id,metadata,created_at')
      .eq('entity_type', 'order').range(f, f + 999)
    if (error) { console.log('  audit_logs: ERROR ' + error.message); break }
    audits.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const auditByOrder = new Map()
  for (const a of audits) {
    const k = String(a.entity_id)
    if (!auditByOrder.has(k)) auditByOrder.set(k, [])
    auditByOrder.get(k).push(a)
  }
  const cohortAudited = [...ids].filter((i) => auditByOrder.has(i))
  console.log('  audit_logs entity_type=order rows: ' + audits.length + '   COHORT orders with any: ' + cohortAudited.length)
  const actionCount = new Map()
  for (const i of cohortAudited) for (const a of auditByOrder.get(i)) {
    const k = a.action + '   src=' + (a.metadata?.source ?? '-') + '   basis=' + (a.metadata?.basis ?? '-')
    actionCount.set(k, (actionCount.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...actionCount].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('    ' + pad(k, 78) + String(n).padStart(5))

  // ------------------------------------------------------------------ 6. specimens
  H('6. TWENTY SPECIMENS -- most recent first')
  console.log('  ' + pad('venue', 16) + pad('#', 7) + pad('ch', 7) + pad('paych', 8) + pad('N$', 8) +
    pad('placed', 17) + pad('cancelled', 17) + pad('completed', 17) + pad('reason', 18) + 'refs')
  for (const o of [...cohort].reverse().slice(0, 20)) {
    const refs = [o.paycloud_merchant_order_no && 'mon', o.paycloud_transaction_id && 'txn',
      o.payment_trans_no && 'trans', o.payment_voucher_no && 'vou', o.payment_reference && 'ref',
      o.paid_at && 'PAID_AT', o.payment_checkout_url && 'url',
      o.payment_attempt_started_at && 'attempt'].filter(Boolean).join(',') || 'NONE'
    console.log('  ' + pad(vname.get(o.restaurant_id) ?? '?', 16) + pad('#' + o.order_number, 7) +
      pad(o.channel, 7) + pad(o.payment_channel, 8) + pad(o.total, 8) +
      pad(String(o.placed_at).slice(0, 16).replace('T', ' '), 17) +
      pad(String(o.cancelled_at ?? '-').slice(0, 16).replace('T', ' '), 17) +
      pad(String(o.completed_at ?? '-').slice(0, 16).replace('T', ' '), 17) +
      pad(o.cancellation_reason ?? '-', 18) + refs)
  }

  // ------------------------------------------------------------------ 7. the non-cohort remainder
  const rest = qrCard.filter((o) => !(o.payment_status === 'cancelled' && o.status === 'completed'))
  H('7. THE OTHER ' + rest.length + ' QR CARD ORDERS')
  for (const o of rest) {
    const wait = o.paid_at && o.placed_at
      ? ((new Date(o.paid_at).getTime() - new Date(o.placed_at).getTime()) / 60000).toFixed(1) + 'm'
      : '-'
    console.log('  ' + pad(vname.get(o.restaurant_id) ?? '?', 16) + pad('#' + o.order_number, 7) +
      pad(o.payment_status, 11) + pad(o.status, 11) + pad('N$' + o.total, 9) +
      pad(String(o.placed_at).slice(0, 16).replace('T', ' '), 17) +
      'p->paid ' + pad(wait, 9) + 'reason=' + pad(o.cancellation_reason ?? '-', 16) +
      (auditByOrder.has(String(o.id)) ? ' audit:' + auditByOrder.get(String(o.id)).map((a) => a.action).join('/') : ' audit:none'))
  }

  // ------------------------------------------------------------------ 8. the slow flips
  H('8. THE SLOW FLIPS -- every QR card order carrying a paid_at, by wait')
  const paidQr = qrCard.filter((o) => o.paid_at && o.placed_at)
    .map((o) => ({ o, m: (new Date(o.paid_at).getTime() - new Date(o.placed_at).getTime()) / 60000 }))
    .sort((a, b) => a.m - b.m)
  console.log('  QR card orders carrying a paid_at at all: ' + paidQr.length)
  for (const { o, m } of paidQr) {
    console.log('  ' + pad(vname.get(o.restaurant_id) ?? '?', 16) + pad('#' + o.order_number, 7) +
      pad(o.payment_status, 10) + pad(o.status, 10) + pad('N$' + o.total, 9) +
      'placed ' + pad(String(o.placed_at).slice(0, 16).replace('T', ' '), 17) +
      'paid ' + pad(String(o.paid_at).slice(0, 16).replace('T', ' '), 17) +
      'wait ' + pad(m.toFixed(1) + 'm', 11) +
      'attempt ' + pad(String(o.payment_attempt_started_at ?? '-').slice(0, 16).replace('T', ' '), 17) +
      'src=' + pad(o.payment_attempt_source, 12) +
      'txn=' + pad(o.paycloud_transaction_id, 18))
  }

  console.log('\nQR_CANCELLED_PROBE_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
