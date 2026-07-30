/**
 * BUG REPRO (bug-hunter): recomputeDocumentStatus() is itself a read-then-write with no
 * guard, so two overlapping recomputes lose an update and persist a STALE, INFLATED
 * business_documents.balance.
 *
 *   lib/documents/recompute-status.ts:48-57  read document_payments + issued credit notes
 *   lib/documents/recompute-status.ts:61-63  balance = total - paid - credited
 *   lib/documents/recompute-status.ts:78-81  .update({ status, balance }).eq('id', documentId)
 *                                            <- no predicate on the balance it read
 *
 * This matters for the over-payment fix specifically: the payments route gates on the
 * STORED column (`const currentBalance = Number(doc.balance)`,
 * app/api/admin/documents/[id]/payments/route.ts:121). If that column can be left stale
 * and too high, then a fix that keeps trusting the stored column inherits a second,
 * independent over-payment path. A correct guard must recompute the available amount from
 * document_payments inside the same locked transaction -- exactly what
 * record_terminal_refund_event() does (migration 20260727120000:50-72).
 *
 * recomputeDocumentStatus is called from three places, so overlap is reachable:
 *   documents/[id]/payments/route.ts:142   (per payment)
 *   documents/[id]/send/route.ts:66        (on send)
 *   documents/aged-receivables/route.ts:65 (in a LOOP over every overdue invoice)
 *
 * VERIFIED AGAINST origin/main (74356aa): `git diff origin/main -- lib/documents/recompute-status.ts`
 * is empty. The function under test is real, not mocked.
 *
 * Asserts CURRENT behaviour; should FAIL once the write is guarded.
 */
import { recomputeDocumentStatus } from '@/lib/documents/recompute-status'

type Row = Record<string, any>

let documents: Row[] = []
let payments: Row[] = []

/** Holds the next UPDATE until released, to interleave two recomputes deterministically. */
let updateGate: Promise<void> | null = null

function selectBuilder(rowsFor: () => Row[]) {
  const filters: Array<[string, unknown]> = []
  const apply = () => rowsFor().filter((r) => filters.every(([c, v]) => r[c] === v))
  const b: Record<string, any> = {
    eq(c: string, v: unknown) {
      filters.push([c, v])
      return b
    },
    async single() {
      const m = apply()
      return { data: m[0] ?? null, error: m[0] ? null : { message: 'not found' } }
    },
    then(resolve: (v: unknown) => void) {
      resolve({ data: apply(), error: null })
    },
  }
  return b
}

const supabase = {
  from: (table: string) => {
    if (table === 'business_documents') {
      return {
        select: () => selectBuilder(() => documents),
        update: (patch: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = []
          const b: Record<string, any> = {
            eq(c: string, v: unknown) {
              filters.push([c, v])
              return b
            },
            then(resolve: (v: unknown) => void) {
              const gate = updateGate
              updateGate = null // only the first writer through this call is held
              const write = () => {
                documents
                  .filter((r) => filters.every(([c, v]) => r[c] === v))
                  .forEach((r) => Object.assign(r, patch))
                resolve({ error: null })
              }
              if (gate) void gate.then(write)
              else write()
            },
          }
          return b
        },
      }
    }
    if (table === 'document_payments') {
      return { select: () => selectBuilder(() => payments) }
    }
    throw new Error(`unexpected table ${table}`)
  },
} as any

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

describe('recomputeDocumentStatus -- lost update leaves an inflated stored balance', () => {
  beforeEach(() => {
    updateGate = null
  })

  it('persists a stale balance when a second payment lands mid-recompute', async () => {
    seedInvoice(100)

    // Payment 1 of 40 arrives; recompute A reads [40] but is held before writing.
    payments.push({ document_id: 'doc-1', amount: 40 })
    let releaseA: () => void
    updateGate = new Promise<void>((r) => {
      releaseA = r
    })
    const recomputeA = recomputeDocumentStatus(supabase, 'doc-1')

    // Let A get past its reads and reach the held UPDATE.
    await Promise.resolve()
    await Promise.resolve()

    // Payment 2 of 60 arrives and its own recompute completes: balance correctly 0.
    payments.push({ document_id: 'doc-1', amount: 60 })
    const b = await recomputeDocumentStatus(supabase, 'doc-1')
    expect(b.balance).toBe(0)
    expect(documents[0].balance).toBe(0)

    // Now A's write lands, computed from its stale read of [40] only.
    releaseA!()
    await recomputeA

    // The invoice is fully paid (40 + 60 = 100) but the stored column says 60 is owed.
    expect(payments.reduce((s, p) => s + Number(p.amount), 0)).toBe(100)
    expect(Number(documents[0].balance)).toBe(60)
    // ...and the status was dragged back off 'paid'.
    expect(documents[0].status).toBe('partially_paid')
  })

  it('the stale balance re-opens over-payment: 60 more is now accepted against a settled invoice', async () => {
    seedInvoice(100)
    payments.push({ document_id: 'doc-1', amount: 40 })
    let releaseA: () => void
    updateGate = new Promise<void>((r) => {
      releaseA = r
    })
    const recomputeA = recomputeDocumentStatus(supabase, 'doc-1')
    await Promise.resolve()
    await Promise.resolve()
    payments.push({ document_id: 'doc-1', amount: 60 })
    await recomputeDocumentStatus(supabase, 'doc-1')
    releaseA!()
    await recomputeA

    // This is the exact check the payments route performs at route.ts:121-122.
    const currentBalance = Number(documents[0].balance)
    const nextPayment = 60
    const wouldBeRejected = nextPayment > currentBalance
    expect(wouldBeRejected).toBe(false) // accepted -- 160 banked against a 100 invoice

    expect(currentBalance).toBe(60)
  })

  it('CONTROL: sequential recomputes converge on the correct balance', async () => {
    seedInvoice(100)

    payments.push({ document_id: 'doc-1', amount: 40 })
    const first = await recomputeDocumentStatus(supabase, 'doc-1')
    expect(first.balance).toBe(60)
    expect(first.status).toBe('partially_paid')

    payments.push({ document_id: 'doc-1', amount: 60 })
    const second = await recomputeDocumentStatus(supabase, 'doc-1')
    // Proves the arithmetic is correct and only the missing write guard fails.
    expect(second.balance).toBe(0)
    expect(second.status).toBe('paid')
    expect(Number(documents[0].balance)).toBe(0)
  })
})
