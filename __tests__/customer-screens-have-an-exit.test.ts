/**
 * EVERY CUSTOMER SCREEN NEEDS A WAY OUT.
 *
 * Found by click test: `/menu/[id]/tab` is reachable from the browse strip and from the header and
 * had NO exit of its own. The customer could only leave with the browser's back button, which on a
 * phone mid-meal is not a discoverable action.
 *
 * A source scan, because these are client components whose navigation is a `router.push` inside an
 * onClick — reaching it properly needs the router, three contexts and a live Supabase client, and
 * the thing being pinned is "an exit exists at all", which the source states plainly.
 *
 * THE SWEEP IS THE POINT. Fixing the one screen that was reported would leave the others
 * unexamined, and two more turned out to have no exit either — for reasons that are correct in one
 * case and not the other. Both are recorded below rather than silently fixed or silently ignored.
 */
export {} // module scope

const { readFileSync } = require('fs') as typeof import('fs')
const { join } = require('path') as typeof import('path')

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const CUSTOMER = 'app/menu/[restaurantId]'

/** Any control that navigates somewhere, or a documented deliberate absence. */
const hasExit = (src: string) =>
  /router\.push\(|<Link\b|router\.back\(|href=/.test(src)

describe('the Tab screen — the reported dead end', () => {
  const src = read(`${CUSTOMER}/tab/page.tsx`)

  it('has a back control', () => {
    expect(src).toMatch(/data-testid="tab-back-to-menu"/)
  })

  it('names the DESTINATION, not a direction', () => {
    // Ruled: not a bare arrow, not "Back". The screen is reached from more than one place, so
    // "back" is ambiguous about where it goes.
    expect(src).toMatch(/QR_REDESIGN_PENDING_COPY\.tabBackToMenu/)
  })

  it('navigates FORWARD to the menu rather than using history', () => {
    // history can hold a stale confirmation screen or an ended session; router.back() would send
    // the customer somewhere that is no longer valid.
    //
    // ASSERTED AGAINST CODE, NOT COMMENTS. The first version of this matched the docblock that
    // EXPLAINS why router.back() is not used, and failed against a correct implementation — the
    // same way a grep for a defect string matches the comment recording it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toMatch(/router\.push\(`\/menu\/\$\{restaurantId\}\/browse\?table=\$\{tableNumber\}`\)/)
    expect(code).not.toMatch(/router\.back\(\)/)
  })

  it('carries the signed-off label, and names the destination', () => {
    // SIGNED OFF 2026-08-21: 'Back to menu'.
    //
    // This assertion used to require the string still say 'PENDING COPY', as a tripwire so the
    // placeholder could not reach a customer unnoticed. It fired exactly as intended — signing the
    // wording off is what brought us here — so it is retargeted rather than deleted. The job it
    // does now is the same job: nobody changes this label without a human deciding to.
    const copy = read('lib/customer-copy/qr-redesign-copy.ts')
    expect(copy).toMatch(/tabBackToMenu:\s*'Back to menu'/)
    expect(copy).not.toMatch(/tabBackToMenu:\s*'PENDING COPY/)
    // Still the ruling from the commit that added it: name where it goes, not which way.
    expect(copy).not.toMatch(/tabBackToMenu:\s*'Back'/)
  })
})

describe('the sweep — every other customer screen', () => {
  /**
   * `session-ended` and `kiosk-success` are DELIBERATE exceptions and are asserted as such, so that
   * "no exit" stays a decision rather than becoming an oversight nobody rechecks:
   *
   *   session-ended   the whole screen IS the dead end. The session is over; the only real action
   *                   is to rescan the physical QR, which no in-app link can perform.
   *   kiosk-success   a kiosk auto-returns to its own start on a timer. An exit control on an
   *                   unattended device would let a customer wander into the previous order.
   */
  const NEEDS_EXIT = [
    'browse/page.tsx',
    'cart/page.tsx',
    'my-orders/page.tsx',
    'tab/page.tsx',
    'order-confirmation/[orderId]/page.tsx',
    'receipt/page.tsx',
    'order-secure/page.tsx',
    'v2/page.tsx',
    'kiosk/page.tsx',
  ]

  it.each(NEEDS_EXIT)('%s can be left', (rel) => {
    expect(hasExit(read(`${CUSTOMER}/${rel}`))).toBe(true)
  })

  it('session-ended has no in-app exit, deliberately', () => {
    // If this ever gains one, the assertion should be inverted and the reason revisited — not
    // deleted. The point is that the absence is chosen.
    expect(hasExit(read(`${CUSTOMER}/session-ended/page.tsx`))).toBe(false)
  })

  it('kiosk-success has no in-app exit, deliberately', () => {
    expect(hasExit(read(`${CUSTOMER}/kiosk-success/page.tsx`))).toBe(false)
  })
})
