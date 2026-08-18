/**
 * #296 -- the confirmation screen must not invent an order number.
 *
 * An `order_requests` row has NO `order_number` column at all. A number is allocated when staff
 * Accept, which creates the `orders` row. The confirmation screen mapped
 * `Number(row.order_number || 0)` and the view rendered `#{orderNumber}` unconditionally, so
 * every submitted-but-unaccepted request displayed **"Order #0"** — prominently, in bold green,
 * directly under "Order Placed!".
 *
 * THE DECISION IS REUSED, NOT RE-INVENTED. `tab/page.tsx` already answers this question:
 *
 *     order.order_number != null ? `Order #${order.order_number}` : tabOrderNotYetNumbered
 *
 * The same predicate and the same copy constant are used here. A second, differently-worded
 * answer to "what do we show when there is no number yet" is how two screens start disagreeing
 * about the same fact.
 *
 * Source scan, because the defect is a coercion in a mapper and a branch in a client component.
 * `tsc` types `Number(x || 0)` and `x ?? null` identically at the call site, and jest cannot
 * reach the render without standing up the router and three fetch clients.
 */
import fs from 'fs'
import path from 'path'

/** Normalised to LF: this repo checks out CRLF on Windows. */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n')

/** Assertions are about CODE, not the comments explaining it. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PAGE = read('app', 'menu', '[restaurantId]', 'order-confirmation', '[orderId]', 'page.tsx')
const VIEW = read('components', 'receipt', 'order-confirmation-view.tsx')
const TAB = read('app', 'menu', '[restaurantId]', 'tab', 'page.tsx')
const COPY = read('lib', 'customer-copy', 'qr-redesign-copy.ts')

describe('#296 the mapper stops coercing a missing number to zero', () => {
  it('the scan found the real page', () => {
    expect(PAGE).toContain('fetchGuestOrderById')
  })

  it('does not coerce with `|| 0`', () => {
    // The whole defect, in one expression.
    expect(codeOnly(PAGE)).not.toContain('Number(row.order_number || 0)')
  })

  it('passes null through instead', () => {
    expect(codeOnly(PAGE)).toContain('row.order_number != null ? Number(row.order_number) : null')
  })

  it('the type admits null, so the compiler holds the view to it', () => {
    expect(codeOnly(PAGE)).toMatch(/order_number: number \| null/)
  })
})

describe('#296 the view shows a number only when one exists', () => {
  it('every render of the number sits INSIDE the null guard', () => {
    // My first version of this assertion forbade `>#{orderNumber}<` outright and failed against
    // the fix, because the guarded branch legitimately renders exactly that. "Never render it"
    // was the wrong claim; "never render it unguarded" is the right one.
    const code = codeOnly(VIEW)
    const guard = code.indexOf('orderNumber != null ?')
    expect(guard).toBeGreaterThan(-1)
    // jest's expect takes no message argument -- that is Playwright's. The indices carry it.
    const renders = [...code.matchAll(/#\{orderNumber\}/g)].map((m) => m.index ?? -1)
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.filter((i) => i < guard)).toEqual([])
  })

  it('branches on null and falls back to the not-yet-numbered copy', () => {
    const code = codeOnly(VIEW)
    expect(code).toMatch(/orderNumber != null \?/)
    /**
     * STRENGTHENED 2026-08-18. This used to require the constant INLINE here, which is the weaker
     * form of the same rule -- and it is what let the branch be wrong a third time: on a DECLINED
     * order the site said "Not numbered yet", a promise that cannot be kept, because an inlined
     * constant cannot know the order's state. Every site now calls the shared function, which can.
     * A convention cannot be enforced; a function can (#308).
     */
    expect(code).toContain('orderIdentityLabel(')
    expect(code).not.toContain('QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered')
  })

  it('the number is secondary when shown, not the headline', () => {
    // It used to be `text-lg` + `font-bold text-[#16A34A]` directly under "Order Placed!".
    const code = codeOnly(VIEW)
    expect(code).not.toMatch(/font-bold text-\[#16A34A\]">#\{orderNumber\}/)
    expect(code).toMatch(/text-sm text-\[#6B7280\]">\s*\n?\s*Order <span/)
  })

  it('the prop type admits null', () => {
    expect(codeOnly(VIEW)).toMatch(/orderNumber: number \| null/)
  })
})

describe('#296 it is the SAME decision the Tab screen already made', () => {
  it('the Tab screen still uses that predicate and that constant', () => {
    // If the Tab screen ever changes its mind, this test is where the two screens are shown to
    // have been deliberately kept in step -- rather than one drifting quietly.
    // Same strengthening: the Tab screen calls the function too, so the two screens are kept in
    // step by shared CODE rather than by two copies of one decision.
    expect(codeOnly(TAB)).toContain('orderIdentityLabel(')
    expect(codeOnly(TAB)).not.toContain('QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered')
  })

  it('and both read the one copy constant, whose wording is now signed off', () => {
    // Was `toMatch(/tabOrderNotYetNumbered: 'PENDING COPY/)`. Signed off 2026-08-17; what still
    // matters is that ONE constant exists and neither render site inlines its own string.
    expect(COPY).toMatch(/tabOrderNotYetNumbered:\s*['"]/)
    expect(COPY).not.toMatch(/tabOrderNotYetNumbered:\s*['"]PENDING COPY/)
  })

  it('no second not-yet-numbered string was invented', () => {
    // The instruction was to reuse the existing decision. A new constant would be the second
    // answer to one question.
    // Counts DECLARATIONS, not mentions. The old form matched every occurrence including those
    // inside docblocks, so documenting a sibling constant by name broke it — a test that fails
    // when you explain yourself.
    const declarations = COPY.match(/^\s*\w*NotYetNumbered\s*:/gm) ?? []
    expect(declarations.length).toBe(1)
  })
})
