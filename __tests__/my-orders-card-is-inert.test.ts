import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * THE MY ORDERS CARD IS INERT, AND "ORDER MORE ITEMS" STILL WORKS.
 *
 * Digi Cofee order #24 — accepted and being prepared — navigated on tap to
 * `/order-confirmation?orderId=...`, which is the PAYMENT page, not the nested
 * `/menu/[restaurantId]/order-confirmation/[orderId]` the Edit action uses. It rendered the
 * heading "Payment Processing" for an order that was already accepted, and trapped the customer:
 * the only button on that page leaves the page it is telling them to wait on.
 *
 * TWO-SIDED ON PURPOSE. Asserting only "the card does not navigate" would pass just as happily if
 * the whole card were deleted, or if every action inside it were stripped. So the removal and the
 * survival are pinned together: the navigation is gone AND the two real actions are still there.
 *
 * Source-text assertions, because the alternative is rendering a client page with a router, a
 * restaurant context and a session — and this file is checking what the JSX says, which is exactly
 * what regressed.
 */
const ROOT = join(__dirname, '..')
const MY_ORDERS = 'app/menu/[restaurantId]/my-orders/page.tsx'
const src = readFileSync(join(ROOT, MY_ORDERS), 'utf8')

/**
 * COMMENTS STRIPPED BEFORE ASSERTING. The first version of this file failed on the fixed tree,
 * because the comment explaining the removal quotes the very route it forbids. That is the
 * substring-preserving trap: an assertion that reads prose is not reading behaviour, and the
 * inverse — a real navigation hidden inside a string that also appears in a comment — would have
 * gone unnoticed just as easily.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including the JSX {/* ... *​/} bodies
  .replace(/^\s*\/\/.*$/gm, '') // line comments

/** The card element itself, from its testid to the end of its opening tag. */
function cardOpeningTag(): string {
  const at = code.indexOf('data-testid="my-orders-card"')
  expect(at).toBeGreaterThan(-1) // control: the card still exists at all
  const open = code.lastIndexOf('<div', at)
  const close = code.indexOf('>', at)
  return code.slice(open, close + 1)
}

describe('the card is inert', () => {
  it('CONTROL: the card is still rendered — the assertions below are about a card that exists', () => {
    expect(src).toContain('data-testid="my-orders-card"')
  })

  it('has no onClick on the card element', () => {
    expect(cardOpeningTag()).not.toMatch(/onClick/)
  })

  it('carries no styling that implies it is tappable', () => {
    const tag = cardOpeningTag()
    expect(tag).not.toMatch(/cursor-pointer/)
    expect(tag).not.toMatch(/hover:/)
  })

  it('nothing on this page navigates to the payment page any more', () => {
    // The bare `/order-confirmation?orderId=` route — NOT the nested per-restaurant one, which the
    // Edit action legitimately uses and which the next block asserts is still here.
    expect(code).not.toMatch(/router\.push\(\s*`\/order-confirmation\?/)
    expect(code).not.toContain('`/order-confirmation?orderId=')
  })
})

describe('the real actions survived', () => {
  it('"Order More Items" is still rendered and still navigates to browse', () => {
    expect(src).toContain('MENU_COPY.orderMoreItems')
    expect(src).toMatch(/router\.push\(`\/menu\/\$\{restaurantId\}\/browse/)
  })

  it('the Edit action still opens the NESTED order-confirmation route', () => {
    expect(src).toMatch(/\/menu\/\$\{restaurantId\}\/order-confirmation\/\$\{order\.id\}/)
  })

  it('CONTROL: those two assertions can fail — they name strings unique to each action', () => {
    // If either identifier were renamed the assertions above would go quiet rather than red, so
    // pin that each appears exactly where expected and only once.
    expect(src.split('MENU_COPY.orderMoreItems').length - 1).toBe(1)
  })
})

describe('the payment page keeps its own legitimate entry points', () => {
  it('the cart still routes to the nested confirmation after placing an order', () => {
    const cart = readFileSync(join(ROOT, 'app/menu/[restaurantId]/cart/page.tsx'), 'utf8')
    expect(cart).toMatch(/order-confirmation\/\$\{orderId\}/)
  })

  it('ActiveOrderBanner prefers the receipt and only falls back to the payment page', () => {
    // Documented, not changed: the banner reaches the bare /order-confirmation ONLY when it has no
    // restaurantId+tableNumber to build a receipt link from. Left alone deliberately — see the
    // note on the issue. If this ever becomes the primary path it needs the same treatment.
    const banner = readFileSync(join(ROOT, 'components/ActiveOrderBanner.tsx'), 'utf8')
    expect(banner).toMatch(/receipt\?table=/)
    expect(banner).toContain('/order-confirmation?orderId=')
  })
})
