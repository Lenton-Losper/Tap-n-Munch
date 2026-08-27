/**
 * #304 — HAS A RECEIPT EVER BEEN EMAILED TO AN ADDRESS THAT WAS NOT THE CUSTOMER'S?
 *
 * The #304 ruling records this under COULD NOT DETERMINE: "attempts against one receipt from
 * differing addresses would be the signature... Worth running before ruling, because a non-zero
 * count moves this from theoretical to incident."
 *
 * This is that measurement, and it is RE-RUNNABLE ON PURPOSE. Rule 20: a comment asserting a
 * production fact is a measurement with a date, and the only form of such a fact that cannot rot is
 * one that can be re-derived. The route docblock quotes the 2026-08-27 numbers; this is how anyone
 * checks whether they still hold.
 *
 * READ-ONLY, AND STRUCTURALLY SO. Every call below is a `select`. There is no insert, update,
 * delete or rpc in this file, it sends no email, and it refuses to run against anything that is not
 * the production project.
 *
 * ============================================================================================
 * THE POSITIVE CONTROL
 * ============================================================================================
 *
 * "Zero receipts were emailed to two addresses" is the answer this file exists to produce, and it
 * is also exactly what a broken query, a revoked key or an empty table would produce. A detector
 * reading nothing reports all-clear and looks identical to a clean result.
 *
 * So before the finding, this asserts that the instrument is alive:
 *   - receipt_deliveries is readable AND non-empty;
 *   - it contains PRINT rows, proving the method filter selects rather than matches nothing;
 *   - receipt_documents is readable AND non-empty, so the denominator is real.
 *
 * If any control fails the script exits non-zero WITHOUT reporting a finding, because at that point
 * it does not have one.
 *
 * Marker: MEASURE_304_OK
 *
 * Run:  node ./node_modules/tsx/dist/cli.mjs scripts/measure-304-receipt-email-exposure.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.local'), override: false })

/** The production project ref. Staging is `mdqjpxwczrhkxkbqatqa` and is not what this measures. */
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: this measures PRODUCTION and the configured project is ${url}`)
}
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')

const db = createClient(url, key, { auth: { persistSession: false } })

const norm = (value: unknown) => String(value ?? '').trim().toLowerCase()

let controlFailures = 0
const control = (label: string, ok: boolean, detail = '') => {
  if (!ok) controlFailures++
  console.log(`  ${ok ? 'PASS  ' : '*** FAIL ***  '}${label}${detail ? '   ' + detail : ''}`)
}

interface DeliveryRow {
  method: string | null
  status: string | null
  destination: string | null
  requested_at: string | null
  receipt_document_id: string | null
}

async function main() {
  console.log(`production ${url}`)
  console.log(`measured   ${new Date().toISOString()}`)
  console.log('')
  console.log('CONTROLS — is the instrument alive?')

  const { data: deliveries, error: deliveryError } = await db
    .from('receipt_deliveries')
    .select('method, status, destination, requested_at, receipt_document_id')
    .order('requested_at', { ascending: true })

  control('receipt_deliveries is readable', !deliveryError, deliveryError?.message ?? '')
  const rows = (deliveries ?? []) as DeliveryRow[]
  control('receipt_deliveries is not empty', rows.length > 0, `${rows.length} rows`)

  const prints = rows.filter((row) => String(row.method).toUpperCase() === 'PRINT')
  control(
    'the method filter SELECTS rather than matching nothing',
    prints.length > 0,
    `${prints.length} PRINT rows`,
  )

  const { count: documentCount, error: documentError } = await db
    .from('receipt_documents')
    .select('id', { count: 'exact', head: true })

  control('receipt_documents is readable', !documentError, documentError?.message ?? '')
  control('receipt_documents is not empty', (documentCount ?? 0) > 0, `${documentCount ?? 0} rows`)

  if (controlFailures > 0) {
    console.log('')
    console.log(`*** ${controlFailures} control(s) failed. NO FINDING IS REPORTED: this run cannot`)
    console.log('*** tell "nothing happened" from "nothing was read".')
    process.exitCode = 1
    return
  }

  const emails = rows.filter((row) => String(row.method).toUpperCase() === 'EMAIL')
  const destinations = new Set(emails.map((row) => norm(row.destination)))

  const perDocument = new Map<string, Set<string>>()
  for (const row of emails) {
    const key = String(row.receipt_document_id)
    if (!perDocument.has(key)) perDocument.set(key, new Set())
    perDocument.get(key)?.add(norm(row.destination))
  }
  const multiAddress = [...perDocument.entries()].filter(([, addresses]) => addresses.size > 1)

  console.log('')
  console.log('FINDING')
  console.log(`  receipt_documents in total          ${documentCount ?? 0}`)
  console.log(`  receipt_deliveries in total         ${rows.length}`)
  console.log(`  ... of which EMAIL                  ${emails.length}`)
  console.log(`  distinct receipts ever emailed      ${perDocument.size}`)
  console.log(`  distinct destination addresses      ${destinations.size}`)
  if (emails.length > 0) {
    console.log(`  first EMAIL attempt                 ${emails[0].requested_at}`)
    console.log(`  last EMAIL attempt                  ${emails[emails.length - 1].requested_at}`)
  }
  console.log('')
  console.log(`  THE SIGNATURE — receipts emailed to MORE THAN ONE address:  ${multiAddress.length}`)
  for (const [documentId, addresses] of multiAddress) {
    // The addresses themselves are customer data and are counted, not printed.
    console.log(`    receipt_document ${documentId}: ${addresses.size} distinct addresses`)
  }

  console.log('')
  if (multiAddress.length === 0) {
    console.log('  No receipt has been emailed to more than one address. #304 is unexercised.')
  } else {
    console.log('  NON-ZERO. This is an incident, not a theoretical exposure. Escalate before ruling.')
  }
  console.log('')
  console.log('MEASURE_304_OK')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
