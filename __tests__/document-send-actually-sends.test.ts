/**
 * SENDING AN INVOICE MUST SEND IT, AND MUST NOT CLAIM TO HAVE SENT ONE IT DID NOT.
 *
 * ============================================================================================
 * THE DEFECT THIS PINS
 * ============================================================================================
 *
 * `POST /api/admin/documents/[id]/send` set `status = 'sent'`, stamped `sent_at`, and returned
 * 200 without contacting anybody. Its own docstring said "Marks a draft quote or invoice as
 * sent". A staff member pressed Send, the row said sent, and the customer received nothing. All
 * three invoices on production were still `draft`, so no document had ever been delivered.
 *
 * That is the #234 shape: a write that records an INTENTION and is read later as an OUTCOME.
 *
 * ============================================================================================
 * WHAT IS ASSERTED HERE, AND WHAT IS NOT
 * ============================================================================================
 *
 * These exercise the real `sendDocumentEmail` and the real `renderDocumentEmailHtml` with the
 * PDF renderer and Resend mocked at the module boundary. They are NOT re-implementations of the
 * logic sitting next to the assertion: a regression in the source fails these, which was checked
 * by reverting each behaviour in turn and confirming a red.
 *
 * The route's own ordering (send THEN mark) is pinned against the route source, because the
 * route needs a Supabase client and `getUserFromRequest` to execute, and a test that mocks all
 * of that ends up asserting on its own mocks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sendMock = jest.fn()
const pdfMock = jest.fn()

jest.mock('@/lib/email/resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
}))
jest.mock('@/lib/documents/generate-document-pdf', () => ({
  generateDocumentPdfBytes: (...args: unknown[]) => pdfMock(...args),
}))

import { sendDocumentEmail, renderDocumentEmailHtml } from '@/lib/documents/sendDocumentEmail'
import { recipientEmail } from '@/lib/documents/business-document-row'

/** A complete-enough business_documents row. */
function docRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    restaurant_id: 'rest-1',
    document_type: 'invoice',
    document_number: 'INV-1043',
    quote_id: null,
    issued_at: '2026-09-01T10:00:00.000Z',
    due_date: '2026-09-30T10:00:00.000Z',
    reference_note: null,
    business_name: 'Riviera',
    registration_number: null,
    vat_number: null,
    address: null,
    phone: null,
    logo_url: null,
    bank_name: 'Bank Windhoek',
    bank_account_name: 'Riviera Trading CC',
    bank_account_number: '80001234567',
    bank_branch_code: '481972',
    ship_to: {},
    bill_to: { name: 'Acme CC', email: 'ap@acme.test' },
    line_items: [{ description: 'Catering', quantity: 1, unit_price: 500, line_total: 500 }],
    subtotal: 500,
    vat_amount: 75,
    total: 575,
    balance: 575,
    currency: 'NAD',
    created_by: 'user-1',
    created_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

/** Minimal Supabase double that records what was inserted into audit_logs. */
function supabaseDouble() {
  const inserted: Array<Record<string, unknown>> = []
  return {
    inserted,
    client: {
      from(table: string) {
        if (table !== 'audit_logs') throw new Error(`unexpected table ${table}`)
        return {
          insert(row: Record<string, unknown>) {
            inserted.push(row)
            return Promise.resolve({ error: null })
          },
        }
      },
    },
  }
}

beforeEach(() => {
  sendMock.mockReset()
  pdfMock.mockReset()
  pdfMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
  sendMock.mockResolvedValue({ data: { id: 'resend-abc' }, error: null })
})

