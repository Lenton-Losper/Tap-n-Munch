/**
 * PENDING COPY — the cart page's submit control.
 *
 * "Add to Tab" read as bookkeeping: as though the order were being noted against the table
 * rather than sent to the kitchen. It is the only submit control in the app that said "Add" —
 * the kiosk button one branch below has always read "Place Order" — so the two flows disagreed
 * about what the same action was called.
 *
 * The help line exists because renaming the button alone answers "what is this called" and not
 * "what happens when I press it", which is the actual question a customer has at the moment they
 * are looking at a total.
 *
 * Placeholders, marked so they cannot ship unnoticed. Copy is the human's and they are still
 * working on it. Kept in a lib rather than inline so replacing them is one pass over one object,
 * the same shape as EDIT_COPY_PENDING in lib/orders/edit-lock.ts.
 */
export const CART_COPY_PENDING = {
  /** The submit button, replacing "Add to Tab". */
  placeOrderCta: 'PENDING COPY — Place Order',
  /** The same button mid-flight, replacing "Adding…". */
  placeOrderBusy: 'PENDING COPY — Placing order…',
  /** One line under the button saying what pressing it does. */
  placeOrderHelp:
    'PENDING COPY — This sends your order to the kitchen. You can pay for everything together at the end.',
} as const
