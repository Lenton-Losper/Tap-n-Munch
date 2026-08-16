# QR redesign — what to click, screen by screen, in order

**Everything below is on STAGING.** `https://flashtap-staging.llosperofficial.workers.dev`.
Nothing went to production; `origin/main` is still `3c6eec9`.

**You need two phones** (or one phone plus a private/incognito window — they must not share
`localStorage`). Phone A is *Lenton*, phone B is *Bob*. A third helps for step 6 but is optional.

**You do NOT need a new terminal APK.** The existing one is correct — see the terminal section of
the handover. If you want to exercise steps 9–11 you need a terminal that can reach staging.

Every string marked **[PENDING COPY]** is a placeholder I was told not to draft. They are listed
in full at the end of the handover; when you read one on screen, that is expected.

---

## 1 — Scan in, and land on a menu that does one job

**Phone A.** Scan the staging QR for a free table (or open
`/menu/{restaurantId}/v2?table=NN`). Enter **Lenton**. Start.

Look at the menu and check four things:

- [ ] **No six-step order tracker anywhere.** The tracker is gone from this screen entirely. It
      used to sit between the tab strip and the food.
- [ ] The header's right side reads **Tab · My Orders · Cart**. There is **no Receipt button**.
      Below ~640px the labels collapse and only the icons show — they must be tellable apart.
- [ ] The dark strip under the header is **two rows**: money on top, `PIN: nnnn · 1 person`
      beneath. It says **[PENDING COPY] View tab →**, *not* "Tap to settle".
- [ ] It does **not** say "Tap to settle" anywhere.

> **What I could not check for you:** whether two icons are legibly distinct at 16px on a real
> screen. jsdom can prove they emit different vector data and nothing more.

---

## 2 — Every item opens the same sheet, and the whole card is the target

- [ ] Tap a menu item **anywhere on the row** — the image, the name, the description. The item
      sheet opens. Previously only the small round **+** worked.
- [ ] Do the same on a **Popular Picks** card at the top. Same behaviour.
- [ ] Tap an item that has **no options at all** (a plain drink). The sheet still opens, showing
      quantity and Add to Cart. It does not silently drop into the cart.
- [ ] If an item has size chips on the card, tap a chip. It changes the selection and **does not**
      open the sheet.
- [ ] Find an **out-of-stock** item. The card should not respond to a tap at all — it is inert,
      not a control that does nothing.

Add two items and go to the Cart.

---

## 3 — Place Order lands on My Orders

- [ ] Press **Place Order**.
- [ ] You land on **My Orders**, not back on the menu, and not on a confirmation page.
- [ ] A green banner reads **[PENDING COPY] ✓ Order sent to the restaurant**. It disappears after
      about 6 seconds.
- [ ] Look at the address bar: the `?placed=1` parameter has been **removed**. Now refresh. The
      banner must **not** come back. Press Back, then Forward — still no banner.

---

## 4 — My Orders is personal, and says nothing false

- [ ] There is **no "Total Spent"** and **no "Total Orders"**. Both are gone.
- [ ] There is **no "Session active since N/A"** line. Just `Table NN`.
- [ ] Your order shows a status word from the new six: *Waiting for the restaurant · Accepted ·
      Being prepared · Ready · Paid · Needs you*. **No "🎉 New" anywhere, ever.**
- [ ] If the tab has unconfirmed money, an amber line names it.

---

## 5 — A second phone, and the shared Tab

**Phone B.** Scan the same table's QR. You should be offered the join flow.

- [ ] Enter the PIN from phone A's strip. Join as **Bob**.
- [ ] Bob's **My Orders is empty.**
- [ ] Bob orders something.

**Now open Tab on BOTH phones.** This is the piece most worth your attention — it did not work
before tonight.

- [ ] **Both phones show both names**, each with their own items and their own figures.
      Previously each phone saw only its own orders under a heading carrying the whole table's
      money.
- [ ] On phone A, the *"You — Lenton"* group has the rename control. **Bob's group does not.**
- [ ] On phone B it is the other way round.
- [ ] Neither phone offers any control that would change the other person's order.
- [ ] Each order is listed separately with its own state, and an unconfirmed one is marked
      **[PENDING COPY] Waiting for the restaurant** in amber.
