/**
 * #334 — customer-facing copy for the screens under `app/menu/**`.
 *
 * THE RULING, 2026-08-24: customer wording lives here, not inline in a screen. The gate scans for
 * prose in those paths and HARD FAILS the build, because a warning gets ignored within a month.
 *
 * WHY THIS EXISTS AT ALL. `'Order sent - waiting for the restaurant to confirm'` sat as a bare
 * literal inside ActiveOrderBanner and never passed sign-off — not because anyone decided to skip
 * it, but because `check-no-pending-copy.mjs` scans for a MARKER, and a string that never carried a
 * marker and never lived in a copy file cannot be found by any gate. Enforcement was opt-in, and
 * the one string that mattered had opted out.
 *
 * MOVING IS NOT REWRITING. Every value here is byte-identical to the literal it replaced. Anything
 * that needs wording work goes in carrying the `PENDING COPY` marker and blocks the production
 * deploy until the owner signs it — that is the existing gate doing its job, not a new obstacle.
 */
export const MENU_COPY = {
  // ---------------------------------------------------------------- receipt
  /** Renders on the receipt screen when a session has nothing live to show. */
  receiptNoActiveOrders: 'No active orders found.',
  /**
   * Fallback for a line whose name did not survive whatever produced it. Rare, and it is a
   * customer-visible fallback rather than a developer placeholder, so it belongs here.
   */
  receiptUnknownItem: 'Unknown Item',

  // ---------------------------------------------------------------- cart
  /**
   * Shown when the cart has no session to place an order against. Signed off 2026-08-24, and it
   * REPLACES wording rather than moving it: the old pair was 'Session error' / 'Please try again.',
   * which named no cause and offered a remedy that cannot work — retrying does not create a
   * session. Matches the wording already signed for my-orders.
   */
  cartSessionEndedTitle: 'session ended',
  cartSessionEndedBody: 'scan the QR code at your table to start again.',

  /**
   * PAYMENT METHOD COPY, keyed by SERVICE MODEL. Signed off by the owner 2026-08-24.
   *
   * These used to switch on `isKiosk` -- a CHANNEL flag, not a service model -- so a
   * counter-service venue ordering at a table was told "Staff will collect cash at your table",
   * promising a person who was never coming. It now derives from `restaurants.is_counter_service`.
   *
   * The distinction each pair carries is WHO MOVES. Counter variants never promise a person,
   * because a counter-service venue may have no table staff at all; "someone" appears only where
   * staff actually come to the table.
   */
  payCounterCashLabel: 'pay with cash',
  payCounterCashBody: 'pay at the counter when you collect your order',
  payCounterCardLabel: 'pay by card',
  payCounterCardBody: 'tap your card at the counter when you collect your order',
  payTableCashLabel: 'pay with cash',
  payTableCashBody: 'someone will come to your table to take payment',
  payTableCardLabel: 'pay by card',
  payTableCardBody: 'someone will bring a card machine to your table',

  /**
   * READY-TO-PAY OUTCOMES. Signed off 2026-08-24.
   *
   * "tab closed" rather than "ready to pay": the customer's concern is that they can no longer add
   * items, and that is what the body says. The failure body states the tab is still OPEN, because
   * after a failure the customer's real question is whether they still owe or can still order.
   */
  tabClosedTitle: 'tab closed',
  tabClosedTableBody: 'someone is on their way. you cannot add more items.',
  tabClosedCounterBody: 'pay at the counter when you are ready. you cannot add more items.',

  // ================================================================================================
  // MOVED FROM app/menu/** BY #334, 2026-08-24. NOT REWRITTEN.
  //
  // Every value below is byte-identical to the literal it replaced, and
  // __tests__/menu-copy-move-changed-nothing.test.ts pins each one to that literal. Keys are slugs
  // of the text itself, so a key cannot be attached to the wrong sentence by construction -- which
  // matters, because a swapped key passes both the gate and the pin test and would be read by
  // customers forever. Two screens showing the same sentence share one key; splitting them is a
  // copy decision, not a refactor.
  //
  // These have NOT been through wording sign-off -- they were already live. Moving them makes them
  // visible to the owner and to the gate, which is the whole point of #334.
  // ================================================================================================

  // ---------------------------------------------------------------- browse
  allMenu: "All Menu",
  createTabOrder: "Create tab to order",
  createTabStartOrdering: "Create a tab to start ordering",
  menuComingSoon: "Menu coming soon!",
  noAppDownloadRequired: "No app download required",
  orderSecondsFromYourTable: "Order in seconds from your table",
  outStock: "Out of stock",
  pleaseAskStaffAssistance: "Please ask staff for assistance.",
  popularPicks: "Popular Picks ⭐",
  searchMenuItems: "Search menu items...",
  searchResults: "Search results",
  thisRestaurantHasntAddedMenu: "This restaurant hasn't added menu items yet.",
  viewAll: "View All →",
  viewAllItems: "View All Items →",

  // ---------------------------------------------------------------- cart
  addSomeItemsGetStarted: "Add some items to get started!",
  anythingKitchenShouldKnowAbout: "Anything the kitchen should know about the whole order?",
  combinedWithMatchingItemYour: "Combined with the matching item in your cart",
  couldNotAddTab: "Could not add to tab",
  createTab2: "Create a Tab",
  failedAddTab: "Failed to add to tab",
  failedPlaceOrder: "Failed to place order",
  keptSeparateDifferentPrices: "Kept separate — different prices",
  keptSeparateMaximumPerItem: "Kept separate — maximum per item",
  largerOrderPleaseAskMember: "For a larger order, please ask a member of staff.",
  noOrderIdReturned: "No order ID returned",
  payNowWithCardOnline: "Pay now with card online",
  paymentMethod: "Payment method",
  placeOrder: "Place Order",
  scanQrCodeYourTable2: "Scan the QR code at your table to place an order.",
  staffWillAssistWithPayment: "Staff will assist with payment at your table",
  tableRequired: "Table required",
  theseWereAddedDifferentPrices: "These were added at different prices, so we have kept them separate. Each keeps the price you were shown.",
  youNeedTabPlaceOrder: "You need a tab to place an order.",
  yourCartEmpty: "Your cart is empty",
  /** Used at 2 sites. */
  yourOrder: "Your Order",

  // ---------------------------------------------------------------- kiosk
  nameMustLeast2Characters: "Name must be at least 2 characters.",
  pleaseEnterYourNameContinue: "Please enter your name to continue.",
  startOrder: "Start Order",
  tapStartOrderBrowseMenu: "Tap Start Order to browse the menu",
  thisKioskLinkInvalid: "This kiosk link is invalid.",
  thisKioskNotAvailableOrdering: "This kiosk is not available for ordering.",
  thisLinkNotConfiguredAs: "This link is not configured as a kiosk.",
  welcomeEnterYourNameStart: "Welcome! Enter your name to start ordering.",

  // ---------------------------------------------------------------- kiosk-success
  downloadReceipt: "Download Receipt",
  enterValidEmailAddress: "Enter a valid email address",
  /** Used at 2 sites. */
  failedSendReceipt: "Failed to send receipt",
  orderConfirmed: "Order confirmed!",
  orderRequestSent: "Order request sent!",
  thankYou: "Thank you,",
  waitingRestaurantConfirmYourOrder: "Waiting for the restaurant to confirm your order.",
  yourPaymentWasReceived: "Your payment was received.",

  // ---------------------------------------------------------------- menu root
  accessRestricted: "Access Restricted",
  failedLoadRestaurantPleaseTry: "Failed to load restaurant. Please try again.",
  goHome: "Go Home",
  goSign: "Go to Sign In",
  invalidMenuUrl: "Invalid Menu URL",
  invalidMenuUrlPleaseScan: "Invalid menu URL. Please scan a valid QR code or use a valid menu link.",
  linkYouFollowedMayInvalid: "The link you followed may be invalid or expired.",
  notProvided: "Not provided",
  noteTableNotVerifiedOrdering: "Note: Table not verified, ordering may be limited.",
  pleaseAskStaffOpenThis: "Please ask staff to open this table.",
  scanQrCodeYourTable: "Scan a QR code at your table to start ordering.",
  thisMenuPageRequiresRestaurant: "This menu page requires a restaurant ID in the URL.",
  thisTableMayNotOpen: "This table may not be open yet. Please ask a staff member to open the table for you.",
  viewFullMenu: "View Full Menu",
  viewMyCurrentReceipt: "📋 View My Current Receipt",
  welcomeOurMenu: "Welcome to our menu",
  yourLocation: "Your Location",

  // ---------------------------------------------------------------- my-orders
  justNow: "Just now",
  loadingYourOrders: "Loading your orders...",
  myOrders: "My Orders",
  noOrdersYet2: "No orders yet",
  orderMoreItems: "Order More Items",
  startByBrowsingMenuPlacing: "Start by browsing the menu and placing your first order",

  // ---------------------------------------------------------------- order-confirmation/[orderId]
  backMenu: "Back to Menu",
  orderNotFound: "Order Not Found",
  staffHasBeenNotifiedThey: "Staff has been notified. They will be with you shortly.",
  yourOrderReadyStaffMember: "Your order is ready! A staff member will come to your table shortly.",

  // ---------------------------------------------------------------- order-secure
  cartEmpty: "Cart is empty",
  continuePayment: "Continue to Payment",
  failedPlaceOrderPleaseTry: "Failed to place order. Please try again.",
  orderWasCreatedButNo: "Order was created but no order ID was returned",
  paymentLinkWasNotReturned: "Payment link was not returned by PayCloud",
  pleaseAddItemsYourCart: "Please add items to your cart before placing an order.",
  pleaseWait: "Please wait.",
  processingYourOrder: "Processing your order...",
  secureCheckout: "Secure Checkout",
  securedByFinatic: "Secured by Finatic",
  sessionError: "Session Error",
  unableCreateSessionPleaseTry: "Unable to create session. Please try again.",

  // ---------------------------------------------------------------- receipt
  noOrdersYet: "No Orders Yet",
  pleaseScanQrCodeYour: "Please scan the QR code at your table to view your receipt.",
  startOver: "Start over",
  tabTotal: "Tab Total",
  tableNumberRequired: "Table Number Required",
  totalOrders: "Total Orders",

  // ---------------------------------------------------------------- session-ended
  pleaseRescanQrCodeYour: "Please rescan the QR code on your table to start a new session and get a fresh token.",
  yourDiningSessionHasEnded: "Your dining session has ended",

  // ---------------------------------------------------------------- shared
  /** Used at 3 sites. */
  browseMenu: "Browse Menu",
  /** Used at 2 sites. */
  howWouldYouLikePay: "How would you like to pay?",
  /** Used at 2 sites. */
  loadingTookTooLongPlease: "Loading took too long. Please scan a valid QR code or refresh the page.",
  /** Used at 2 sites. */
  noItemsFound: "No items found",
  /** Used at 2 sites. */
  orderFailed: "Order failed",
  /** Used at 2 sites. */
  orderSummary: "Order Summary",
  /** Used at 4 sites. */
  pleaseTryAgain: "Please try again.",
  /** Used at 2 sites. */
  restaurantNotFound: "Restaurant Not Found",
  /** Used at 2 sites. */
  yourName: "Your name",
  /** Used at 2 sites. */
  yourSessionHasEndedScan: "Your session has ended. Scan the QR code to start a new order.",

  // ---------------------------------------------------------------- tab
  couldNotNotifyWaiter: "Could not notify waiter",
  couldNotUpdateName: "Could not update name",
  enterYourName: "Enter your name:",
  failedUpdateName: "Failed to update name",
  fullTabRunningTotal: "Full tab running total",
  goStart: "Go to start",
  noActiveTab: "No active tab",
  orderMore: "+ Order More",
  paymentRequested: "✓ Payment Requested",
  reviewYourTabBeforePaying: "Review your tab before paying",
  shareWithYourGroup: "— Share with your group",
  startJoinTabFromTable: "Start or join a tab from the table landing page.",
  waiterHasBeenNotifiedWill: "A waiter has been notified and will assist you shortly.",

  // ---------------------------------------------------------------- v2
  accessDenied: "Access Denied",
  askPersonWhoCreatedTab: "Ask the person who created the tab for the 4-digit PIN.",
  browseOrderYourOwn: "Browse and order on your own",
  couldNotOpenTab: "Could not open tab",
  couldNotResetPinAsk: "Could not reset the PIN. Ask staff for a new recovery link.",
  createTab: "Create Tab",
  enter4DigitPin: "Enter the 4-digit PIN.",
  enterTabPin: "Enter tab PIN",
  failedCreateTabPleaseTry: "Failed to create tab. Please try again.",
  /** Used at 3 sites. */
  failedJoinTabPleaseTry: "Failed to join tab. Please try again.",
  getMyNewPin: "Get My New PIN",
  getYourNewTabPin: "Get your new tab PIN",
  gettingYourPin: "Getting your PIN…",
  /** Used at 2 sites. */
  joinTab: "Join Tab",
  missingRestaurantTableNumber: "Missing restaurant or table number.",
  missingRestaurantTableNumberScan: "Missing restaurant or table number. Scan the table QR code again.",
  /** Used at 2 sites. */
  noOpenTabFoundJoin: "No open tab found to join.",
  paymentBeingProcessed: "payment is being processed",
  paymentBeingProcessedThisTable: "A payment is being processed for this table.",
  paymentCurrentlyBeingProcessed: "payment is currently being processed",
  paymentCurrentlyBeingProcessedThis: "A payment is currently being processed for this table. Please wait a moment until the\n          payment is completed before joining the tab.",
  paymentProgress: "Payment in progress",
  pleaseEnterYourName: "Please enter your name",
  pleaseScanValidQrCode: "Please scan a valid QR code to access this restaurant menu.",
  pleaseScanValidQrCode2: "Please scan a valid QR code.",
  pleaseWaitAskYourWaiter: "Please wait or ask your waiter for assistance.",
  /** Used at 2 sites. */
  poweredByFlashtap: "Powered by FlashTap",
  /** Used at 2 sites. */
  rejoinYourTab: "Rejoin your tab",
  /** Used at 2 sites. */
  restaurantIdMissingFromUrl: "Restaurant ID is missing from URL",
  shareTabWithEveryoneYour: "Share a tab with everyone at your table",
  shareThisWithYourGroup: "Share this with your group so they can join your tab.",
  staffHaveStartedPinReset: "Staff have started a PIN reset for this table.",
  tabAlreadyOpenThisTable: "A tab is already open for this table",
  thisTableNotAvailableOrdering: "This table is not available for ordering.",
  /** Used at 5 sites. */
  viewMenu: "View Menu",
  viewMenuOrder: "View Menu & Order",
  viewReceipt: "View Receipt",
  /** Used at 2 sites. */
  welcomeTo: "Welcome to",
  yourTabPin: "Your tab PIN is",
  yourTabReadyPayYour: "Your tab is ready to pay — your waiter has been notified.",
} as const

