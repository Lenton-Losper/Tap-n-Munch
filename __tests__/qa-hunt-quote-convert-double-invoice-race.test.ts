/**
 * BUG REPRO (bug-hunter): POST /api/admin/documents/[id]/convert can turn ONE quote into
 * TWO invoices, each with its own real sequence number, both billable to the customer.
 *
 * Same read-then-write shape as the document-payments over-pay race:
 *   convert/route.ts:50-54  read the quote
 *   convert/route.ts:66-71  if (TERMINAL_QUOTE_STATUSES.has(quote.status)) -> 409
 *   convert/route.ts:82-92  await createBusinessDocument(...)      <- invoice minted here
 *   convert/route.ts:94-97  .update({ status: 'converted' }).eq('id', quoteId)
 *
 * The UPDATE carries no predicate on the status that was just validated -- contrast
 * app/api/orders/[orderId]/status/route.ts:107 (`.eq('status', expectedCurrentStatus)`)
 * and app/api/payments/push-to-terminal/route.ts:98 (`.eq('payment_status', previousPaymentStatus)`),
 * which do exactly this claim correctly. Worse, the invoice is created BEFORE the status
 * write, so even a guarded UPDATE would not prevent the duplicate document.
 *
 * The codebase demonstrates the correct pattern in SQL: correct_invoice()
 * (migration 20260727160000, `SELECT ... FOR UPDATE` + status guard + payment-count guard,
 * all in one plpgsql transaction). These two HTTP routes do it in JS with no lock.
 *
 * VERIFIED AGAINST origin/main: `git diff origin/main -- app/api/admin/documents/[id]/convert/route.ts`
 * is empty.
 *
 * Asserts CURRENT behaviour; should FAIL once the transition is claimed atomically.
 */
import { POST } from '@/app/api/admin/documents/[id]/convert/route'

type Doc = Record<string, any>

let documents: Doc[] = []
let createdInvoices: Array<Record<string, unknown>> = []

/**
 * Releases readers only once `size` of them have arrived, so both requests observe the
 * same pre-write snapshot. This is a faithful model of two concurrent HTTP requests:
 * the route takes no row lock (contrast correct_invoice()'s `SELECT ... FOR UPDATE`),
 * so on a real Postgres both reads genuinely return status='sent'. Without the barrier
 * the single-threaded test loop can run one request to completion between the other's
 * timer callbacks, which would serialise them and hide the defect.
 */
function makeBarrier(size: number) {
  let arrived = 0
  let release: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  return async function wait() {
    arrived += 1
    if (arrived >= size) release!()
    await gate
  }
}

let readBarrier: (() => Promise<void>) | null = null

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      if (table !== 'business_documents') throw new Error(`unexpected table ${table}`)
      return {
        select: () => {
          const filters: Array<[string, unknown]> = []
          const apply = () => documents.filter((r) => filters.every(([c, v]) => r[c] === v))
          const b: Record<string, any> = {
            eq(c: string, v: unknown) {
              filters.push([c, v])
              return b
            },
            async maybeSingle() {
              if (readBarrier) await readBarrier()
              return { data: apply()[0] ?? null, error: null }
            },
            async single() {
              const m = apply()
              return { data: m[0] ?? null, error: m[0] ? null : { message: 'not found' } }
            },
          }
          return b
        },
        update: (patch: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = []
          const b: Record<string, any> = {
            eq(c: string, v: unknown) {
              filters.push([c, v])
              return b
            },
            select: () => ({
              single: async () => {
                const hit = documents.filter((r) => filters.every(([c, v]) => r[c] === v))
                hit.forEach((r) => Object.assign(r, patch))
                return { data: hit[0] ?? null, error: null }
              },
            }),
          }
          return b
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-1' }),
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

// Stands in for the real sequence-number allocator; each call mints a distinct invoice.
jest.mock('@/lib/documents/create-document', () => ({
  createBusinessDocument: async (_sb: unknown, args: Record<string, unknown>) => {
    const doc = {
      id: `inv-${createdInvoices.length + 1}`,
      document_type: 'invoice',
      document_number: `INV-${1000 + createdInvoices.length + 1}`,
      quote_id: args.quoteId,
      total: 5000,
    }
    createdInvoices.push(doc)
    return { document: doc, warnings: [] as string[] }
  },
}))

function makeReq() {
  return new Request('https://example.test/api/admin/documents/quote-1/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({}),
  })
}

const convert = () => POST(makeReq(), { params: Promise.resolve({ id: 'quote-1' }) })

function seedQuote() {
  documents = [
    {
      id: 'quote-1',
      restaurant_id: 'rest-1',
      document_type: 'quote',
      status: 'sent',
      ship_to: {},
      bill_to: { name: 'Acme Corp' },
      line_items: [{ description: 'Catering', quantity: 1, unit_price: 5000, tax_rate_id: null }],
      reference_note: null,
    },
  ]
  createdInvoices = []
}

describe('POST /api/admin/documents/[id]/convert -- duplicate invoice race', () => {
  beforeEach(() => {
    readBarrier = null
  })

  it('mints TWO invoices from one quote when converted concurrently', async () => {
    seedQuote()
    readBarrier = makeBarrier(2) // both read status='sent' before either writes 'converted'

    const [resA, resB] = await Promise.all([convert(), convert()])

    // Both succeed; neither sees the other's transition.
    expect(resA.status).toBe(201)
    expect(resB.status).toBe(201)

    expect(createdInvoices).toHaveLength(2)
    const numbers = createdInvoices.map((d) => d.document_number)
    expect(new Set(numbers).size).toBe(2) // two distinct billable documents
    // Both point back at the same quote -- N$5000 billed twice.
    expect(createdInvoices.every((d) => d.quote_id === 'quote-1')).toBe(true)
  })

  it('CONTROL: sequential conversion correctly rejects the second attempt with 409', async () => {
    seedQuote()
    readBarrier = null // no concurrency: each request completes before the next starts

    const first = await convert()
    expect(first.status).toBe(201)

    const second = await convert()
    // The guard itself is correct -- only the missing atomicity fails.
    expect(second.status).toBe(409)
    const body = await second.json()
    expect(String(body.error)).toContain('already been converted')

    expect(createdInvoices).toHaveLength(1)
  })
})
