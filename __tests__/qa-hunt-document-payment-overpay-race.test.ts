/**
 * BUG REPRO (bug-hunter): POST /api/admin/documents/[id]/payments over-pays an invoice
 * under concurrency, and the result is permanently uncorrectable.
 *
 * The over-payment guard is a read-then-write with nothing between them:
 *   route.ts:101  const doc = await loadDocumentForPayment(supabase, documentId)
 *   route.ts:121  const currentBalance = Number(doc.balance)
 *   route.ts:122  if (amount > currentBalance) -> 400
 *   route.ts:129  await supabase.from('document_payments').insert({...})   <- unconditional
 *   route.ts:142  await recomputeDocumentStatus(...)
 *
 * The INSERT carries no predicate on the balance that was just validated, there is no
 * idempotency key, and no transaction spans the check and the write. Two requests that
 * both read balance=100 both pass the check and both insert.
 *
 * Why it cannot be undone: document_payments is append-only by design. Migration
 * 20260722140000 grants only SELECT + INSERT policies ("no update/delete path, ever"),
 * the sole CHECK is `amount > 0`, there is no trigger on the table, and no PATCH/DELETE
 * route exists. So the surplus row is permanent.
 *
 * The UI (components/documents/record-payment-modal.tsx) disables its submit button while
 * `saving`, which stops a naive double-click on ONE client -- it does not stop two staff,
 * two tabs, or a client retry after a timeout, and the server has no guard at all.
 *
 * VERIFIED AGAINST origin/main: `git diff origin/main` is empty for both the route and
 * lib/documents/recompute-status.ts. recomputeDocumentStatus runs for real here (not mocked).
 *
 * Asserts CURRENT behaviour; should FAIL once the write is made atomic.
 */
import { POST } from '@/app/api/admin/documents/[id]/payments/route'

type Doc = Record<string, any>
type Payment = Record<string, any>

let documents: Doc[] = []
let payments: Payment[] = []

/**
 * Releases readers only once `size` of them have arrived, so every concurrent request
 * observes the same pre-write balance. Faithful to production: the route takes no row
 * lock and runs no transaction across the check and the insert, so on a real Postgres
 * two concurrent requests genuinely both read balance=100. A plain setTimeout is not
 * enough -- the single-threaded test loop can run one request to completion between the
 * other's timer callbacks, serialising them and hiding the defect.
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

/** null = no concurrency (sequential control case). */
let readBarrier: (() => Promise<void>) | null = null

function selectBuilder(rowsFor: () => Doc[], opts: { barrier?: boolean } = {}) {
  const filters: Array<[string, unknown]> = []
  const apply = () => rowsFor().filter((r) => filters.every(([c, v]) => r[c] === v))
  const b: Record<string, any> = {
    eq(c: string, v: unknown) {
      filters.push([c, v])
      return b
    },
    order() {
      return b
    },
    async single() {
      const m = apply()
      return { data: m[0] ?? null, error: m[0] ? null : { message: 'not found' } }
    },
    async maybeSingle() {
      if (opts.barrier && readBarrier) await readBarrier()
      return { data: apply()[0] ?? null, error: null }
    },
    then(resolve: (v: unknown) => void) {
      resolve({ data: apply(), error: null })
    },
  }
  return b
}

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      if (table === 'business_documents') {
        return {
          select: () => selectBuilder(() => documents, { barrier: true }),
          update: (patch: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = []
            const b: Record<string, any> = {
              eq(c: string, v: unknown) {
                filters.push([c, v])
                return b
              },
              then(resolve: (v: unknown) => void) {
                documents
                  .filter((r) => filters.every(([c, v]) => r[c] === v))
                  .forEach((r) => Object.assign(r, patch))
                resolve({ error: null })
              },
            }
            return b
          },
        }
      }
      if (table === 'document_payments') {
        return {
          select: () => selectBuilder(() => payments),
          insert: (row: Record<string, unknown>) => {
            const created = { id: `pay-${payments.length + 1}`, ...row }
            payments.push(created)
            return {
              select: () => ({
                single: async () => ({ data: created, error: null }),
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-1' }),
  requireCallerRestaurantId: async () => 'rest-1',
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null, // null = permitted
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

function makeReq(amount: number) {
  return new Request('https://example.test/api/admin/documents/doc-1/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ amount, method: 'eft', reference: 'CHQ-001' }),
  })
}

const post = (amount: number) =>
  POST(makeReq(amount), { params: Promise.resolve({ id: 'doc-1' }) })

function seedInvoice(total: number) {
  documents = [
    {
      id: 'doc-1',
      restaurant_id: 'rest-1',
      document_type: 'invoice',
      status: 'sent',
      total,
      balance: total,
      due_date: null,
    },
  ]
  payments = []
}

describe('POST /api/admin/documents/[id]/payments -- over-payment race', () => {
  beforeEach(() => {
    readBarrier = null
  })

  it('accepts two concurrent full payments on a 100 invoice, banking 200 against it', async () => {
    seedInvoice(100)
    readBarrier = makeBarrier(2) // both read balance=100 before either inserts

    const [resA, resB] = await Promise.all([post(100), post(100)])

    // Neither request is rejected -- the guard never sees the other's write.
    expect(resA.status).toBe(201)
    expect(resB.status).toBe(201)

    expect(payments).toHaveLength(2)
    const banked = payments.reduce((s, p) => s + Number(p.amount), 0)
    expect(banked).toBe(200)

    // The invoice is left with a negative balance and no way to correct it.
    expect(Number(documents[0].balance)).toBe(-100)
    expect(documents[0].status).toBe('paid')
  })

  it('the surplus is unrecoverable: document_payments exposes no update or delete', async () => {
    seedInvoice(100)
    readBarrier = makeBarrier(2)
    await Promise.all([post(100), post(100)])

    const table = makeSupabaseMock().from('document_payments') as Record<string, unknown>
    expect(typeof table.insert).toBe('function')
    expect(typeof table.select).toBe('function')
    // Mirrors the RLS grant (SELECT + INSERT only) and the absence of any PATCH/DELETE route.
    expect(table.update).toBeUndefined()
    expect(table.delete).toBeUndefined()
  })

  it('overshoots on partial payments too -- 3 x 40 against a 100 balance', async () => {
    seedInvoice(100)
    readBarrier = makeBarrier(3)

    const results = await Promise.all([post(40), post(40), post(40)])

    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(payments.reduce((s, p) => s + Number(p.amount), 0)) .toBe(120)
    expect(Number(documents[0].balance)).toBe(-20)
  })

  it('CONTROL: the same two payments SEQUENTIALLY are correctly rejected on the second', async () => {
    seedInvoice(100)
    readBarrier = null // no concurrency: each request completes before the next starts

    const first = await post(100)
    expect(first.status).toBe(201)

    const second = await post(100)
    // Proves the guard itself is correct and it is purely the missing atomicity that fails.
    expect(second.status).toBe(400)
    const body = await second.json()
    expect(String(body.error)).toContain('exceeds the remaining balance')

    expect(payments).toHaveLength(1)
    expect(Number(documents[0].balance)).toBe(0)
  })
})
