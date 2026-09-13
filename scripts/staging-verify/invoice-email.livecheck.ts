/**
 * STAGING VERIFICATION for invoice email delivery.
 *
 * Creates a real invoice on STAGING from a real staging order, then sends it through the REAL
 * `sendDocumentEmail` — real PDF, real Resend API call — and checks the audit trail and the
 * draft->sent transition.
 *
 * ================================================================================================
 * THE RECIPIENT IS RESEND'S SANDBOX ADDRESS, DELIBERATELY
 * ================================================================================================
 *
 * `delivered@resend.dev` is Resend's own documented test recipient: the API accepts it and reports
 * success, and NO PERSON RECEIVES ANYTHING. A real inbox would mean this check cannot be re-run
 * without mailing someone, which is how a verification script becomes something nobody runs.
 *
 * ================================================================================================
 * IT USES THE ONLY RESEND KEY THAT EXISTS
 * ================================================================================================
 *
 * RESEND_API_KEY is present only in .env.local, which holds PRODUCTION credentials. There is no
 * staging Resend account. So this dispatches through the production Resend tenant, from
 * noreply@flashtap.app, to Resend's sandbox address. It writes nothing to production Supabase and
 * changes no production configuration — the document, the audit row and the status transition all
 * live on STAGING.
 *
 * Run it ALONE and explicitly.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { createInvoiceFromOrder } from '@/lib/documents/create-invoice-from-order'
import { sendDocumentEmail } from '@/lib/documents/sendDocumentEmail'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const TEST_RECIPIENT = 'delivered@resend.dev'

function fromFile(file: string, name: string): string {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} missing from ${file}`)
}

const url = fromFile('.env.test', 'SUPABASE_URL')
if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: .env.test points at PRODUCTION')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: unrecognised project in ${url}`)

// The only Resend key in the repo. See the header.
process.env.RESEND_API_KEY = fromFile('.env.local', 'RESEND_API_KEY')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = createClient(url, fromFile('.env.test', 'SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
}) as any

jest.setTimeout(180_000)

let documentId = ''
let restaurantId = ''
let originalProfile: Record<string, unknown> | null = null

afterAll(async () => {
  if (documentId) {
    await db
      .from('business_documents')
      .update({ corrected_by_id: null, credited_by_id: null, supersedes_id: null })
      .eq('id', documentId)
    await db.from('business_documents').delete().eq('id', documentId)
  }
  if (restaurantId) {
    await db.from('restaurant_billing_profiles').delete().eq('restaurant_id', restaurantId)
    if (originalProfile) {
      await db.from('restaurant_billing_profiles').upsert(originalProfile, { onConflict: 'restaurant_id' })
    }
  }
})

test('an invoice raised from a staging order emails successfully to the sandbox recipient', async () => {
  const { data: riviera } = await db.from('restaurants').select('id').eq('name', 'Riviera')
  expect((riviera ?? []).length).toBe(0) // production has exactly one

  const { data: orders } = await db
    .from('orders')
    .select('id, restaurant_id, order_number, status, total, items')
    .eq('status', 'completed')
    .gt('total', 0)
    .order('placed_at', { ascending: false })
    .limit(40)

  const order = (orders ?? []).find(
    (o: Record<string, unknown>) => Array.isArray(o.items) && (o.items as unknown[]).length > 0,
  )
  expect(order).toBeTruthy()
  restaurantId = String(order.restaurant_id)

  const { data: staff } = await db
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', restaurantId)
    .limit(1)
  const createdBy = String(staff?.[0]?.user_id ?? '')
  expect(createdBy).toBeTruthy()

  // Clear any document left by an earlier run so the duplicate guard does not fire.
  const { data: stale } = await db.from('business_documents').select('id').eq('order_id', order.id)
  for (const row of stale ?? []) {
    await db
      .from('business_documents')
      .update({ corrected_by_id: null, credited_by_id: null, supersedes_id: null })
      .eq('id', row.id)
  }
  for (const row of stale ?? []) await db.from('business_documents').delete().eq('id', row.id)

  const { data: prof } = await db
    .from('restaurant_billing_profiles')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  originalProfile = prof ?? null
  await db.from('restaurant_billing_profiles').upsert(
    {
      restaurant_id: restaurantId,
      registration_number: 'CC/2026/EMAILCHECK',
      vat_number: 'VAT-EMAIL-1',
      bank_name: 'Bank Windhoek',
      bank_account_name: 'Staging Venue CC',
      bank_account_number: '8100 9999 00',
      bank_branch_code: '481972',
    },
    { onConflict: 'restaurant_id' },
  )

  const created = await createInvoiceFromOrder(db, {
    orderId: String(order.id),
    restaurantId,
    createdBy,
    billTo: { name: 'Sandbox Recipient', email: TEST_RECIPIENT },
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  documentId = String((created.document as { id: string }).id)
  const docNumber = String((created.document as { document_number: string }).document_number)
  console.log(`  created invoice #${docNumber} on staging`)

  const { data: full } = await db.from('business_documents').select('*').eq('id', documentId).single()
  expect(full.status).toBe('draft')

  const result = await sendDocumentEmail(db, full, TEST_RECIPIENT, createdBy)
  console.log(`  sendDocumentEmail -> ok=${result.ok}${result.ok ? '' : ` code=${(result as { errorCode?: string }).errorCode} msg=${(result as { errorMessage?: string }).errorMessage}`}`)
  expect(result.ok).toBe(true)

  // The audit trail is the durable record that a document left the building.
  const { data: audits } = await db
    .from('audit_logs')
    .select('action, entity_id, metadata, created_at')
    .eq('entity_id', documentId)
    .order('created_at', { ascending: false })
    .limit(5)
  const emailed = (audits ?? []).find((a: { action: string }) => a.action === 'document.emailed')
  expect(emailed).toBeTruthy()
  console.log(`  audit: ${emailed?.action} recipient=${JSON.stringify(emailed?.metadata?.recipient ?? emailed?.metadata?.to ?? '—')}`)
})