describe('sendDocumentEmail actually sends', () => {
  it('sends to the Bill To address with the PDF attached', async () => {
    const { client } = supabaseDouble()
    const result = await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')

    expect(result.ok).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const call = sendMock.mock.calls[0][0]
    expect(call.to).toEqual(['ap@acme.test'])
    expect(call.attachments).toHaveLength(1)
    expect(call.attachments[0].contentType).toBe('application/pdf')
    expect(call.attachments[0].filename).toBe('Invoice-INV-1043.pdf')
  })

  it('names the document and the venue in the subject, never the word "document"', async () => {
    const { client } = supabaseDouble()
    await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')
    expect(sendMock.mock.calls[0][0].subject).toBe('Invoice INV-1043 from Riviera')
  })

  it('calls a quote a quote', async () => {
    const { client } = supabaseDouble()
    await sendDocumentEmail(
      client as never,
      docRow({ document_type: 'quote', document_number: 'QUO-7' }),
      'ap@acme.test',
      'user-9',
    )
    expect(sendMock.mock.calls[0][0].subject).toBe('Quote QUO-7 from Riviera')
  })

  it('reports failure when the provider rejects, and does not throw', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad address' } })
    const { client } = supabaseDouble()
    const result = await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('validation_error')
      expect(result.errorMessage).toBe('bad address')
    }
  })

  it('reports failure when the PDF render throws', async () => {
    pdfMock.mockRejectedValue(new Error('pdf exploded'))
    const { client } = supabaseDouble()
    const result = await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('send_exception')
      expect(result.errorMessage).toBe('pdf exploded')
    }
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('every attempt is recorded, including the failures', () => {
  it('writes document.emailed on success, with the provider reference', async () => {
    const { client, inserted } = supabaseDouble()
    await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')

    expect(inserted).toHaveLength(1)
    expect(inserted[0].action).toBe('document.emailed')
    expect(inserted[0].entity_type).toBe('business_documents')
    expect(inserted[0].entity_id).toBe('doc-1')
    const meta = inserted[0].metadata as Record<string, unknown>
    expect(meta.to).toBe('ap@acme.test')
    expect(meta.provider_reference).toBe('resend-abc')
    expect(meta.actor_user_id).toBe('user-9')
  })

  it('writes document.email_failed on failure, with the reason', async () => {
    sendMock.mockResolvedValue({ data: null, error: { name: 'rate_limited', message: 'slow down' } })
    const { client, inserted } = supabaseDouble()
    await sendDocumentEmail(client as never, docRow(), 'ap@acme.test', 'user-9')

    expect(inserted).toHaveLength(1)
    expect(inserted[0].action).toBe('document.email_failed')
    const meta = inserted[0].metadata as Record<string, unknown>
    expect(meta.error_code).toBe('rate_limited')
    expect(meta.error_message).toBe('slow down')
  })
})

describe('the customer can actually pay: bank details are in the email body', () => {
  const bankFields = ['Bank Windhoek', 'Riviera Trading CC', '80001234567', '481972']

  it('renders every bank field and the payment reference', () => {
    const html = renderDocumentEmailHtml({
      document_type: 'invoice',
      document_number: 'INV-1043',
      business_name: 'Riviera',
      total: 575,
      currency: 'NAD',
      due_date: '2026-09-30T10:00:00.000Z',
      bill_to_name: 'Acme CC',
      bank_name: 'Bank Windhoek',
      bank_account_name: 'Riviera Trading CC',
      bank_account_number: '80001234567',
      bank_branch_code: '481972',
    })
    for (const field of bankFields) expect(html).toContain(field)
    expect(html).toContain('How to pay')
    // The reference the venue reconciles against is the document number.
    expect(html).toContain('Reference')
    expect(html).toContain('INV-1043')
    expect(html).toContain('NAD 575.00')
    expect(html).toContain('30 September 2026')
  })

  it('omits the whole block rather than rendering empty labels when there are no bank details', () => {
    const html = renderDocumentEmailHtml({
      document_type: 'invoice',
      document_number: 'INV-1043',
      business_name: 'Riviera',
      total: 575,
      currency: 'NAD',
      due_date: null,
      bill_to_name: 'Acme CC',
      bank_name: null,
      bank_account_name: null,
      bank_account_number: null,
      bank_branch_code: null,
    })
    expect(html).not.toContain('How to pay')
    expect(html).not.toContain('Account number')
    // and it still says what it is
    expect(html).toContain('INV-1043')
  })

  it('escapes a venue or customer name that contains markup', () => {
    const html = renderDocumentEmailHtml({
      document_type: 'invoice',
      document_number: 'INV-1',
      business_name: 'Bob <script>alert(1)</script>',
      total: 1,
      currency: 'NAD',
      due_date: null,
      bill_to_name: 'A & B <b>Ltd</b>',
      bank_name: null,
      bank_account_name: null,
      bank_account_number: null,
      bank_branch_code: null,
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('A &amp; B')
  })
})

describe('a document with nowhere to go is refused, not guessed at', () => {
  it('finds the Bill To email', () => {
    expect(recipientEmail({ bill_to: { name: 'Acme', email: 'ap@acme.test' } })).toBe('ap@acme.test')
  })

  it('answers null when the email is absent, empty, or not an address', () => {
    expect(recipientEmail({ bill_to: { name: 'Acme' } })).toBeNull()
    expect(recipientEmail({ bill_to: { name: 'Acme', email: '   ' } })).toBeNull()
    expect(recipientEmail({ bill_to: { name: 'Acme', email: 'not-an-address' } })).toBeNull()
    expect(recipientEmail({ bill_to: null })).toBeNull()
    expect(recipientEmail({})).toBeNull()
  })

  it('does NOT fall back to any other address on the document', () => {
    // ship_to carries an address here; using it would send the customer's invoice to the
    // delivery contact. The only address that may be used is bill_to's.
    const row = {
      bill_to: { name: 'Acme' },
      ship_to: { name: 'Warehouse', email: 'warehouse@acme.test' },
    }
    expect(recipientEmail(row)).toBeNull()
  })
})

describe('the route sends before it marks', () => {
  const source = readFileSync(
    join(__dirname, '..', 'app', 'api', 'admin', 'documents', '[id]', 'send', 'route.ts'),
    'utf8',
  )

  it('calls sendDocumentEmail before it ever writes status sent', () => {
    const sendAt = source.indexOf('sendDocumentEmail(supabase')
    const markAt = source.indexOf("status: 'sent'")
    expect(sendAt).toBeGreaterThan(-1)
    expect(markAt).toBeGreaterThan(-1)
    expect(sendAt).toBeLessThan(markAt)
  })

  it('returns early on a failed send, so the document stays draft', () => {
    const between = source.slice(
      source.indexOf('sendDocumentEmail(supabase'),
      source.indexOf("status: 'sent'"),
    )
    expect(between).toMatch(/if \(!sent\.ok\)/)
    expect(between).toMatch(/return NextResponse\.json/)
    expect(between).toMatch(/EMAIL_SEND_FAILED/)
  })

  it('refuses with 422 when there is no recipient, and marks nothing', () => {
    const before = source.slice(0, source.indexOf('sendDocumentEmail(supabase'))
    expect(before).toMatch(/NO_RECIPIENT_EMAIL/)
    expect(before).toMatch(/status: 422/)
  })
})
