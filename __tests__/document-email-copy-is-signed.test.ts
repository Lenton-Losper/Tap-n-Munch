/**
 * THE SIGNED COPY OF THE INVOICE EMAIL. SIGNED 2026-09-05 BY THE OWNER.
 *
 * ============================================================================================
 * WHAT THIS IS FOR
 * ============================================================================================
 *
 * This is the only customer-facing copy FlashTap sends about money owed, and it goes to the
 * customer's accounts payable, not to our own user. It was read line by line and signed off. This
 * suite pins the signed wording so it cannot drift by accident — a tidy-up, a refactor of the
 * template, or someone "improving" a sentence all fail here rather than silently changing what a
 * customer reads.
 *
 * IF YOU ARE HERE BECAUSE THIS SUITE IS RED: that is the suite working. Copy changes are a
 * SIGNATURE, not a code review. Get the new wording signed, then change the constants below in the
 * same commit as the template, and say in the commit message who signed it and when.
 *
 * ============================================================================================
 * WHAT WAS DELIBERATELY CUT, AND MUST NOT COME BACK
 * ============================================================================================
 *
 * The draft ended with "Questions about this invoice? Reply to this email and it will reach
 * <venue>." It was CUT at signing because it was false — replies go to noreply@flashtap.app and
 * reach nobody. Setting `reply_to` to the venue was considered and rejected in the same breath:
 * replies landing in an unwatched venue mailbox are worse than no invitation to reply, because the
 * customer believes they have been in touch. The venue's contact details are on the attached PDF.
 *
 * There is a test below that fails if any invitation to reply reappears.
 */
import { renderDocumentEmailHtml } from '@/lib/documents/sendDocumentEmail'

const SIGNED_ON = '2026-09-05'

/** The exact document used to review the copy. Do not change these to make a test pass. */
const SPECIMEN = {
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
} as const

/**
 * Tags stripped, whitespace collapsed — what a person actually reads.
 *
 * Source newlines are flattened FIRST, so a label and its value that happen to sit on separate
 * lines of the template still read as one row. Row boundaries then come only from the closing
 * block tags, and ` | ` separates a label from its value. Without the flatten, reformatting the
 * template would change this suite's expectations without changing a word the customer sees.
 */
function visibleText(html: string): string {
  return html
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<\/(tr|p|h2|table|div)>/g, '\n')
    .replace(/<\/td>\s*<td[^>]*>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

describe(`the signed invoice email copy (signed ${SIGNED_ON})`, () => {
  const text = visibleText(renderDocumentEmailHtml({ ...SPECIMEN }))

  it('reads exactly as signed', () => {
    expect(text).toBe(
      [
        'Hi Acme CC,',
        'Invoice INV-1043 from Riviera is attached as a PDF.',
        'Amount | NAD 575.00',
        'Due | 30 September 2026',
        'How to pay',
        'Bank | Bank Windhoek',
        'Account name | Riviera Trading CC',
        'Account number | 80001234567',
        'Branch code | 481972',
        'Reference | INV-1043',
      ].join('\n'),
    )
  })

  it('does not invite a reply — cut at signing, because replies reach nobody', () => {
    expect(text.toLowerCase()).not.toContain('reply')
    expect(text.toLowerCase()).not.toContain('get in touch')
    expect(text.toLowerCase()).not.toContain('contact us')
  })

  it('keeps Reference as the payment reference label', () => {
    // Signed as-is: the conventional thing on a Namibian invoice. A venue that reconciles
    // differently will say so; until then this is not a detail to improve unilaterally.
    expect(text).toContain('Reference | INV-1043')
  })

  it('greets without a name when the document has none', () => {
    const t = visibleText(renderDocumentEmailHtml({ ...SPECIMEN, bill_to_name: null }))
    expect(t.startsWith('Hello,')).toBe(true)
    expect(t).not.toContain('Hi ,')
    expect(t).not.toContain('undefined')
    expect(t).not.toContain('null')
  })

  it('drops the Due row rather than printing an empty one', () => {
    const t = visibleText(renderDocumentEmailHtml({ ...SPECIMEN, due_date: null }))
    expect(t).not.toContain('Due')
    expect(t).toContain('Amount | NAD 575.00')
  })

  it('never says the word "document" to a customer', () => {
    for (const type of ['invoice', 'quote', 'credit_note']) {
      const t = visibleText(renderDocumentEmailHtml({ ...SPECIMEN, document_type: type }))
      expect(t.toLowerCase()).not.toContain('document')
    }
  })

  it('names a quote a Quote and a credit note a Credit note', () => {
    expect(visibleText(renderDocumentEmailHtml({ ...SPECIMEN, document_type: 'quote' }))).toContain(
      'Quote INV-1043 from Riviera is attached as a PDF.',
    )
    expect(
      visibleText(renderDocumentEmailHtml({ ...SPECIMEN, document_type: 'credit_note' })),
    ).toContain('Credit note INV-1043 from Riviera is attached as a PDF.')
  })

  it('falls back to FlashTap when the document carries no venue name', () => {
    const t = visibleText(renderDocumentEmailHtml({ ...SPECIMEN, business_name: null }))
    expect(t).toContain('Invoice INV-1043 from FlashTap is attached as a PDF.')
  })
})
