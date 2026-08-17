/**
 * The two customer navigation labels in the browse header and on the cart's empty state.
 *
 * Signed off by the human 2026-08-13/14, so no PENDING COPY marker: the button that leads to the
 * cart is **Cart** (keeping its item-count badge), and the order list gets its own **My Orders**
 * entry beside it.
 *
 * WHY THIS EXISTS AS A CONSTANT. The button labelled "My Orders" pointed at `/cart` and had done
 * for as long as the route existed, while `/menu/[restaurantId]/my-orders` was reachable only by
 * typing the URL — `git grep "my-orders"` returned comments and tests, and no navigation at all.
 * A customer who had just ordered tapped "My Orders", landed on a cart the submit had emptied, and
 * was told "Your cart is empty". The destination was right and the label was wrong. Keeping the
 * two labels together makes it visible that they are two different places.
 */
export const CUSTOMER_NAV_COPY = {
  /** Leads to the cart. Carries the item-count badge. */
  cart: 'Cart',
  /** Leads to the order list — what has already been sent to the kitchen. */
  myOrders: 'My Orders',
} as const
