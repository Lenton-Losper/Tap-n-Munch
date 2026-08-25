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
| Terminal ready to push | **vc96 / 1.95** — `releases/production/flashtap-terminal-vc96-1.95-df1a5e2.apk`, md5 `77a9ec58b946a06e92350ccb335f6ac9`. First NATIVE change of the sequence. |
| Superseded, do not push | vc93, vc94, vc95 |

**Two migrations are still unapplied and off main. You run these; nothing below depends on them
except where noted.**

```
supabase/migrations/20260825020000_tabs_revoke_anon_select.sql              #284
supabase/migrations/20260825030000_customer_sessions_drop_last_seen_at.sql  #338
```

For #284: `node scripts/prod/apply-284-revoke-anon-tabs.mjs --sha=<current production sha> --confirm`
It re-checks all three hostnames 20× and refuses unless they are uniformly on that SHA.

---

## 0. HOW TO FORCE THE HARD STATES

Four things below are on states you cannot reach by using the app normally. **Each has a method that
takes under a minute** — if it took longer you would skip it, and it would go untested for weeks.

### A. The menu outage banner (#224 / #247) — desktop Chrome, ~20 seconds

The customer menu is a web page, so test this on a laptop rather than a phone.

1. Open the QR menu for any venue in Chrome.
2. DevTools → **Network** → right-click any request → **Block request URL**.
3. Enter the pattern: `*/api/menu/*/category/*`
4. Reload.

Every category fetch now fails, `failedCount >= requestedCount`, and the notice resolves to
`tone: 'total'`. **Then type into the search box** — the banner must stay. That is the actual test;
before this fix a searching customer saw only "No items found" during a total outage.

Untick the block rule to restore.

### B. Terminal — the NOT CONFIRMED screen (#327) — device on USB, ~30 seconds

This is the state the whole of #327 exists for, and it is reachable deterministically:

```
adb shell am force-stop com.flashtap.pos
```

1. Start a card payment on the terminal and let the reader come up.
2. Run the force-stop while the payment is in progress.
3. Reopen the app and return to that order.

`PaymentStateMachine` restores a saved `PAYMENT_IN_PROGRESS` as **`PAYMENT_UNCONFIRMED`**, carrying
"This payment was interrupted before the result was known. The card may have been charged." It used
to restore as FAILED with "Please retry" — asserting the money did not move, then inviting a second
charge.

Check: the do-not-release instruction sits ABOVE both actions, **"Check payment status"** is the
primary, and **"Take payment again"** is visibly secondary.

### C. Terminal — the held-orphan notice (#344) — same method, narrower window

Same force-stop, but it has to land **after the reader returns and before JS handles the callback**.
That window is short, so expect several attempts — this is the one state where "I tried and could
not" is a fair outcome rather than a defect.

**Use this variant, not the narrow one:** force-stop during the payment as in B, then reopen and go
to a **DIFFERENT order**.
That is the exact sequence the defect needed — and the notice appearing there, rather than the other
order being silently settled, IS the fix.

### D. A stuck "accepting" request (#120's residual) — staging only, ~15 seconds

Do not do this on production. **There is no UI path to this state** — the row must be set directly.
On staging, place an order so a row sits in `waiting_review`, then:

```sql
UPDATE order_requests SET status = 'accepting'
 WHERE id = '<the request id>' AND status = 'waiting_review';
```

That is exactly the state a worker leaves behind when it dies mid-claim. Now try **Close Table** on
that table: it must refuse AND offer **"Release stuck request"**. Releasing puts the row back to
`waiting_review`, and the close then succeeds.

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

**Reach it: section 0A, ~20 seconds in desktop Chrome.**

With the banner showing, **type into the search box**. The banner must STAY, and the retry button
must be present. That is the test — before this fix a searching customer saw only "No items found"
during a total outage, which is an affirmative claim about what the restaurant sells, made when we
do not know.

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

**Reach it: section 0D, ~15 seconds, staging only.** It needs a request stranded in the transient
`accepting` claim — what a worker leaves behind when it dies mid-claim. The Close Table refusal
should then offer **"Release stuck request"** with the body *"This request is stuck mid-accept. Releasing
it puts it back in the review list so this table can be closed."*

**It must NOT offer that button for a `waiting_review` row** — that is a real round a customer
placed, and dismissing it would be the original bug from the other side.

### 2c. Cash "Ready to Pay" now works — #121

**Reach it:** place a CASH order from the QR side, then press **Ready to Pay** as the customer.

This has never worked. 490 cash orders on production, zero ever flagged — every customer who pressed
it since launch got "Something went wrong". Staff should now see the notification.

---

## 3. Terminal — walk vc92's screens, then vc93 → vc96

**Push vc96 to TMS before this section.** vc92 is what is on devices now; vc96 supersedes vc93, vc94
and vc95 and needs no server change.

Ordered so the reachable things come first and the deliberately-hard ones last.

### 3a. #326 — a paid order must read as PAID  *(reachable, ~1 min)*

Pay an order our webhook fallback has ALREADY settled. Expect **"Payment successful"** with
*"This order is already paid. No further payment is needed."*