- [ ] The headline shows the table total; unconfirmed money is named beneath it rather than
      folded in.

**Stay on the Tab screen and do nothing for thirty seconds.** Two defects lived here and both
were found by sitting still, not by clicking.

- [ ] **The screen does not blank.** It refreshes in place. Until 2026-08-16 the whole page was
      replaced by a spinner every 5 seconds, losing your scroll position and any tap in progress
      (#292). Watch the clock, not the content.
- [ ] **Every line price is the price on the menu.** Compare a line against the menu item you
      ordered — they must match to the cent. Until 2026-08-16 lines were shown ex-VAT, so a N$95
      burger read *"NAD82.61"* under a *"NAD95.00"* heading (#293).
- [ ] **The lines add up to the figure printed directly beneath them.** If they do not, stop and
      say so — that is the mixed-basis defect returning, and it is a money figure on a customer's
      screen.

---

## 6 — Four people (optional, but this is the case the redesign is for)

Add a third and fourth phone by PIN.

- [ ] Each My Orders shows only that phone's orders.
- [ ] The Tab shows all four, by name.
- [ ] **The menu is still just a menu** — no accumulation of trackers as rounds go by. This is the
      whole reason the tracker left.

---

## 7 — Changing an order

On phone A, with an order the kitchen has **not** started, press **Change order**.

- [ ] The editor's **first line** is **[PENDING COPY] You can change this order until the
      restaurant starts preparing it.**
- [ ] The countdown is **beneath it, smaller**, reading **[PENDING COPY] Editing reserved for you
      · 2:44** or similar. It must **not** be the only time figure, and it must not read as the
      deadline for changing the order. That was the old *"164s left to make changes"*.
- [ ] Reduce a quantity. Save. You stay on My Orders and the figure updates.
- [ ] **A reduction does not send the order back for re-acceptance.** *(This reverses your
      2026-08-13 ruling — see the handover. It is the single change most worth a second look.)*
- [ ] Press **+** on a line to add one more of it. Save. The total **rises**, and this one **does**
      go back for staff re-acceptance.
- [ ] While phone A has the editor open, try to reach the same order from phone B. Bob has no
      edit control on Lenton's order at all — if you force it, he gets a refusal, not a lock.

### 7b — "+ Add something" (the menu round trip)

Still in the editor:

- [ ] Press **[PENDING COPY] + Add something**. You land on the **menu**, with an amber banner
      reading **[PENDING COPY] Choosing something to add to your order** and a
      **[PENDING COPY] Back to my order** link.
- [ ] Pick an item and add it. You are returned to the order, **the editor reopens by itself**,
      and the item is listed under the lines with an **Undo** beside it.
- [ ] **Check the Cart badge. It must not have changed.** The picked item went to the pending
      edit, not to the cart — this is the whole point of picker mode, and it is the one thing
      that would be silently wrong.
- [ ] Go to the menu again and pick a second item. Both picks survive.
- [ ] Press **Save**. The total rises by the two items' **menu** prices, and the order goes back
      for re-acceptance.
- [ ] Now repeat, but press **Cancel** instead of Save. Reopen the editor — the abandoned picks
      are **gone**, and the editor does not reopen itself.

### 7c — Swapping an item (the case that was impossible until 2026-08-16)

**This step exists because Events A–Q did not.** The spec never asked for a swap, so the
simulation never drove one, and 28/28 stayed green while swapping was completely impossible
(#291). It was found on a phone. Drive it every time.

Start from an order with **exactly one line** — that is the case that broke; a swap on a two-line
order takes a different path through the emptiness check and would have passed throughout.

- [ ] Open the editor on the one-line order.
- [ ] **Remove the only line.** The panel shows it struck through and warns that an order needs at
      least one item. **Save is disabled at this point, and that is correct** — right now the edit
      really would empty the order.
- [ ] Press **[PENDING COPY] + Add something** and pick a different item.
- [ ] You are returned to the order. The removal is still struck through **and** the addition is
      listed beneath it.
- [ ] **The warning is gone and Save is enabled.** This is the whole step. Before the fix the
      warning stayed, Save stayed grey, and the swap could not be completed at all.
- [ ] Press **Save**. It commits. The order now has **one** line — the new item — and the old one
      is gone entirely, not kept at zero quantity.
- [ ] Check the total. It is the **menu** price of the new item, whatever the old one cost.
- [ ] **Re-acceptance follows the total, and nothing else.** Swap *up* in price and the order goes
      back for staff re-acceptance. Swap *down* and it does not. A swap is not special-cased, so
      if a cheaper swap asks for re-acceptance, that is a defect.

Then the negative half, which is the guard this fix must not have removed:

- [ ] Open the editor on a one-line order again. Remove the only line and **add nothing**.
- [ ] Save stays disabled and the warning stays. An edit that really would leave the order empty
      is still refused, and the customer is still told to ask staff to cancel instead.

---

## 8 — The kitchen wins

- [ ] Open the editor on phone A and leave it open.
- [ ] On the staff dashboard, move that order to **Preparing**.
- [ ] Press Save on the phone. You get **"The kitchen has started this order, so it can't be
      changed now."** — no token, lock or status jargon.
- [ ] The **Change order** control is now gone from that order.

---

## 9 — Ready to pay

- [ ] Open **Tab** on phone A. Press **Ready to pay**, choose a preference, confirm.
- [ ] The button charges nothing. It tells staff.
- [ ] The amount on the button is the **payable** figure, never payable-plus-pending.
- [ ] Now open the per-order confirmation screen for an order **on this tab**. It offers **no**
      Ready-to-Pay button — settlement lives on the Tab. *(An order with no tab still has one,
      deliberately; that customer has nowhere else to ask.)*

---

## 10 — Pay one person (terminal) — the event that had never been checked end to end

On the terminal, open this table.

- [ ] **First, look at the order rows' headlines.** They should now show **names**, not "Guest".
      Every row said "Guest" until tonight — the terminal renders `member_name` and nothing ever
      sent it (#288). This is a server fix, so **the existing APK picks it up**; if you still see
      "Guest" on every row, that is the one thing here worth telling me about.
- [ ] Tick **only Lenton's orders** using the checkboxes on the order rows.
- [ ] Charge them.
- [ ] **Back on both phones, open Tab.** The table total has dropped by exactly Lenton's amount,
      Bob's amount is still owed, and **Lenton's orders are still listed** — marked paid, not
      vanished. A partially settled tab still reads as one bill.

---

> **Known, filed, not fixed (#287):** after this first partial settle the table's **"ready to
> pay" chip disappears from the terminal**, even though three people are still waiting to pay.
> Every option that restores it needs a terminal change, so it is a ruling for you rather than a
> fix I could make tonight. Expect it; it is not a regression from this run.

## 11 — Pay the rest, and keep ordering

- [ ] On the terminal, settle the remaining balance.
- [ ] The phones show nothing owed.
- [ ] **The table is still open.** Order another drink from phone B — it works, and a new amount
      appears. Payment is not the end of the visit.

---

## 12 — Staff closes the table

- [ ] Close the table from the staff side.
- [ ] On phone A, try to open Tab or My Orders. You are sent back to the landing.
- [ ] Scan the same QR again as a new customer. You get a **fresh** table visit — none of
      Lenton's or Bob's orders, and none of their money.

---

# What I could not verify for you, and why

| | |
|---|---|
| **Staff Accept** | The Accept route needs a staff session an unattended script cannot honestly mint. Every event that depends on its *result* was verified; the Accept *click* is step 7/8's setup and yours. |
| **Event O** — scanning a second table while a tab is open | A landing-screen decision with no API of its own. Nothing tonight changed it. |
| **Anything about how it looks** | Icon legibility at 16px, whether the two-row strip reads well on a 360px screen, whether the banner is long enough to notice. |
| **A real card** | Steps 10–11 were driven against the real terminal *endpoints* with a genuine terminal JWT, settled as cash. A card on a WiseCashier device is yours. |

# If something looks wrong

The simulation that covers most of this is
`npx tsx scripts/simulate-qr-redesign-events-staging.ts` (needs `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from `.env.test`). It printed **26 checks, 0 FAILS** against the
deployed worker. If a screen disagrees with that, the screen is where the bug is — the harness
seeds and cleans up its own fixture in table range 9200–9599.
