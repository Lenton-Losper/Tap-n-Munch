# Copy sheet — 2026-08-17

**30 strings to write.** Grouped by screen, because you are writing these in front of the screens.

`git grep "PENDING COPY"` returns **42 occurrences across 6 files**. Twelve of those are prose in
docblocks; **30 are renderable string literals**, and those are the rows below. Two of the six files
(`customer-nav-copy.ts`, `payment-method-withdrawn.ts`) contain only the marker in a comment
explaining why their strings are *not* pending — nothing in them needs writing.

**The existing placeholder wording is deliberately not reproduced here.** It is my text, not a
proposal, and putting it in a column next to yours would anchor you to it. It is in the repo if you
want to see what is on screen today.

**How the keys work:** signed-off copy replaces the *value*, never the key. A `{placeholder}` is
substituted at the render site by plain `.replace()`, so it must survive verbatim, spelling and
braces intact. Anything in "Must not" is a constraint measured from the code, not a style note.

**Section F is money.** Those five change what a customer or a staff member is told about a figure
they are about to be charged or to collect. Write them last.

---

## A. The seven status words — write these first

`lib/orders/customer-status.ts` · `CUSTOMER_STATUS_COPY`

These render on **every** customer surface: My Orders, the shared Tab, the order-status tracker,
the confirmation screen. They set the voice everything else has to match. There are exactly seven
and the set is closed — `CUSTOMER_ORDER_STATES` is the type.

Every real order status is normalised into one of these first (`normalizeOrderStatusForDisplay`),
so one word can cover several underlying states. The mapping is what makes some of them awkward.

| # | key | Customer sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| A1 | `waiting` | Order submitted, restaurant has not answered. Covers `waiting_review` and `pending`. | That submission has happened and a response has not. | Imply it is accepted or being cooked. | |
| A2 | `accepted` | Restaurant has accepted it. Covers `accepted` and the terminal's `confirmed`. | That the restaurant has agreed to it, and that cooking has not begun. | Imply preparation started. | |
| A3 | `preparing` | Kitchen has started. **Also the point editing closes forever.** | That work on the food has begun. | Imply it can still be changed — from here it cannot, permanently. | |
| A4 | `ready` | Ready for collection or service. | That it is available to them now. | Imply it is paid for, or that the visit is over. | |
| A5 | `paid` | `completed`. | That the order is settled and finished. | Imply food is still to come. | |
| A6 | `needs_you` | **Four different states**: `ready_for_terminal`, `cancelled`, `declined`, `failed`. The customer must act with staff. | That their attention is required, in person. | Distinguish which of the four, or attribute fault — one word covers a cancellation, a decline and a failed card. | |
| A7 | `unknown` | Any status not in the other six, including any added later. | That the restaurant is dealing with it, while **committing to nothing** about what happens next. | Read as new, or as an error. This key replaced a fallback that rendered every unmapped status as a brand-new order. | |

> **Why A7 matters more than it looks.** `my-orders/page.tsx` used to fall back to the *pending*
> config, so any unmapped status rendered as "🎉 New" — a `ready_for_terminal` order read as a
> brand-new one. This key is the replacement for that fallback. Anything it promises, it promises
> about a state nobody has enumerated.

---

## B. The shared Tab

`lib/customer-copy/qr-redesign-copy.ts` · the screen at `/menu/[restaurantId]/tab`