/**
 * NOT COPY. Strings inside `app/menu/**` that no human reads as prose, so the gate must not demand
 * they move. Kept SMALL and exact: a stale entry is a failure, the same way the pending-copy gate
 * treats a marker nobody removed.
 *
 * `throw new Error('...')` messages belong here. They are internal invariants — `customerSafeError`
 * maps anything reaching a customer to allowlisted wording, so the thrown text is never rendered.
 */
/**
 * SIGNED, BUT NOTHING RENDERS THEM YET.
 *
 * These two were signed off on 2026-08-24 for a "could not close your tab" failure, and the #334
 * audit found no screen that reads either one. The nearest live branch is the ready-to-pay failure
 * in tab/page.tsx, which says "Could not notify waiter" -- a different sentence about a different
 * action, so pointing these at it would be a rewording nobody asked for.
 *
 * They are held here rather than deleted because the wording is signed and should not have to be
 * signed twice, and separately from MENU_COPY because a key sitting in the live object while no
 * screen renders it is indistinguishable from a key someone forgot to wire -- which is the exact
 * failure #306 shipped. Move one back into MENU_COPY at the moment a surface renders it.
 *
 * __tests__/menu-copy-move-changed-nothing.test.ts pins both, so the wording cannot drift while it
 * waits.
 */
export const MENU_COPY_AWAITING_A_SURFACE = {
  tabCloseFailedTitle: 'could not close your tab',
  tabCloseFailedBody: 'your tab is still open. please ask a member of staff.',
} as const

export const MENU_COPY_NOT_PROSE: readonly string[] = [
  'Failed to add to tab',
  'Failed to place order',
  'No order ID returned',
] as const
