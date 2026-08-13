/**
 * The cart page's submit control. APPROVED COPY — signed off by the human 2026-08-13.
 *
 * Was `CART_COPY_PENDING` in `cart-copy-pending.ts` for exactly one deploy. Renamed on sign-off
 * rather than left as-is: a constant named `_PENDING` holding approved strings is the same class
 * of stale signal as a comment describing a resolved question as open. The placeholder marker is
 * deliberately absent from this file so that grepping for it returns only what is genuinely still
 * open — the 17 strings in lib/orders/edit-lock.ts and the two in
 * lib/orders/calculate-order-pricing.ts.
 *
 * "Add to Tab" read as bookkeeping — as though the order were being noted against the table
 * rather than sent to the kitchen. It was also the only submit control in the app that said
 * "Add": the kiosk branch immediately below it has always read "Place Order", so the two flows
 * disagreed about the name of the same action.
 *
 * The help line is the other half. Renaming the button answers "what is this called" and not
 * "what happens when I press it", which is the question a customer actually has at the moment
 * they are looking at a total.
 */
export const CART_COPY = {
  /** The submit button, replacing "Add to Tab". */
  placeOrderCta: 'Place Order',
  /** The same button mid-flight, replacing "Adding…". */
  placeOrderBusy: 'Placing order…',
  /** One line under the button saying what pressing it does. */
  placeOrderHelp:
    'This sends your order to the kitchen. You can pay for everything together at the end.',
} as const
