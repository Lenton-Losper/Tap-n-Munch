# One-pass walkthrough — terminal and web together

Everything shipped or built on 2026-08-25, in the order to walk it. Written for a single sitting
with a P5 in hand and a phone for the QR side.

**Living document.** Both agents are still working; sections marked `PENDING` fill in as builds and
promotions land. The order below is the order to walk, not the order things were built.

---

## Before you start

| | |
|---|---|
| Production web | `9edd9517` — verified 60/60 on flashtap.app, www.flashtap.app, riviera.flashtap.app |
| Terminal on TMS | **vc92 / 1.91** unless you have pushed vc95 by the time you read this |
| Terminal ready to push | **vc95 / 1.94** — `releases/production/flashtap-terminal-vc95-1.94-dd87c58.apk`, md5 `db516799a3e277949fc6419e90a22210` |
| Superseded, do not push | vc93, vc94 |

**Two migrations are still unapplied and off main. You run these; nothing below depends on them
except where noted.**

```
supabase/migrations/20260825020000_tabs_revoke_anon_select.sql              #284
supabase/migrations/20260825030000_customer_sessions_drop_last_seen_at.sql  #338
```

For #284: `node scripts/prod/apply-284-revoke-anon-tabs.mjs --sha=<current production sha> --confirm`
It re-checks all three hostnames 20× and refuses unless they are uniformly on that SHA.

---

## 1. Web — the QR customer path

Walk this first. It is the surface most of today's copy changes landed on, and it needs only a
phone.

### 1a. Counter-service copy — the six signed pairs

**Reach it:** open the QR menu for **FNB ChowNow** or **Chownow Nedbank** (both are
`is_counter_service = true` on production), add an item, go to the cart.

Then the same on **Riviera** (table service) and confirm the wording DIFFERS. That contrast is the
whole point — if both venues read the same sentence, `is_counter_service` is doing nothing.

| Surface | Counter venue should say | Riviera should say |
|---|---|---|
| Cart, cash option | pay at the counter when you collect your order | someone will come to your table to take payment |
| Cart, card option | tap your card at the counter when you collect your order | someone will bring a card machine to your table |
| Cart, payment explanation | pay at the counter when you are ready | Staff will assist with payment at your table |
| Tab page, request-bill FAILED | could not reach the counter | Could not notify waiter |
| Tab page, request-bill OK | the counter has been notified. | A waiter has been notified and will assist you shortly. |
| Landing, payment in progress | please ask at the counter for assistance. | Please wait or ask your waiter for assistance. |
| Landing, tab ready to pay | your tab is ready to pay at the counter. | Your tab is ready to pay — your waiter has been notified. |
| Order confirmation, order ready | your order is ready for collection at the counter. | Your order is ready! A staff member will come to your table shortly. |

**Chownow Nedbank additionally has NO card option at all** — it has null Finatic credentials, so
`card_payments_available` is false and the card tile should not render.

### 1b. My Orders card is inert — #325 and the tappable-card fix

**Reach it:** place an order, then open **My Orders**.

- **Tapping the order card must do nothing.** It used to navigate to a page that said "Payment
  Processing" for an order that was already accepted, and trapped you there.
- There should be no hover/press highlight on the card.
- **"Order More Items" must still work.**
- The **TABLE** column must read `—` and not `0` for a POS row. This was affecting 2,143 of 3,501
  production orders.

### 1c. Menu outage banner — #224 / #247

**Reach it:** hard to reach deliberately — it needs a menu load to fail. If you can force it (offline
the device mid-load), confirm that **typing in the search box does not hide the outage banner**, and
that the retry button is present. Previously a searching customer saw only "No items found".

### 1d. Receipt email — #244

**Reach it:** from a paid order's receipt screen, email a receipt to yourself.

- Send it repeatedly. After 10 attempts on one receipt it must refuse with
  **"we could not send this receipt. please ask a member of staff."** and nothing else — no attempt
  count, no provider text.
- Send the same address twice quickly: the second should be deduplicated, and the receipt should
  still arrive.

---

## 2. Web — the staff dashboard

### 2a. Close Table now refuses over an undecided round — #120

**Reach it:** place an order from the QR side but DO NOT accept it on the dashboard, so it sits in
`waiting_review`. Then try to **Close Table** on that table.

- It must **refuse**, naming what is blocking it.
- Before today it closed anyway, and the round then re-inflated a tab that had been paid and closed.

### 2b. The stuck-request escape hatch — #120's residual

**Hard to reach on purpose.** It needs a request stranded in the transient `accepting` claim, which
happens when the accept worker dies mid-claim. If you can produce one, the Close Table refusal
should offer **"Release stuck request"** with the body *"This request is stuck mid-accept. Releasing
it puts it back in the review list so this table can be closed."*

**It must NOT offer that button for a `waiting_review` row** — that is a real round a customer
placed, and dismissing it would be the original bug from the other side.

### 2c. Cash "Ready to Pay" now works — #121

**Reach it:** place a CASH order from the QR side, then press **Ready to Pay** as the customer.

This has never worked. 490 cash orders on production, zero ever flagged — every customer who pressed
it since launch got "Something went wrong". Staff should now see the notification.

---

## 3. Terminal — vc95 / 1.94

**Push vc95 to TMS before this section.** Nothing here is testable until it is on a device.

### 3a. Payment result states — #327 / #326

**Reach it:** take a card payment. The everyday path should be unchanged.

The states that matter are the ones you cannot reach on demand. If you can produce them:

- **NOT CONFIRMED** — the primary action is **"Check payment status"**, and the instruction to NOT
  release the order sits ABOVE both actions. "Take payment again" is secondary and visibly so.
- An **already-paid** order must render as a settled sale, never as a failure with a retry prompt.
- An **interrupted** payment must say the card MAY have been charged — not that it failed.

### 3b. Ready to Pay after a partial settle — #318

**Reach it:** open a tab with several orders, settle SOME of them, then look at the table again.
"Ready to Pay" must still be there. It used to disappear after the first partial settle.

### 3c. The held-orphan notice — #344

**Very hard to reach.** It needs the app to die mid-callback. If you can produce it, the notice sits
ABOVE the order card, is not a modal, and names the voucher.

**The strings here are NOT signed yet** — two are on hold pending a behaviour question. Treat
anything you see as provisional.

---

## 4. What is NOT testable, and why

- **#338's dropped column** — the migration is unapplied. Nothing changes until you run it.
- **#284's revoke** — same. The customer-facing half is already live and unchanged by it; the
  migration only withdraws an anon grant that nothing reads any more.
- **#245's staging half** — blocked on a staging DB credential. Production is verified: four of five
  inline CHECK constraints present, the fifth table does not exist there.

---

## PENDING — fills in as the agents report

- Terminal builds after vc95, with their screens and reach-instructions.
- Web fixes from the current bare-issue batch.
