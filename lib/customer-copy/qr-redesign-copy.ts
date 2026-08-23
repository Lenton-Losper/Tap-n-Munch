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
   * Renders: the tab receipt screen and the order-confirmation screen, when a load FAILS.
   *
   * #294. These screens used to answer a failed request with "Your dining session has ended",
   * wiping the token, tab id, table and cart. A request that failed is not a session that ended,
   * so they now say so and offer a retry -- which needs words that did not exist before.
   */
  loadFailedTitle: "Couldn't load this",
  loadFailedBody:
    "Your tab is still open. We couldn't load this right now, but nothing has been lost.",
  loadFailedRetry: 'Try again',

  /**
   * Renders: My Orders, as a temporary banner immediately after Place Order.
   * Replaces the toast the cart used to raise on its way back to the menu.
   */
  orderPlacedBanner: 'Order sent to restaurant',

  /**
   * Renders: the browse tab strip, leading word. Spec section 9 demotes the strip to a
   * lightweight entry point, so the headline is a state word and nothing else.
   */
  stripHeadlineOpen: 'Tab open',
  stripHeadlineReadyToPay: 'Ready for payment',
  stripHeadlineClosed: 'Tab closed',

  /**
   * Renders: the browse tab strip, trailing affordance.
   *
   * It says VIEW, not settle. The old strip said "Tap to settle →" while navigating to a screen
   * that shows the bill; spec section 30 puts the settlement action on the Tab and leaves the
   * strip as navigation.
   */
  stripCta: 'View tab',

  /**
   * Renders: the browse header, the button that opens the shared Tab.
   * New destination — the Tab was previously reachable only by tapping the strip.
   */
  navTab: 'Tab',

  /**
   * Renders: the Tab, when the shared-order read FAILED.
   * There is deliberately no fallback to this device's own orders, so this string is what the
   * customer gets instead. It must not imply the table has no orders.
   */
  tabOrdersUnavailable:
    "Order details couldn't load. The total above is still correct.",

  /** Renders: the Tab, when the table genuinely has no orders yet. */
  tabEmpty: 'No orders yet',

  /** Renders: the Tab, per order, before staff have accepted it and allocated a number. */
  tabOrderNotYetNumbered: 'Not numbered yet',

  /**
   * Shown IN THE PAGE when a customer lands on My Orders with no session — after ending one, or
   * on a link opened in a browser that never scanned. Signed off by the owner 2026-08-23.
   *
   * It replaces a native `alert()`. A customer screen must never fire a browser dialog: it is
   * unstyled, it blocks the page, it says the site's hostname to a diner, and on the QR flow it
   * appears over a screen the customer never chose to open.
   */
  noActiveSessionTitle: 'no active session',
  noActiveSessionBody: 'scan the QR code at your table to start ordering',

  /**
   * SIGNED OFF 2026-08-18. Renders: the order editor, a grey line under a row whose desired
   * quantity exceeds what the order currently holds. `{n}` is the difference.
   *
   * Not PENDING COPY -- the human wrote this one. Section 19 of the editor ruling: once the
   * separate pending-additions list was removed (it double-counted), a row showed one number and
   * a customer could not tell which part of "3x" was already ordered and which was about to be.
   */
  editorPendingAddition: '{n} not yet sent',

  /**
   * SIGNED OFF 2026-08-18. Renders: My Orders, the heading of the collapsed section holding orders
   * are over (declined or cancelled) and older than the freshness window.
   *
   * They are NOT deleted: a customer who was declined and sees nothing has no idea what
   * happened. They are moved out of the live list, which answers "what is happening with my
   * food now".
   */
  myOrdersEarlierSection: 'Earlier',

  /**
   * Renders: My Orders, replacing the "No orders yet" empty state when the customer's dining
   * session has been ended by staff closing the table (#313).
   *
   * WHY IT EXISTS. Their phone keeps its session id across a close -- nothing clears it -- so the
   * list correctly shows nothing and they are told nothing about why. An unexplained empty screen
   * is indistinguishable from a lost order, and the second reading sends someone to staff with a
   * complaint that is not real.
   *
   * WHAT IT MUST NOT SAY. Not that anything was deleted or cancelled: every order still exists,
   * for staff and on the settled tab, and several may have been paid. Not that the customer did
   * anything wrong. The action is a rescan, because the table's QR code is what starts the next
   * session.
   *
   * The body must survive being read by someone who has just paid and now sees an empty screen.
   *
   * SIGNED OFF 2026-08-18. The wording is the human's, verbatim. Note what it does NOT say: it
   * never uses "session", "ended" or "expired" -- "This table has been cleared" is a thing STAFF
   * did, not a thing that happened to the customer or that they caused. And the money sentence
   * comes before the instruction, because the reader may have just paid.
   */
  sessionEndedTitle: 'This table has been cleared',
  sessionEndedBody:
    'Your orders are all still on record with the restaurant, and anything you paid for has been ' +
    'paid. To order again, scan the QR code on your table.',
  sessionEndedAction: 'Scan to start again',
  /** Renders: the Tab, per order, on a submitted-but-unanswered order. */
  tabOrderAwaitingConfirmation: 'Waiting for restaurant',

  /** Renders: the Tab, the per-person figure that is actually owed. */
  tabMemberPayable: 'Owed now',

  /**
   * Renders: the Tab, heading of the block for orders on this tab whose member could not be
   * resolved. It must NOT invent an owner, and it must not read as an error the customer caused.
   */
  tabUnattributedHeading: 'Not matched to anyone',

  /**
   * Renders: the menu, when the customer arrived from the order editor via "+ Add something".
   * The menu is otherwise identical, and the one thing that differs — where an added item goes —
   * is invisible until it happens, so it has to be said.
   */
  pickerBanner: 'Choose something to add to this order',
  /** Renders: beside the banner above. A way back that does not require trusting the Back button. */
  /**
   * SIGNED OFF 2026-08-18. Customer: refused because the RESULTING quantity of one logical item would
   * exceed the ceiling (#307). It must state BOTH the maximum and how many more they may add,
   * per the ruling - a refusal that only says no leaves the customer guessing at the number.
   *
   * {item} {maximum} {remaining} are substituted at the render site by plain .replace() and must
   * stay literal. {remaining} can be 0, and the wording has to read correctly when it is.
   */
  quantityCapReached:
    'You can order up to {maximum} {item}. You can add {remaining} more.',
  pickerBack: 'Back to order',
} as const

/**
 * How long the post-order banner stays on screen.
 *
 * Not a copy string, but it belongs beside the banner it governs: a value chosen at the render
 * site is a value nobody can find later.
 */
/**
 * How long the no-session notice is held before redirecting. Long enough to read a two-line
 * message, short enough not to feel like a stall. The redirect is not optional — the notice
 * explains it rather than replacing it.
 */
export const NO_SESSION_NOTICE_MS = 2600

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