| # | key | Customer sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| B1 | `tabEmpty` | The table genuinely has no orders yet. | Nothing ordered on this table so far. | Read as a failure. | |
| B2 | `tabOrderNotYetNumbered` | Per order, before staff accept it and allocate an order number. | This order exists but has no number yet. | Invent a number, or read as "#0" (that was #296). | |
| B3 | `tabOrderAwaitingConfirmation` | Per order, submitted and unanswered. | Sent, waiting on the restaurant. | Contradict A1 — same underlying state, different surface. | |
| B4 | `tabUnattributedHeading` | Heading over orders on this tab whose member could not be resolved. | These belong to the table. | **Invent an owner**, or read as an error the customer caused. | |
| B5 | `navTab` | The browse header button that opens the Tab. New destination — previously only reachable by tapping the strip. | Where it goes. | Suggest settling; that lives on the Tab itself. | |

---

## C. The browse tab strip

`lib/customer-copy/qr-redesign-copy.ts` · the strip across the top of the menu

Spec §9 demotes the strip to a lightweight entry point, and §30 moves the settlement action onto
the Tab. So the headline is a **state word and nothing else**, and the affordance says *view*.

| # | key | Customer sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| C1 | `stripHeadlineOpen` | Tab is open. Leading word on the strip. | The state, in as few words as possible. | Carry an instruction. | |
| C2 | `stripHeadlineReadyToPay` | Tab has been marked ready to pay. | The state. | Imply payment is complete. | |
| C3 | `stripHeadlineClosed` | Tab is closed. | The state. | Imply the customer must do something. | |
| C4 | `stripCta` | Trailing affordance on the strip, every state. | It **navigates**. | Say *settle* or *pay*. The old strip said "Tap to settle →" and went to a screen that only displays the bill. | |

---

## D. The order editor

`lib/orders/edit-lock.ts` · `EDIT_COPY` · the edit panel on My Orders / the Tab

The editor has **two different time concepts** and conflating them was a real defect. The deadline
is event-driven (until the kitchen starts) and unknowable in advance; the hold is a 3-minute
concurrency lock. D1 is the rule; D2 is the lock.

| # | key | Customer sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| D1 | `editDeadline` | **Primary** line, whenever the editor is open. | The rule that actually governs: changeable until the restaurant starts preparing. | Give a time or a countdown. There isn't one — it could be seconds or twenty minutes. | |
| D2 | `holdSecondary` | **Secondary**, beneath D1. | This is a hold so two phones at one table cannot edit at once. | Read as a deadline for their food. **`{seconds}` must stay literal** — substituted by `.replace()` at the render site. | |
| D3 | `addSomething` | The control that opens the menu in picker mode from inside an edit. | It opens the menu and comes back. | Read as a new order. | |
| D4 | `addOneMore` | Per line, on a line already on the order. | One more of this exact line. | — | |

The superseded string `lockHeld` (`{seconds}s left to make changes`) is the one that conflated the
two. It renders nowhere now and is kept only so the reason survives with it. **Nothing to write.**

---

## E. Failure and transitional states

`lib/customer-copy/qr-redesign-copy.ts`

| # | key | Customer sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| E1 | `loadFailedTitle` | Tab receipt or order-confirmation screen, when a load **fails**. | A request failed. | Imply the session or the tab has ended — these screens used to say "Your dining session has ended" and wipe the token, tab, table and cart (#294). | |
| E2 | `loadFailedBody` | Beneath E1. | The tab is still open; this is our problem, not their order's. | Suggest they lost anything. | |
| E3 | `loadFailedRetry` | The retry control beside E1/E2. | It retries. | — | |
| E4 | `orderPlacedBanner` | My Orders, briefly, immediately after Place Order. Replaces the toast the cart used to raise. | The order reached the restaurant. | Imply acceptance — that is A2. | |
| E5 | `pickerBanner` | The menu, when arrived from the editor via `+ Add something`. | Anything chosen now joins the order being edited. The menu looks otherwise identical, and the difference is invisible until it happens. | Read as a normal browse. | |
| E6 | `pickerBack` | Beside E5. | A way back to the order that does not require trusting the Back button. | — | |

---

## F. MONEY — write these last, and most carefully 💰

Each of these changes what someone is told about a figure they are about to be charged, or to
collect. The docblocks flag all five.

| # | key · file | Who sees it when | Must communicate | Must not | Your wording |
| --- | --- | --- | --- | --- | --- |
| F1 | `tabMemberPayable` · qr-redesign-copy | The Tab, labelling the per-person figure **that is actually owed**. | This is the amount payable now. | Be confusable with the pending figure beside it. The Tab shows **two** numbers per person — payable and pending — and this labels the one settlement would charge. | |
| F2 | `tabOrdersUnavailable` · qr-redesign-copy | The Tab, when the shared-order read **failed**. There is deliberately no fallback to this device's own orders, so this is all the customer gets. | The list failed to load **and the total above is still correct**. | **Imply the table has no orders.** That is B1's job, and confusing the two tells a customer with a N$400 bill that they owe nothing. | |
| F3 | `unpaidTabElsewherePendingSuffix` · tab-flag-copy | **STAFF only**, on an order card, appended *inside* `{total}` when the other table also has money the restaurant has not answered (#286). | The figure before it is **payable**; this part is submitted-and-unanswered. | Read as an accusation, or as a total. A staff member reading only the payable figure walks to a table believing it owes N$95 when the diners have also ordered N$132 the kitchen has not seen. **Never shown to a customer** — that is a ruling, not an implementation detail. | |
| F4 | `alreadySaved` · edit-lock | The editor, when the customer retries after a **lost response** and their change had already landed — a dropped request on mobile data is the ordinary way here. Shown with the current order beside it. | Their change **was** saved, and this is the order as it stands. | Reuse the lock-expired voice. Telling someone nothing was saved when it was is what made them re-apply the change and be charged twice (#306). | |
| F5 | `stripHeadlineReadyToPay` · qr-redesign-copy | The strip, once the tab is marked ready to pay. *(Also C2 — listed twice on purpose.)* | The state only. | Imply payment has been taken, or that the customer still owes an action. | |

---

## G. Signed-off strings now doing a job they were not written for

**Nothing here is for rewriting.** These carry no `PENDING COPY` marker because a human approved
them — but the redesign moved them, or changed when they fire, or changed what flows through their
placeholder. Worth reading in place before launch, since approval was given against a different
context.

| string · file | Approved | What changed underneath it |
| --- | --- | --- |
| `EDIT_COPY.lockExpired` | pre-#306 | It used to be the **only** answer to a lost lock. Since #306 it shares that surface with `alreadySaved` (F4) and now fires *only* when nothing was saved. Its wording is now load-bearing in a way it was not: it is the honest half of a pair, and F4 must not sound like it. |
| `EDIT_COPY.committedTotalChanged` | pre-redesign | Carries `{total}` and now fires after an edit that can **add** items, not only remove them. Approved when an edit could only reduce. |
| `TAB_FLAG_COPY.unpaidTabElsewhere` | 2026-08-15 | `{total}` now receives a **compound** value — the payable figure plus F3's suffix. The signed string was approved when `{total}` was a single number. |
| `CUSTOMER_NAV_COPY.cart` / `.myOrders` | 2026-08-13/14 | Approved as a pair to fix a label pointing at the wrong route. The redesign then moved the nav into the browse header and added `navTab` (B5) beside them, so three labels now sit together where two were approved. |
| `CART_COPY.placeOrderCta` / `.placeOrderBusy` | 2026-08-13 | "Place Order" now lands the customer on **My Orders** with `orderPlacedBanner` (E4) rather than returning to the menu with a toast. The button was approved for the old destination. |
| `EDIT_COPY.cannotEmpty` | pre-#291 | Now also fires on a **swap** attempt that leaves nothing kept and nothing added. Approved when the only way to reach it was deleting every line. |
| `CUSTOMER_STATUS_COPY.needs_you` (A6) | — | Not signed off, but flagged for the same reason: it is one word for four states, and it replaced a per-state vocabulary. Whatever it says is said about a cancellation and a failed card equally. |
