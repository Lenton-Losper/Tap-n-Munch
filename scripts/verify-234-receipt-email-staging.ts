/**
 * RECEIPT EMAIL — WHAT DOES A CUSTOMER ACTUALLY SEE? Staging only, over HTTP.
 *
 * The ruling is "finish it or remove the surface that implies it works". Both halves of that need
 * the same fact first: does the surface work, and when it does not, what reaches the customer?
 *
 * WHAT IS ALREADY BUILT. sendReceiptEmail is complete -- Resend, an HTML render, a PDF attachment,
 * and an append-only receipt_deliveries row per attempt. This is not a stub.
 *
 * WHAT IS NOT. RESEND_API_KEY is put into the PRODUCTION worker by
 * .github/workflows/production-worker.yml and appears NOWHERE in staging.yml. getResend() throws
 * when the key is absent. So the same button behaves differently in the two environments, and the
 * question is what the difference looks like from the customer's side.
 *
 * The kiosk-success screen does `throw new Error(data?.error || ...)` and renders `err.message`, so
 * whatever the server puts in `error` is read by a customer standing at a kiosk.
 *
 * Marker: VERIFY_234_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BASE = process.env.FLASHTAP_BASE_URL || ''
if (!url.includes(STAGING_REF)) throw new Error('REFUSING: not staging - ' + url)
if (!BASE) throw new Error('FLASHTAP_BASE_URL is required')

const db = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  const tag = 'v234-' + Date.now()
  console.log('staging ' + url + '\nbase    ' + BASE + '\n')

  let orgId = '', restId = '', orderId = ''
  const ins = async (t, row, what) => {
    const { data, error } = await db.from(t).insert(row).select('id').single()
    if (error) throw new Error(what + ': ' + error.message)
    return String(data.id)
  }

  try {
    const { data: u0 } = await db.from('users').select('id').limit(1).single()
    orgId = await ins('organizations', { name: tag, owner_user_id: String(u0.id) }, 'organizations')
    restId = await ins('restaurants', { name: tag + '-venue', organization_id: orgId }, 'restaurants')
    // PAID, because the route refuses to issue a receipt for anything else.
    orderId = await ins('orders',
      { restaurant_id: restId, table_number: 980, status: 'completed', payment_status: 'paid',
        total: 55, paid_at: new Date().toISOString() },
      'orders')

    const post = async (email) => {
      const qs = new URLSearchParams({ restaurantId: restId, table_number: '980' })
      const res = await fetch(
        `${BASE}/api/guest/orders/${encodeURIComponent(orderId)}/receipt/email?${qs}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) },
      )
      const body = await res.json().catch(() => ({}))
      return { status: res.status, body }
    }

    console.log('A REAL REQUEST, the one the kiosk button makes')
    const real = await post('flashtaptestacc1@gmail.com')
    console.log('  HTTP ' + real.status)
    console.log('  body ' + JSON.stringify(real.body))
    console.log('')
    console.log('  WHAT THE CUSTOMER READS (the screen renders data.error verbatim):')
    console.log('    "' + String(real.body?.error ?? '(no error field — it succeeded)') + '"')

    console.log('\nAN INVALID ADDRESS, to prove the route is reachable and validating')
    const bad = await post('not-an-email')
    console.log('  HTTP ' + bad.status + '  ' + JSON.stringify(bad.body))

    console.log('\nWAS A DELIVERY ATTEMPT RECORDED EITHER WAY?')
    const { data: docs } = await db.from('receipt_documents').select('id').eq('order_id', orderId)
    const ids = (docs ?? []).map((d) => d.id)
    if (ids.length === 0) {
      console.log('  no receipt_documents row — issuance did not get that far')
    } else {
      const { data: dels } = await db.from('receipt_deliveries')
        .select('method, status, error_message, attempt_number').in('receipt_document_id', ids)
      console.log('  receipt_documents: ' + ids.length + '   receipt_deliveries: ' + (dels ?? []).length)
      for (const d of dels ?? []) {
        console.log('    ' + d.method + ' attempt ' + d.attempt_number + ' -> ' + d.status +
          (d.error_message ? '  ' + String(d.error_message).slice(0, 90) : ''))
      }
    }

    console.log('\nVERIFY_234_OK')
  } finally {
    if (restId) {
      const { data: docs } = await db.from('receipt_documents').select('id').eq('restaurant_id', restId)
      for (const d of docs ?? []) await db.from('receipt_deliveries').delete().eq('receipt_document_id', d.id)
      await db.from('receipt_documents').delete().eq('restaurant_id', restId)
      await db.from('orders').delete().eq('restaurant_id', restId)
      await db.from('restaurants').delete().eq('id', restId)
    }
    if (orgId) await db.from('organizations').delete().eq('id', orgId)
    console.log('cleaned up')
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