**Not** FAILED, and **no retry prompt.** Before this, the server verified with Finatic, found the
money, and told the operator the payment had failed.

### 3b. #318 — Ready to Pay survives a partial settle  *(reachable)*

Open a tab with several orders, settle SOME, look at the table again. **"Ready to Pay" must still be
there.** It used to disappear after the first partial settle.

### 3c. #327 — the NOT CONFIRMED screen  *(force it: section 0B, ~30s)*

Expect: **Not confirmed** · the do-not-release instruction ABOVE both actions · **Check payment
status** as the filled primary · **Take payment again** as underlined secondary · and the bottom
**Process Payment** button DISABLED until the secondary is pressed.

That last one matters — without it the biggest, most habitual button on the screen sits below a card
whose primary action is "check", and would still charge a card.

### 3d. #120 — the release button  *(staging only: section 0D)*

Terminal → Tables → a table with `can_close` → **Close Table**. With a row staged in `accepting`,
the close is refused and a modal lists **every** blocking row — but only the `accepting` one shows
**Release stuck request**. Press it; the row returns to `waiting_review` and the table refreshes.

**Walk the negative too:** a `waiting_review` row must appear in that list with **NO button**. That
is the safety property, and it is the half a "does the button work" test cannot see.

### 3e. #344 — the held-orphan notice  *(force it: section 0C)*

Force-stop mid-payment, reopen, and start a payment **on a different order**. The notice appears
above the order card, amber, naming the OTHER order and its voucher.

**The vc95 half:** leave the device online and revisit the Payment screen. The notice **clears
itself** once the server confirms that order settled. That self-clearing is invisible on vc94.

### 3f. vc96's read/hold/clear — the one nobody would find by accident

The observable is what happens on a **SECOND** failure: force-stop again *during* the recovery.

- vc95 and earlier: the orphan is **gone for good.**
- vc96: it is **still there on the next launch.**

This cannot be seen without deliberately crashing twice, which is exactly why it is worth a line on
this list. It is the difference between a card transaction being recoverable and being lost.

---

## 3½. WHAT YOU SHOULD **NOT** SEE

A list of expected strings only lets you confirm what you were told. These are the wrong-state
cases — each one is a defect that shipped, or nearly shipped, this weekend. **Seeing any of them is
a finding.**

### On the customer side

| Must NOT appear | Where | Why it would matter |
|---|---|---|
| **A card option at Chownow Nedbank** | cart | It has null Finatic credentials. `card_payments_available` is a generated column and fails CLOSED — a card tile there means the derivation broke, and a customer would be sent to a reader that cannot take their money. |
| **"someone will come to your table"** — or *waiter*, *staff member*, *at your table* | anywhere at FNB ChowNow or Chownow Nedbank | Both are counter service. Nobody is coming. This is the exact sentence the six signed pairs replaced. |
| **The counter wording at Riviera** | anywhere | The inverse failure, and the one a ChowNow-only test cannot catch. If both venues read the same sentence, the flag is decorative — that is why section 1a is a contrast table. |
| **`PENDING COPY`, `TODO`, or a placeholder** | any customer screen | A gate blocks these from shipping. One on screen means it got past the gate. |
| **A tappable / highlighting order card** | My Orders | It navigated to a page that said "Payment Processing" for an accepted order and trapped you there. |
| **`Table 0`** | Order History, My Orders | 2,143 of 3,501 production orders carry `table_number = 0`. It should read `—`. |
| **An attempt count or provider text** — e.g. "Resend rejected…", "ceiling reached (10)" | receipt-email failure | That route takes NO session token. Anything in the body is readable by anyone holding an order id. |
| **A raw database or provider error** | any customer-facing error | Default-deny: only allowlisted sentences reach a customer. Raw text means something bypassed it. |
| **"No items found" as the ONLY thing on screen** | browse, during a total outage | An affirmative claim about what the restaurant sells, made when we do not know. |

### On the terminal

| Must NOT appear | Where | Why it would matter |
|---|---|---|
| **A paid order rendered as FAILED**, or with a retry prompt | payment result | #326. The server verified with Finatic, FOUND the money, and the operator was told it failed. |
| **"Payment was interrupted. Please retry."** | after an interrupted payment | Asserts the money did not move in the one case where nobody knows, then invites a second charge. |
| **"could not notify the system"** or any message with a dash after a full stop | payment result | The concatenated-fragments defect. Every message is now one complete sentence. |
| **"This order was already paid."** (past tense, bare) | anywhere | The unsigned leftover. The signed sentence is "This order **is** already paid. No further payment is needed." |
| **A missing "Ready to Pay"** after a partial settle | table detail | #318. |
| **"Release stuck request" offered for a `waiting_review` row** | dashboard close refusal | That is a real round a customer placed. Dismissing it is #120's own bug from the other side. |
| **`Checking…` with a single-character ellipsis** | during a status check | Signed as three ASCII dots. A single `…` means a formatter rewrote signed copy. |

### And one structural check

**No screen should offer an action it cannot complete.** The two that were like this: the cash
"Ready to Pay" button (490 orders, zero ever recorded) and the Close Table dialog on a blocked table
(refused, with no way out). If you find a third, that is the more valuable finding than any string
above.

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
