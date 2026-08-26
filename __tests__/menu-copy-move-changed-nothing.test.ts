import {
  MENU_COPY,
  MENU_COPY_NOT_PROSE,
  MENU_COPY_AWAITING_A_SURFACE,
  MENU_INTERNAL_MESSAGES,
} from '@/lib/customer-copy/menu-copy'

/**
 * #334 STEP 2 — PROVE THE MOVE CHANGED NOTHING.
 *
 * Moving 100+ customer strings out of screens and into a copy module is the kind of refactor where
 * a stray edit is invisible: nothing type-checks differently, nothing fails, and a customer reads
 * slightly different words forever. The ruling was explicit that moving is not rewriting.
 *
 * So every string below is pinned to the EXACT literal it replaced, transcribed from the screen
 * before the move. This suite is not testing that the copy is good — it is testing that it is
 * UNCHANGED. If a value here needs to change, that is a copy decision and it comes with a sign-off,
 * at which point this file is updated deliberately rather than drifting.
 *
 * Written character-by-character on purpose, including the em dashes and the ellipsis, because those
 * are exactly what a well-meaning editor "fixes".
 */
describe('every moved string is byte-identical to the literal it replaced', () => {
  const ORIGINALS: Record<string, string> = {
    // ---- app/menu/[restaurantId]/receipt/page.tsx
    receiptNoActiveOrders: 'No active orders found.',
    receiptUnknownItem: 'Unknown Item',
    // ---- app/menu/[restaurantId]/cart/page.tsx
    // SIGNED REPLACEMENTS, not moves. Pinned to the wording the owner signed 2026-08-24, so a
    // later edit still has to be deliberate.
    cartSessionEndedTitle: 'session ended',
    cartSessionEndedBody: 'scan the QR code at your table to start again.',
    // SIGNED 2026-08-24 — payment copy keyed by service model, replacing the isKiosk switch.
    payCounterCashLabel: 'pay with cash',
    payCounterCashBody: 'pay at the counter when you collect your order',
    payCounterCardLabel: 'pay by card',
    payCounterCardBody: 'tap your card at the counter when you collect your order',
    payTableCashLabel: 'pay with cash',
    payTableCashBody: 'someone will come to your table to take payment',
    payTableCardLabel: 'pay by card',
    payTableCardBody: 'someone will bring a card machine to your table',
    // SIGNED 2026-08-25 — round two of the service-model split. The payTable halves below are the
    // EXISTING strings under new keys; only the payCounter halves are new wording.
    payTableCouldNotNotifyStaff: 'Could not notify waiter',
    payCounterCouldNotNotifyStaff: 'could not reach the counter',
    payTablePleaseAskForAssistance: 'Please wait or ask your waiter for assistance.',
    payCounterPleaseAskForAssistance: 'please ask at the counter for assistance.',
    payTableStaffNotified: 'A waiter has been notified and will assist you shortly.',
    payCounterStaffNotified: 'the counter has been notified.',
    payTableTabReadyToPay: 'Your tab is ready to pay — your waiter has been notified.',
    payCounterTabReadyToPay: 'your tab is ready to pay at the counter.',
    payTableAssistWithPayment: 'Staff will assist with payment at your table',
    payCounterAssistWithPayment: 'pay at the counter when you are ready',
    payTableOrderReady: 'Your order is ready! A staff member will come to your table shortly.',
    payCounterOrderReady: 'your order is ready for collection at the counter.',
    tabClosedTitle: 'tab closed',
    tabClosedTableBody: 'someone is on their way. you cannot add more items.',
    tabClosedCounterBody: 'pay at the counter when you are ready. you cannot add more items.',
    tabCloseFailedTitle: 'could not close your tab',
    tabCloseFailedBody: 'your tab is still open. please ask a member of staff.',

    // ============================================================================================
    // MOVED BY #334, 2026-08-24. Pinned to the literal each one replaced, transcribed from the
    // pre-move files by scripts/build-menu-copy-pins.mjs rather than retyped -- a hand-copied
    // baseline can absorb the very edit it exists to detect.
    //
    // These have NOT been through wording sign-off. They were already live and are pinned as-is, so
    // the next change to any of them has to be deliberate.
    // ============================================================================================
    // ---- browse
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
    // ---- cart
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
    tableRequired: "Table required",
    theseWereAddedDifferentPrices: "These were added at different prices, so we have kept them separate. Each keeps the price you were shown.",
    youNeedTabPlaceOrder: "You need a tab to place an order.",
    yourCartEmpty: "Your cart is empty",
    yourOrder: "Your Order",
    // ---- kiosk
    nameMustLeast2Characters: "Name must be at least 2 characters.",
    pleaseEnterYourNameContinue: "Please enter your name to continue.",
    startOrder: "Start Order",
    tapStartOrderBrowseMenu: "Tap Start Order to browse the menu",
    thisKioskLinkInvalid: "This kiosk link is invalid.",
    thisKioskNotAvailableOrdering: "This kiosk is not available for ordering.",
    thisLinkNotConfiguredAs: "This link is not configured as a kiosk.",
    welcomeEnterYourNameStart: "Welcome! Enter your name to start ordering.",
    // ---- kiosk-success
    downloadReceipt: "Download Receipt",
    enterValidEmailAddress: "Enter a valid email address",
    failedSendReceipt: "Failed to send receipt",
    orderConfirmed: "Order confirmed!",
    orderRequestSent: "Order request sent!",
    thankYou: "Thank you,",
    waitingRestaurantConfirmYourOrder: "Waiting for the restaurant to confirm your order.",
    yourPaymentWasReceived: "Your payment was received.",
    // ---- menu root
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
    // ---- my-orders
    justNow: "Just now",
    loadingYourOrders: "Loading your orders...",
    myOrders: "My Orders",
    noOrdersYet2: "No orders yet",
    orderMoreItems: "Order More Items",
    startByBrowsingMenuPlacing: "Start by browsing the menu and placing your first order",
    // ---- order-confirmation/[orderId]
    backMenu: "Back to Menu",
    orderNotFound: "Order Not Found",
    // SIGNED 2026-08-25 — the ninth pair. One key on two surfaces became a counter/table pair;
    // payCounterNotifiedShortly from the same sign-off IS this string, collapsed in by ruling.
    payTableStaffHasBeenNotified: 'staff have been notified. someone will be with you shortly.',
    payCounterStaffHasBeenNotified: 'the counter has been notified. collect your order when it is ready.',
    // SIGNED 2026-08-25 — #244. One sentence for both failure modes; the code carries the rest.
    receiptCouldNotBeSent: 'we could not send this receipt. please ask a member of staff.',
    // SIGNED 2026-08-25 — the rest of the guest receipt-email route.
    guestEmailInvalid: 'please enter a valid email address',
    guestOrderNotFound: 'we could not find this order.',
    receiptNotReadyUntilPaid: 'the receipt will be ready once this order is paid.',
    somethingWentWrongAskStaff: 'something went wrong. please ask a member of staff.',
    // ---- order-secure
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
    // ---- receipt
    noOrdersYet: "No Orders Yet",
    pleaseScanQrCodeYour: "Please scan the QR code at your table to view your receipt.",
    startOver: "Start over",
    tabTotal: "Tab Total",
    tableNumberRequired: "Table Number Required",
    totalOrders: "Total Orders",
    // ---- session-ended
    pleaseRescanQrCodeYour: "Please rescan the QR code on your table to start a new session and get a fresh token.",
    yourDiningSessionHasEnded: "Your dining session has ended",
    // ---- shared
    browseMenu: "Browse Menu",
    howWouldYouLikePay: "How would you like to pay?",
    loadingTookTooLongPlease: "Loading took too long. Please scan a valid QR code or refresh the page.",
    noItemsFound: "No items found",
    orderFailed: "Order failed",
    orderSummary: "Order Summary",
    pleaseTryAgain: "Please try again.",
    restaurantNotFound: "Restaurant Not Found",
    yourName: "Your name",
    yourSessionHasEndedScan: "Your session has ended. Scan the QR code to start a new order.",
    // ---- tab
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
    // ---- v2
    accessDenied: "Access Denied",
    askPersonWhoCreatedTab: "Ask the person who created the tab for the 4-digit PIN.",
    browseOrderYourOwn: "Browse and order on your own",
    couldNotOpenTab: "Could not open tab",
    couldNotResetPinAsk: "Could not reset the PIN. Ask staff for a new recovery link.",
    createTab: "Create Tab",
    enter4DigitPin: "Enter the 4-digit PIN.",
    enterTabPin: "Enter tab PIN",
    failedCreateTabPleaseTry: "Failed to create tab. Please try again.",
    failedJoinTabPleaseTry: "Failed to join tab. Please try again.",
    getMyNewPin: "Get My New PIN",
    getYourNewTabPin: "Get your new tab PIN",
    gettingYourPin: "Getting your PIN…",
    joinTab: "Join Tab",
    missingRestaurantTableNumber: "Missing restaurant or table number.",
    missingRestaurantTableNumberScan: "Missing restaurant or table number. Scan the table QR code again.",
    noOpenTabFoundJoin: "No open tab found to join.",
    paymentBeingProcessed: "payment is being processed",
    paymentBeingProcessedThisTable: "A payment is being processed for this table.",
    paymentCurrentlyBeingProcessed: "payment is currently being processed",
    paymentCurrentlyBeingProcessedThis: "A payment is currently being processed for this table. Please wait a moment until the\n          payment is completed before joining the tab.",
    paymentProgress: "Payment in progress",
    pleaseEnterYourName: "Please enter your name",
    pleaseScanValidQrCode: "Please scan a valid QR code to access this restaurant menu.",
    pleaseScanValidQrCode2: "Please scan a valid QR code.",
    poweredByFlashtap: "Powered by FlashTap",
    rejoinYourTab: "Rejoin your tab",
    restaurantIdMissingFromUrl: "Restaurant ID is missing from URL",
    shareTabWithEveryoneYour: "Share a tab with everyone at your table",
    shareThisWithYourGroup: "Share this with your group so they can join your tab.",
    staffHaveStartedPinReset: "Staff have started a PIN reset for this table.",
    tabAlreadyOpenThisTable: "A tab is already open for this table",
    thisTableNotAvailableOrdering: "This table is not available for ordering.",
    viewMenu: "View Menu",
    viewMenuOrder: "View Menu & Order",
    viewReceipt: "View Receipt",
    welcomeTo: "Welcome to",
    yourTabPin: "Your tab PIN is",

    // ==============================================================================================
    // #334 ROUND TWO -- components/ and contexts/, the customer-reachable half of the shared tree.
    //
    // Same discipline as round one: transcribed from the component BEFORE the move, em dashes and
    // bullets included. Round one is the reason this matters -- the file that started #334 is
    // `ActiveOrderBanner.tsx`, and it was outside the gate until now.
    // ==============================================================================================

    // ---- components/ActiveOrderBanner.tsx
    bannerOrderReceivedTapWhenReady: "Order received — tap below when ready for card machine",
    bannerOrderReceivedAwaitingPayment: "Order received - Awaiting payment",
    bannerWaiterNotifiedCardMachineOnWay: "Waiter notified — card machine on the way",
    bannerOrderReceivedPayAtCounter: "Order received - Pay at counter",
    bannerOrderAcceptedBeingPrepared: "Order accepted - Being prepared",
    bannerOrderReadyForCollection: "Your order is ready for collection",
    bannerPaymentConfirmedThankYou: "Payment confirmed - Thank you!",
    bannerOrderInProgress: "Order in progress",
    bannerViewReceipt: "View Receipt →",
    // ---- components/menu/cart-item-note.tsx
    noteAddANote: "Add a note",
    noteForThisItem: "Note for this item",
    notePlaceholder: "e.g. no sugar",
    // ---- components/menu/item-detail-modal.tsx
    itemSpecialInstructions: "Special Instructions",
    itemSpecialInstructionsPlaceholder: "Any special requests? (e.g., no onions, extra sauce)",
    itemIncreaseQuantity: "Increase quantity",
    itemAddToCart: "Add to Cart",
    // ---- components/order-edit-panel.tsx
    editCouldNotOpenOrder: "Could not open this order for editing",
    editCouldNotSaveChanges: "Could not save your changes",
    editNotesForTheKitchen: "Notes for the kitchen",
    editSaveChanges: "Save changes",
    // ---- components/ready-to-pay-cash.tsx + components/ready-to-pay-terminal.tsx
    readyToPayButton: "Ready to Pay",
    readyToPayRequestFailed: "Request failed",
    readyToPaySomethingWentWrongTryAgain: "Something went wrong. Please try again.",
    readyToPaySomethingWentWrong: "Something went wrong",
    readyToPayWaiterNotifiedCardMachine: "Waiter has been notified — the card machine is on its way",
    readyToPaySessionNotFound: "Session not found — open this page from the same device you ordered on.",
    // ---- components/receipt/order-confirmation-view.tsx
    confirmOrderPlaced: "Order Placed!",
    confirmHaveYourCardReady: "Please have your card ready. Staff will bring the card machine to your table.",
    confirmStaffWillAssistAtTable: "Staff will assist you with payment at your table.",
    confirmPaymentMethod: "Payment Method",
    confirmPaymentStatus: "Payment Status",
    confirmWaiterWillBringYourBill: "A waiter will bring your bill when your order is ready.",
    confirmTapReadyToPay: "Tap 'Ready to Pay' below when you would like the card machine brought to your table.",
    confirmCompletePaymentSecureLink: "Complete payment using the secure link if you have not already.",
    confirmWaiterNotifiedCardMachineComing: "Waiter has been notified — card machine coming soon.",
    confirmThankYou: "Thank you!",
    confirmWeAppreciateYourSupport: "We appreciate your support",
    confirmSecureFastContactless: "Secure • Fast • Contactless",
    // ---- components/receipt/order-summary.tsx
    summaryServiceFee: "Service Fee",
    // ---- contexts/tab-context.tsx
    tabIncorrectPin: "Incorrect PIN, please try again",
    tabNoOpenTabForThisTable: "No open tab found for this table",
    tabJoinedButNoIdReturned: "Tab was joined but no tab ID was returned",
    tabCreatedButNoIdReturned: "Tab was created but no tab ID was returned",
    tabFailedToNotifyWaiter: "Failed to notify waiter",
  }

  // The union, so wording parked in MENU_COPY_AWAITING_A_SURFACE is pinned exactly as hard as
  // wording a screen renders today. Signed copy must not drift while it waits for a surface.
  const ALL_COPY: Record<string, string> = { ...MENU_COPY, ...MENU_COPY_AWAITING_A_SURFACE }

  it.each(Object.entries(ORIGINALS))('%s is unchanged', (key, original) => {
    expect(ALL_COPY[key]).toBe(original)
  })

  it('the pinned list covers every key in MENU_COPY', () => {
    // Without this, a key added without a pin is silently unprotected — which is the same
    // opt-in-enforcement hole that let a bare literal escape sign-off in the first place.
    expect(Object.keys(ALL_COPY).sort()).toEqual(Object.keys(ORIGINALS).sort())
  })
})

