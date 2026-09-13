/**
 * STAGING VERIFICATION for the formal-invoice-from-order path.
 *
 * Runs the REAL modules against the REAL staging database. Not a mock: every read and write below
 * goes through PostgREST to the staging Supabase project, so the numbering RPC, the order_id FK,
 * the correct_invoice() lineage and the tax hierarchy are all exercised as deployed.
 *
 * WRITES TO STAGING ONLY. It refuses to run against production, and it cleans up the documents it
 * creates. It never touches orders, payments, settlements or intents.
 *
 * Run it ALONE and explicitly -- it is deliberately outside `__tests__` so the ordinary suite
 * never picks it up, because it WRITES to the staging database:
 *
 *   node node_modules/jest/bin/jest.js --testMatch "**\/scripts/staging-verify/*.livecheck.ts" --runInBand
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { createInvoiceFromOrder } from '@/lib/documents/create-invoice-from-order'
import { generateDocumentPdfBytes } from '@/lib/documents/generate-document-pdf'
import { calibrateSchemaProbes, probeTable } from '@/lib/supabase/schema-probe'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

function env(name: string): string {
  for (const line of readFileSync('.env.test', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} missing from .env.test`)
}

const url = env('SUPABASE_URL')
if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: .env.test points at PRODUCTION')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: unrecognised project in ${url}`)

 
const db = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
}) as any

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const createdDocumentIds: string[] = []

async function main() {
  console.log('=== IDENTITY ===')
  const { data: riviera } = await db.from('restaurants').select('id').eq('name', 'Riviera')
  console.log(`  project=${STAGING_REF}  Riviera rows=${(riviera ?? []).length} (production=1, staging=0)`)
  if ((riviera ?? []).length !== 0) throw new Error('ABORT: looks like production')

  // ── the column and the function must actually be there ────────────────────
  console.log('\n=== MIGRATION STATE ===')
  const { error: colErr } = await db.from('business_documents').select('order_id').limit(1)
  check('business_documents.order_id is selectable', !colErr, colErr?.message)

  // ── find a real staging order that is eligible ─────────────────────────────
  console.log('\n=== FIXTURE: a real completed order on staging ===')
  const { data: orders, error: ordersErr } = await db
    .from('orders')
    .select('id, restaurant_id, order_number, status, payment_status, total, items, placed_at')
    .eq('status', 'completed')
    .gt('total', 0)
    .order('placed_at', { ascending: false })
    .limit(40)
  if (ordersErr) throw ordersErr

  const candidate = (orders ?? []).find(
    (o: Record<string, unknown>) => Array.isArray(o.items) && (o.items as unknown[]).length > 0,
  )
  if (!candidate) throw new Error('no completed staging order with items found')
  console.log(
    `  order #${candidate.order_number} total=${candidate.total} lines=${(candidate.items as unknown[]).length} restaurant=${candidate.restaurant_id}`,
  )

  const restaurantId = String(candidate.restaurant_id)
  const orderId = String(candidate.id)

  // A user id that exists, for created_by (FK to users).
  const { data: staff } = await db
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', restaurantId)
    .limit(1)
  const createdBy = String(staff?.[0]?.user_id ?? '')
  if (!createdBy) throw new Error('no restaurant_users row on staging for this venue')

  /**
   * PRE-CLEAN. A previous run that threw part-way leaves its documents behind, and the duplicate
   * guard then refuses the very invoice this check exists to create -- a real guard firing turns
   * into a false red. Lineage links are cleared first because business_documents references itself.
   */
  {
    const { data: stale } = await db.from('business_documents').select('id').eq('order_id', orderId)
    for (const row of stale ?? []) {
      await db
        .from('business_documents')
        .update({ corrected_by_id: null, credited_by_id: null, supersedes_id: null })
        .eq('id', row.id)
    }
    for (const row of stale ?? []) await db.from('business_documents').delete().eq('id', row.id)
    if ((stale ?? []).length) console.log(`  pre-clean: removed ${(stale ?? []).length} document(s) from an earlier run`)
  }

  // ── billing profile: capture, then drive both states ───────────────────────
  console.log('\n=== SETTINGS -> BILLING (the profile the invoice depends on) ===')
  const { data: originalProfile } = await db
    .from('restaurant_billing_profiles')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  console.log(`  existing profile: ${originalProfile ? 'present' : 'none'}`)

  const { error: vatColErr } = await db
    .from('restaurant_billing_profiles')
    .select('vat_registered')
    .limit(1)
  check(
    'staging HAS vat_registered (20260901120000 applied there)',
    !vatColErr,
    vatColErr?.message,
  )

  // Clear it so the fail-closed path is exercised for real.
  await db.from('restaurant_billing_profiles').delete().eq('restaurant_id', restaurantId)

  console.log('\n=== INCOMPLETE MERCHANT DETAILS FAIL CLOSED ===')
  const beforeSeq = await nextDocumentNumberPeek(restaurantId)
  const refused = await createInvoiceFromOrder(db, { orderId, restaurantId, createdBy })
  check(
    'refused with BILLING_PROFILE_INCOMPLETE',
    !refused.ok && refused.code === 'BILLING_PROFILE_INCOMPLETE',
    JSON.stringify(refused).slice(0, 160),
  )
  if (!refused.ok) console.log(`        missing: ${JSON.stringify(refused.missingBillingFields)}`)
  const afterSeq = await nextDocumentNumberPeek(restaurantId)
  check('no invoice number was burned by the refusal', beforeSeq === afterSeq, `${beforeSeq} -> ${afterSeq}`)

  // ── now configure the merchant, exactly as Settings would ──────────────────
  await db.from('restaurant_billing_profiles').upsert(
    {
      restaurant_id: restaurantId,
      registration_number: 'CC/2026/STAGING',
      vat_number: 'VAT-STG-0001',
      bank_name: 'Bank Windhoek',
      bank_account_name: 'Staging Venue CC',
      bank_account_number: '8001 0000 11',
      bank_branch_code: '481972',
    },
    { onConflict: 'restaurant_id' },
  )
  console.log('  billing profile configured for the test venue')

  // ── the happy path ─────────────────────────────────────────────────────────
  console.log('\n=== CREATE INVOICE FROM ORDER ===')
  const created = await createInvoiceFromOrder(db, {
    orderId,
    restaurantId,
    createdBy,
    billTo: { name: 'Acme Trading CC', email: 'invoice-test@example.test', address: 'PO Box 1, Windhoek' },
  })
  check('invoice created', created.ok, created.ok ? '' : JSON.stringify(created).slice(0, 200))
  if (!created.ok) throw new Error('cannot continue without an invoice')

  const doc = created.document as Record<string, unknown>
  createdDocumentIds.push(String(doc.id))
  console.log(`  invoice #${doc.document_number}  total=${doc.total}  subtotal=${doc.subtotal}  vat=${doc.vat_amount}`)

  check('order linkage persisted', String(doc.order_id) === orderId, String(doc.order_id))
  check('document_type is invoice', doc.document_type === 'invoice')
  check('scoped to the right venue', String(doc.restaurant_id) === restaurantId)
  check('merchant details snapshotted', doc.registration_number === 'CC/2026/STAGING' && doc.vat_number === 'VAT-STG-0001')
  check(
    'document total equals the order total',
    Number(doc.total) === Number(candidate.total),
    `${doc.total} vs ${candidate.total}`,
  )
  check(
    'subtotal + vat reconciles to total',
    Math.abs(Number(doc.subtotal) + Number(doc.vat_amount) - Number(doc.total)) < 0.005,
  )
  check('line count matches the order', (doc.line_items as unknown[]).length === (candidate.items as unknown[]).length)
  check('reference note names the order', String(doc.reference_note).includes(`#${candidate.order_number}`))

  // ── duplicate behaviour ────────────────────────────────────────────────────
  console.log('\n=== DUPLICATE GUARD ===')
  const dup = await createInvoiceFromOrder(db, { orderId, restaurantId, createdBy })
  check('a second invoice is refused', !dup.ok && dup.code === 'INVOICE_ALREADY_EXISTS')
  if (!dup.ok) console.log(`        names existing: ${dup.existingDocument?.document_number}`)

  // ── restaurant authorization ───────────────────────────────────────────────
  console.log('\n=== RESTAURANT ISOLATION ===')
  const { data: others } = await db.from('restaurants').select('id').neq('id', restaurantId).limit(1)
  const otherId = String(others?.[0]?.id ?? '')
  if (otherId) {
    const cross = await createInvoiceFromOrder(db, { orderId, restaurantId: otherId, createdBy })
    check('another venue cannot invoice this order', !cross.ok && cross.code === 'ORDER_NOT_FOUND')
  }
  const bogus = await createInvoiceFromOrder(db, {
    orderId: '00000000-0000-4000-8000-000000000000',
    restaurantId,
    createdBy,
  })
  check('an arbitrary order id is refused', !bogus.ok && bogus.code === 'ORDER_NOT_FOUND')

  // ── eligibility guards against real rows ───────────────────────────────────
  console.log('\n=== ELIGIBILITY GUARDS (real staging rows) ===')
  for (const [label, filter] of [
    ['cancelled', 'cancelled'],
    ['pending', 'pending'],
  ] as const) {
    const { data: rows } = await db
      .from('orders')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('status', filter)
      .limit(1)
    const id = rows?.[0]?.id
    if (!id) {
      console.log(`  SKIP  no ${label} order on staging for this venue`)
      continue
    }
    const r = await createInvoiceFromOrder(db, { orderId: String(id), restaurantId, createdBy })
    const expected = filter === 'cancelled' ? 'ORDER_CANCELLED' : 'ORDER_NOT_FINAL'
    check(`a ${label} order is refused (${expected})`, !r.ok && r.code === expected, JSON.stringify(r).slice(0, 120))
  }

  // ── NO MONEY MOVED ─────────────────────────────────────────────────────────
  console.log('\n=== NO PAYMENT SIDE EFFECTS ===')
  const { data: orderAfter } = await db
    .from('orders')
    /**
     * `pending_charge_cents` is deliberately NOT selected: it arrives with 20260909180000, which is
     * one of the twelve main-branch migrations NOT applied to staging. Asking for it makes
     * PostgREST reject the whole row (42703) and the probe reads null -- the same class of defect
     * this branch fixes in the billing-profile route.
     */
    .select('status, payment_status, total, paid_at, payment_method, paycloud_merchant_order_no')
    .eq('id', orderId)
    .single()
  check('order status unchanged', orderAfter.status === candidate.status, `${orderAfter.status}`)
  check('order payment_status unchanged', orderAfter.payment_status === candidate.payment_status)
  check('order total unchanged', Number(orderAfter.total) === Number(candidate.total))

  /**
   * ================================================================================================
   * A MISSING TABLE MUST NEVER READ AS "NO ROWS"
   * ================================================================================================
   *
   * `terminal_payment_intents` does not exist on staging -- 20260908090000 is one of the twelve
   * main-branch migrations not applied there -- and `{ head: true, count: 'exact' }` returns a NULL
   * COUNT AND NO ERROR for an absent relation. So `(count ?? 0) === 0` was true, and this assertion
   * PASSED against a table that cannot be written to at all. It proved nothing while looking
   * exactly like proof.
   *
   * That is the #169 defect, in the same shape lib/supabase/schema-probe.ts was written to prevent,
   * reproduced here by hand. So the fix is not a second hand-rolled probe -- it is that module,
   * CALIBRATED against a known-absent control first, because a probe that has only ever been
   * pointed at things that exist has not been tested.
   *
   * THREE OUTCOMES, AND ONLY ONE OF THEM CAN PASS:
   *
   *   present   the count is meaningful -> assert it
   *   absent    confirmed by PGRST205   -> NOT CHECKED
   *   neither   a permission error, a network failure, an unrecognised code, or an uncalibrated
   *             instrument -> NOT CHECKED
   *
   * The third case is the one that matters: an inconclusive probe is not evidence of absence, and
   * silently treating it as one is how this assertion lied the first time. Nothing here can reach
   * `check()` unless the table is confirmed to exist.
   */
  const calibration = await calibrateSchemaProbes(db, 'orders', 'id')
  for (const line of calibration.lines) console.log(`  calibration: ${line}`)
  if (!calibration.sound) {
    for (const f of calibration.failures) console.log(`  calibration FAILURE: ${f}`)
  }
  check('the schema probe can tell present from absent on this database', calibration.sound,
    calibration.failures.join('; '))

  for (const [table, col] of [
    ['payments', 'created_at'],
    ['payment_events', 'created_at'],
    ['terminal_payment_intents', 'created_at'],
    ['order_line_allocation_settlements', 'settled_at'],
    ['payment_tips', 'recorded_at'],
  ] as const) {
    if (!calibration.sound) {
      console.log(`  NOT CHECKED  ${table} — the probe is not calibrated on this database`)
      continue
    }
    const probe = await probeTable(db, table)
    if (!probe.present) {
      const why = probe.absent
        ? `does not exist on staging (${probe.code})`
        : `could not be probed (${probe.code}: ${probe.message})`
      console.log(`  NOT CHECKED  ${table} ${why} — cannot assert absence of writes`)
      continue
    }
    const { count } = await db
      .from(table)
      .select('*', { count: 'exact', head: true })
      .gte(col, new Date(Date.now() - 10 * 60 * 1000).toISOString())
    check(`no ${table} row written in the last 10 minutes`, (count ?? 0) === 0, `count=${count}`)
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  console.log('\n=== PDF ===')
  const { data: fullDoc } = await db.from('business_documents').select('*').eq('id', doc.id).single()
  const bytes = await generateDocumentPdfBytes(fullDoc)
  const header = Buffer.from(bytes.slice(0, 5)).toString('latin1')
  check('renders a real PDF', header === '%PDF-', header)
  check('PDF is a plausible size', bytes.byteLength > 1500, `${bytes.byteLength} bytes`)
  const outPath = 'C:/Users/223125~1/AppData/Local/Temp/claude/staging-invoice.pdf'
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, Buffer.from(bytes))
  console.log(`  written: ${outPath} (${bytes.byteLength} bytes)`)

  // ── CORRECTION LINEAGE carries order_id ────────────────────────────────────
  console.log('\n=== CORRECTION LINEAGE (correct_invoice carries order_id) ===')
  await db.from('business_documents').update({ status: 'sent' }).eq('id', doc.id)
  const { data: corrected, error: correctErr } = await db.rpc('correct_invoice', {
    p_original_invoice_id: doc.id,
    p_corrected_line_items: (doc.line_items as Record<string, unknown>[]).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      tax_rate_id: l.tax_rate_id ?? null,
    })),
    p_reason: 'staging verification',
    p_created_by: createdBy,
  })
  if (correctErr) {
    check('correct_invoice ran', false, correctErr.message)
  } else {
    const newInvoiceId = String((corrected as Record<string, string>).new_invoice_id ?? (corrected as Record<string, Record<string, string>>).new_invoice?.id ?? '')
    const creditNoteId = String((corrected as Record<string, string>).credit_note_id ?? (corrected as Record<string, Record<string, string>>).credit_note?.id ?? '')
    const { data: lineage } = await db
      .from('business_documents')
      .select('id, document_type, document_number, status, order_id, supersedes_id, corrected_by_id')
      .eq('order_id', orderId)
      .order('document_number')
    for (const row of lineage ?? []) {
      createdDocumentIds.push(String(row.id))
      console.log(
        `  ${String(row.document_type).padEnd(12)} #${String(row.document_number).padEnd(5)} status=${String(row.status).padEnd(7)} order_id=${row.order_id ? 'SET' : 'NULL'}`,
      )
    }
    const all = lineage ?? []
    check('correction produced 3 documents for this order', all.length === 3, `got ${all.length}`)
    check(
      'EVERY lineage row carries order_id',
      all.every((r: Record<string, unknown>) => String(r.order_id) === orderId),
    )
    check('the original is void', all.some((r: Record<string, unknown>) => r.status === 'void'))
    check('a credit note exists', all.some((r: Record<string, unknown>) => r.document_type === 'credit_note'))
    check('the replacement supersedes the original', all.some((r: Record<string, unknown>) => r.supersedes_id === doc.id))
    void newInvoiceId
    void creditNoteId
  }

  // ── cleanup ────────────────────────────────────────────────────────────────
  console.log('\n=== CLEANUP ===')
  const { data: mine } = await db.from('business_documents').select('id').eq('order_id', orderId)
  for (const row of mine ?? []) {
    await db.from('business_documents').update({ corrected_by_id: null, credited_by_id: null, supersedes_id: null }).eq('id', row.id)
  }
  for (const row of mine ?? []) {
    const { error } = await db.from('business_documents').delete().eq('id', row.id)
    if (error) console.log(`  could not delete ${row.id}: ${error.message}`)
  }
  const { count: leftover } = await db
    .from('business_documents')
    .select('*', { count: 'exact', head: true })
    .eq('order_id', orderId)
  console.log(`  documents left for this order: ${leftover ?? 0}`)

  if (originalProfile) {
    await db.from('restaurant_billing_profiles').upsert(originalProfile, { onConflict: 'restaurant_id' })
    console.log('  original billing profile restored')
  } else {
    await db.from('restaurant_billing_profiles').delete().eq('restaurant_id', restaurantId)
    console.log('  billing profile removed (there was none before)')
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  if (fail) {
    console.log('FAILURES:')
    for (const f of failures) console.log(`  - ${f}`)
  }
}

/** Reads the sequence counter without advancing it. */
async function nextDocumentNumberPeek(restaurantId: string): Promise<number> {
  const { data } = await db
    .from('document_sequences')
    .select('current_number')
    .eq('restaurant_id', restaurantId)
    .eq('document_type', 'invoice')
    .maybeSingle()
  return Number(data?.current_number ?? 0)
}

jest.setTimeout(300_000)

test('formal invoice from an order, end to end against the staging database', async () => {
  await main()
  expect(failures).toEqual([])
})
