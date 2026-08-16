/**
 * Binds to lib/tabs/browse-tab-strip.ts.
 *
 * THE TEST THAT IS THE POINT is `keeps the pending note when a PIN is shown`. The strip's
 * previous inline form was a three-way ternary in JSX; the pending figure was appended to its two
 * template-string arms and NOT to the JSX arm, which is the arm taken whenever the tab has a PIN.
 * So on a PIN-protected tab -- the ordinary case -- a customer who had just ordered saw the
 * payable figure with nothing naming the amount awaiting confirmation. Every other case here is
 * ordinary coverage; that one is the regression.
 *
 * These assert STRUCTURE and the presence of the figures, not wording. The strings are
 * PENDING COPY and will change; the rule that an amount never appears without its pending note
 * must not.
 */
import { buildBrowseTabStrip } from '@/lib/tabs/browse-tab-strip'
import { TAB_FIGURES_COPY } from '@/lib/tabs/tab-outstanding'

const base = {
  tabStatus: 'open' as string | null | undefined,
  currency: 'N$',
  total: 180,
  pending: 20,
  memberCount: 3,
  tabPin: null as string | null,
  tabPinRequired: true,
}

/** The pending figure the copy module would render for `pending`, so the test does not restate it. */
function expectedPendingNote(pending: number): string {
  return TAB_FIGURES_COPY.tabPendingSuffix.replace('{pending}', `N$${pending.toFixed(2)}`)
}

describe('buildBrowseTabStrip — the two figures', () => {
  it('shows the total and names the pending part', () => {
    const strip = buildBrowseTabStrip(base)
    expect(strip.amount).toBe('N$180.00')
    expect(strip.pendingNote).toBe(expectedPendingNote(20))
  })

  it('keeps the pending note when a PIN is shown — the defect this module exists for', () => {
    const withPin = buildBrowseTabStrip({ ...base, tabPin: '1490', tabPinRequired: true })
    const withoutPin = buildBrowseTabStrip({ ...base, tabPin: null })

    // Whether a PIN is on screen has nothing to do with what the table owes.
    expect(withPin.pendingNote).toBe(withoutPin.pendingNote)
    expect(withPin.pendingNote).toBe(expectedPendingNote(20))
    expect(withPin.amount).toBe(withoutPin.amount)
  })

  it('keeps the pending note in the ready_to_pay state too', () => {
    const strip = buildBrowseTabStrip({ ...base, tabStatus: 'ready_to_pay', tabPin: '1490' })
    expect(strip.amount).toBe('N$180.00')
    expect(strip.pendingNote).toBe(expectedPendingNote(20))
  })

  it('omits the pending note only when there is no pending money', () => {
    const strip = buildBrowseTabStrip({ ...base, pending: 0 })
    expect(strip.pendingNote).toBeNull()
    expect(strip.amount).toBe('N$180.00')
  })

  it('never emits an amount without also deciding the pending note', () => {
    // The structural claim: for every state that shows money, both fields come from one call.
    for (const tabStatus of ['open', 'ready_to_pay', null, undefined, 'OPEN']) {
      const strip = buildBrowseTabStrip({ ...base, tabStatus, tabPin: '1490' })
      if (strip.amount !== null) expect(strip.pendingNote).toBe(expectedPendingNote(20))
    }
  })
})

describe('buildBrowseTabStrip — the demoted second line', () => {
  it('carries the PIN in the exact form the page has always rendered', () => {
    const strip = buildBrowseTabStrip({ ...base, tabPin: '1490', tabPinRequired: true })
    // browse-tab-pin-visible-to-joined-member.test.tsx asserts this substring on the real page.
    expect(strip.meta).toContain('PIN: 1490')
  })

  it('withholds the PIN when the tab does not require one', () => {
    const strip = buildBrowseTabStrip({ ...base, tabPin: '1490', tabPinRequired: false })
    expect(strip.meta).not.toContain('PIN')
  })

  it('withholds the PIN when the server did not release it', () => {
    const strip = buildBrowseTabStrip({ ...base, tabPin: null, tabPinRequired: true })
    expect(strip.meta).not.toContain('PIN')
  })

  it('pluralises the member count', () => {
    expect(buildBrowseTabStrip({ ...base, memberCount: 1 }).meta).toContain('1 person')
    expect(buildBrowseTabStrip({ ...base, memberCount: 4 }).meta).toContain('4 people')
  })

  it('has no second line at all when there is nothing to put on it', () => {
    expect(buildBrowseTabStrip({ ...base, tabPin: null, memberCount: 0 }).meta).toBeNull()
  })
})

describe('buildBrowseTabStrip — closed states', () => {
  it.each(['closed', 'settled', 'completed', 'cancelled', 'SETTLED'])(
    'shows no amount and no PIN on a %s tab',
    (tabStatus) => {
      const strip = buildBrowseTabStrip({ ...base, tabStatus, tabPin: '1490' })
      expect(strip.amount).toBeNull()
      expect(strip.pendingNote).toBeNull()
      expect(strip.meta).toBeNull()
    }
  )
})

describe('buildBrowseTabStrip — the strip navigates, it does not settle', () => {
  it('offers a view affordance rather than a settle one in every live state', () => {
    for (const tabStatus of ['open', 'ready_to_pay', 'closed']) {
      const strip = buildBrowseTabStrip({ ...base, tabStatus })
      // Spec section 30: settlement belongs on the Tab. Wording is PENDING COPY; that the
      // strip stopped promising to settle is the assertion.
      expect(strip.cta.toLowerCase()).not.toContain('settle')
    }
  })
})