describe('the React invariants are pinned, and stay out of the sign-off surface', () => {
  it('holds the two provider guards, byte-identical', () => {
    expect(MENU_INTERNAL_MESSAGES).toEqual({
      useCartOutsideProvider: 'useCart must be used within a CartProvider',
      useTabOutsideProvider: 'useTab must be used within a TabProvider',
    })
  })

  it('none of them leaks into MENU_COPY', () => {
    // The point of the separate export: the owner's sign-off surface stays customer-only. A
    // developer invariant sitting among wording someone has to read and approve is noise in
    // exactly the place that must not have any.
    const copy = Object.values(MENU_COPY) as string[]
    for (const message of Object.values(MENU_INTERNAL_MESSAGES)) {
      expect(copy).not.toContain(message)
    }
  })
})

describe('the not-prose allowlist stays small and honest', () => {
  it('holds only internal throw messages, never anything a customer reads', () => {
    // These are `throw new Error(...)` fallbacks. customerSafeError maps anything reaching a
    // customer to allowlisted wording, so the thrown text is never rendered.
    expect(MENU_COPY_NOT_PROSE).toEqual([
      'Failed to add to tab',
      'Failed to place order',
      'No order ID returned',
    ])
  })

  it('has no duplicates, so a stale entry cannot hide behind a live one', () => {
    expect(new Set(MENU_COPY_NOT_PROSE).size).toBe(MENU_COPY_NOT_PROSE.length)
  })
})

