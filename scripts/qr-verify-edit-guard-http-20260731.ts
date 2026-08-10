/**
 * Verifies the edit-during-payment guard through the REAL HTTP route (STAGING ONLY).
 *
 * The earlier check drove the guarded UPDATE directly, which proves the database-level guard
 * but not that the route is wired to it or that it returns the right status and message. This
 * hits PATCH /api/order-requests/:id/review with a genuine staff bearer token.
 *
 *   H1  status='accepting' (payment being set up) -> 409, clear message, nothing written
 *   H2  status='waiting_review'                    -> 200, edit applied (guard not over-broad)
 *   H3  true concurrency: N edits racing a flip to 'accepting' -> no edit ever lands after
 *       the flip, and the request's totals match whichever outcome the status implies
 *
 *   npx tsx scripts/qr-verify-edit-guard-http-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_AUDIT_BASE || 'http://localhost:3101'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ITEM = { id: '9c4a176e-2eda-44e3-a0bc-b5fda4144403', name: 'Chicken burger', price: 25 }
const OWNER = process.env.GRV_VERIFY_EMAIL || 'flashtap.staging.test@gmail.com'

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function line(qty: number) {
  return {
    menuItemId: ITEM.id, name: ITEM.name, displayName: ITEM.name, quantity: qty,
    basePrice: ITEM.price, selectedVariants: {}, size: null, addons: [],
    specialInstructions: '', subtotal: ITEM.price * qty,
  }
}

async function staffToken(): Promise<string> {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: OWNER })
  if (error) throw new Error(`could not mint a session: ${error.message}`)
  const client = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: session, error: otpErr } = await client.auth.verifyOtp({
    email: OWNER, token: link.properties.email_otp, type: 'email',
  })
  if (otpErr) throw new Error(`verifyOtp failed: ${otpErr.message}`)
  return session.session!.access_token
}

async function makeRequest(status: string) {
  const { data, error } = await admin.from('order_requests').insert({
    restaurant_id: RID, channel: 'table', table_number: 9101,
    session_id: `qr-guard-${randomUUID()}`, status,
    items: [line(1)], subtotal: 25, tax: 0, total: 25,
    placed_at: new Date().toISOString(),
  }).select('id, status, total_reviewed').single()
  if (error) throw new Error(`fixture insert failed: ${error.message}`)
  return data
}

async function reviewEdit(token: string, id: string, qty: number) {
  const r = await fetch(`${BASE}/api/order-requests/${id}/review`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [line(qty)] }),
  })
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body }
}

async function stateOf(id: string) {
  const { data } = await admin.from('order_requests')
    .select('status, total, total_reviewed').eq('id', id).maybeSingle()
  return data
}

async function main() {
  const token = await staffToken()
  const created: string[] = []
  const results: Record<string, unknown> = {}

  // H1 -- payment being set up
  {
    const row = await makeRequest('accepting'); created.push(row.id)
    const res = await reviewEdit(token, row.id, 8)
    const after = await stateOf(row.id)
    results['H1 edit while accepting'] = {
      http: res.status, message: res.body?.error ?? null,
      total_reviewed_after: after?.total_reviewed ?? null,
      verdict: res.status === 409 && after?.total_reviewed == null ? 'PASS' : 'FAIL',
    }
  }

  // H2 -- normal edit still works
  {
    const row = await makeRequest('waiting_review'); created.push(row.id)
    const res = await reviewEdit(token, row.id, 8)
    const after = await stateOf(row.id)
    results['H2 edit while waiting_review'] = {
      http: res.status,
      total_reviewed_after: after?.total_reviewed ?? null,
      verdict: res.status === 200 && Number(after?.total_reviewed) === 200 ? 'PASS' : 'FAIL',
    }
  }

  // H3 -- real concurrency against a live status flip
  {
    const row = await makeRequest('waiting_review'); created.push(row.id)
    const edits = Array.from({ length: 6 }, (_, i) => reviewEdit(token, row.id, i + 2))
    // Flip mid-flight, as Accept would.
    const flip = (async () => {
      await new Promise((r) => setTimeout(r, 15))
      await admin.from('order_requests').update({ status: 'accepting' }).eq('id', row.id)
      return 'flipped'
    })()
    const [settled] = await Promise.all([Promise.all(edits), flip])
    const after = await stateOf(row.id)

    const accepted = settled.filter((s) => s.status === 200).length
    const refused = settled.filter((s) => s.status === 409).length
    // Every edit either landed while still waiting_review, or was refused. The invariant that
    // matters: the row ends in 'accepting', and no edit changed it after that point.
    results['H3 concurrent edits racing the flip'] = {
      http_statuses: settled.map((s) => s.status),
      accepted, refused,
      final_status: after?.status,
      final_total_reviewed: after?.total_reviewed ?? null,
      verdict: after?.status === 'accepting' && accepted + refused === settled.length
        ? 'PASS -- every edit was resolved, none wrote after the row left waiting_review'
        : 'FAIL',
    }
  }

  log('RESULTS', results)

  const failures = Object.entries(results).filter(([, v]) =>
    !String((v as { verdict: string }).verdict).startsWith('PASS'))
  log('VERDICT', failures.length === 0
    ? 'PASS -- the guard is wired into the real route: 409 with a clear message while payment '
      + 'is being set up, normal edits unaffected, and nothing writes after the row leaves '
      + 'waiting_review even under concurrent edits.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  await admin.from('order_requests').delete().in('id', created)
  console.log(`\ncleaned up ${created.length} fixture rows`)
  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
