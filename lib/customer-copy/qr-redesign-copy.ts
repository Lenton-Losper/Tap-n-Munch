/**
 * Every customer-facing string introduced by the QR customer redesign, in one place.
 *
 * All of it is PLACEHOLDER. The human's standing instruction for this build is: ship
 * `PENDING COPY` markers rather than stopping for wording, and list them all at the end. Keeping
 * them in one module means the list is a grep rather than a memory:
 *
 *     git grep "PENDING COPY" -- lib/customer-copy/qr-redesign-copy.ts
 *
 * DO NOT draft final wording here. Anything that changes what a customer is told about money is
 * the human's ruling (operating contract, POLICY BOUNDARY), and several of these strings do.
 *
 * Strings that were already signed off live elsewhere and are deliberately NOT copied in:
 * `CUSTOMER_NAV_COPY` (lib/customer-nav-copy.ts), `EDIT_COPY` (lib/orders/edit-lock.ts),
 * `TAB_FIGURES_COPY` (lib/tabs/tab-outstanding.ts).
 *
 * ENCODING NOTE, earned here. The marker below uses an em-dash. A probe that round-tripped this
 * file through PowerShell 5.1 (`Get-Content -Raw` / `Set-Content -Encoding utf8`) rewrote it as
 * mojibake and added a BOM, because 5.1 reads a BOM-less UTF-8 file as Windows-1252. The
 * PENDING-COPY assertion in the suite is what caught it. Edit this file with a UTF-8-aware tool.
 */
export const QR_REDESIGN_PENDING_COPY = {
  /**
   * Renders: My Orders, as a temporary banner immediately after Place Order.
   * Replaces the toast the cart used to raise on its way back to the menu.
   */
  orderPlacedBanner: 'PENDING COPY — Order sent to the restaurant',

  /**
   * Renders: the browse tab strip, leading word. Spec section 9 demotes the strip to a
   * lightweight entry point, so the headline is a state word and nothing else.
   */
  stripHeadlineOpen: 'PENDING COPY — Table tab',
  stripHeadlineReadyToPay: 'PENDING COPY — Ready to pay',
  stripHeadlineClosed: 'PENDING COPY — Tab closed',

  /**
   * Renders: the browse tab strip, trailing affordance.
   *
   * It says VIEW, not settle. The old strip said "Tap to settle →" while navigating to a screen
   * that shows the bill; spec section 30 puts the settlement action on the Tab and leaves the
   * strip as navigation.
   */
  stripCta: 'PENDING COPY — View tab →',

  /**
   * Renders: the browse header, the button that opens the shared Tab.
   * New destination — the Tab was previously reachable only by tapping the strip.
   */
  navTab: 'PENDING COPY — Tab',
} as const

/**
 * How long the post-order banner stays on screen.
 *
 * Not a copy string, but it belongs beside the banner it governs: a value chosen at the render
 * site is a value nobody can find later.
 */
export const ORDER_PLACED_BANNER_MS = 6000

/** The query parameter the cart sets on its way to My Orders. */
export const ORDER_PLACED_PARAM = 'placed'

/**
 * Whether My Orders should raise the "order sent" banner.
 *
 * A function rather than an inline `=== '1'` because two things read it — the banner and the
 * URL cleanup that follows — and because a test can bind to it. `URLSearchParams.get` returns
 * `null` for an absent parameter and `''` for a bare `?placed`, and neither should show a banner
 * to a customer who merely opened the screen from the header.
 */
export function shouldShowOrderPlacedBanner(placedParam: string | null | undefined): boolean {
  return placedParam === '1'
}