describe('the service-model split is real, not decorative', () => {
  it('counter copy never promises a person', () => {
    // The whole reason this column exists: a counter-service venue may have no table staff at all.
    for (const k of ['payCounterCashBody', 'payCounterCardBody', 'tabClosedCounterBody'] as const) {
      expect(MENU_COPY[k]).not.toMatch(/someone|staff|waiter/i)
    }
  })

  it('table copy is the only place a person is promised', () => {
    expect(MENU_COPY.payTableCashBody).toMatch(/someone/)
    expect(MENU_COPY.payTableCardBody).toMatch(/someone/)
  })

  it('the two models say different things for the same payment method', () => {
    // If these ever collapse to the same sentence, the column has stopped doing anything.
    expect(MENU_COPY.payCounterCashBody).not.toBe(MENU_COPY.payTableCashBody)
    expect(MENU_COPY.payCounterCardBody).not.toBe(MENU_COPY.payTableCardBody)
    expect(MENU_COPY.tabClosedCounterBody).not.toBe(MENU_COPY.tabClosedTableBody)
  })

  it('the failure body says the tab is still open', () => {
    // After a failure the customer's real question is whether they still owe or can still order.
    // Reads the holding export: this string is signed and pinned, but no screen renders it yet.
    expect(MENU_COPY_AWAITING_A_SURFACE.tabCloseFailedBody).toMatch(/still open/)
  })
})
