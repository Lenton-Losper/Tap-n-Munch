/**
 * A PAID INVOICE CAN BE SENT, SAYS IT IS PAID, AND IS NEVER SENT TWICE -- Sprint 2026-09-28 brief.
 *
 * An invoice raised from a tab that was settled at the table is recorded with its payments at
 * creation, so the document engine's recompute moves it straight from 'draft' to 'paid'. The send
 * route only sent drafts, which made the paid invoice the one invoice a customer could never be
 * emailed. These run the REAL send route against the in-memory store, with Resend mocked at the
 * module boundary, the way document-send-actually-sends.test.ts does.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'

const sendMock = jest.fn()
let db: InMemoryDb

jest.mock('@/lib/email/resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => db.client(),
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'user-1' }),
}))
jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))

import { renderDocumentEmailHtml } from '@/lib/documents/sendDocumentEmail'

const route = require('@/app/api/admin/documents/[id]/send/route') as {
  POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-paid',
    restaurant_id: 'rest-1',
    document_type: 'invoice',
    document_number: '1043',
    issued_at: '2026-09-28T08:00:00.000Z',
    due_date: null,
    reference_note: 'FlashTap tab · table 1 · orders #154, #155',
    business_name: 'Riviera',
    bank_name: 'Bank Windhoek',
    bank_account_number: '8009112233',
    ship_to: {},
    bill_to: { name: 'Acme CC', email: 'ap@acme.test' },
    line_items: [{ description: 'Seared Salmon', quantity: 1, unit_price: 720, line_total: 720 }],
    subtotal: 626.09,
    vat_amount: 93.91,
    total: 720,
    balance: 0,
    currency: 'NAD',
    status: 'paid',
    sent_at: null,
    created_by: 'user-1',
    created_at: '2026-09-28T08:00:00.000Z',
    ...overrides,
  }
}

function seed(doc: Record<string, unknown>, payments: Record<string, unknown>[] = []) {
  db = new InMemoryDb({
    business_documents: [doc],
    document_payments: payments,
    audit_logs: [],
  })
}

const send = (id = 'doc-paid') =>
  route.POST(new Request(`http://localhost/api/admin/documents/${id}/send`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })

beforeEach(() => {
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null })
})

describe('the send route', () => {
  test('sends a never-sent PAID invoice, keeps it paid, and stamps sent_at', async () => {
    seed(invoiceRow(), [
      { id: 'p1', document_id: 'doc-paid', amount: 720, method: 'card', reference: 'TXN-RIV-1', paid_at: '2026-09-24T21:00:00.000Z' },
    ])

    const res = await send()
    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)

    const row = db.rows('business_documents')[0]
    expect(row.status).toBe('paid')
    expect(row.sent_at).toBeTruthy()

    const html = String(sendMock.mock.calls[0][0].html)
    expect(html).toContain('Paid')
    expect(html).toContain('Outstanding')
    expect(html).not.toContain('How to pay')
  })

  test('refuses to send it a second time', async () => {
    seed(invoiceRow({ sent_at: '2026-09-28T09:00:00.000Z' }))
    const res = await send()
    expect(res.status).toBe(409)
    expect(sendMock).not.toHaveBeenCalled()
  })

  test('a DRAFT still becomes sent, exactly as before', async () => {
    seed(invoiceRow({ status: 'draft', balance: 720 }))
    const res = await send()
    expect(res.status).toBe(200)
    expect(db.rows('business_documents')[0].status).toBe('sent')
  })

  test('a sent-but-unpaid invoice is still not resendable', async () => {
    seed(invoiceRow({ status: 'sent', balance: 720, sent_at: '2026-09-28T09:00:00.000Z' }))
    expect((await send()).status).toBe(409)
  })
})

describe('the email copy', () => {
  const base = {
    document_type: 'invoice',
    document_number: 'INV-1',
    business_name: 'Riviera',
    total: 575,
    currency: 'NAD',
    due_date: '2026-09-30T10:00:00.000Z',
    bill_to_name: 'Acme CC',
    bank_name: 'Bank Windhoek',
    bank_account_name: 'Riviera CC',
    bank_account_number: '800',
    bank_branch_code: '481972',
  }

  test('an unpaid invoice (balance = total) renders the signed copy byte for byte', () => {
    expect(renderDocumentEmailHtml({ ...base, balance: 575 })).toBe(renderDocumentEmailHtml(base))
  })

  test('a partially paid invoice says what was paid and what is outstanding, and still says how to pay', () => {
    const html = renderDocumentEmailHtml({ ...base, balance: 175 })
    expect(html).toContain('NAD 400.00')
    expect(html).toContain('NAD 175.00')
    expect(html).toContain('How to pay')
  })
})
