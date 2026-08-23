# The four runtime files — what they change, and what to sign off

The real gap between `main` (`1811b0e`) and `cloudflare-staging` is **four runtime files, from two
commits**. Everything else in the 77-file gap is tests, scripts, docs, migrations and CI.

| commit | files | verdict |
|---|---|---|
| **`d55f3a9`** #303 | `app/api/orders/route.ts`, `lib/customer-copy/customer-safe-error.ts` | **Do not ship while ChowNow trades without reading §1.3 first.** No new copy. |
| **`cd2802e`** Tab exit | `app/menu/[restaurantId]/tab/page.tsx`, `lib/customer-copy/qr-redesign-copy.ts` | Safe. **Blocked only on the copy sign-off below.** |

---

## 1. `d55f3a9` — #303: one mechanism and one message for a tab that is not open

### 1.1 What it changes

`app/api/orders/route.ts` replaces two bespoke refusals with one. Before, a `POST /api/orders`
onto a non-open tab answered **HTTP 400** with either *"This tab is ready to pay — you cannot add
more items."* or *"Tab is not open (status=…)"*. After, any non-open status answers **HTTP 410**
with `{ error: 'Your dining session has ended. Please scan the QR code to start a new order.',
reason: 'tab_not_open' }`.

**The status check itself stays.** The issue's literal option B was to delete it as unreachable; the
commit keeps it, because the one opening is real — a sub-second race where the tab flips to
`ready_to_pay` between token validation and this load. Deleting it would let a racing order land on
a tab being settled.

`lib/customer-copy/customer-safe-error.ts` drops the now-unemitted *"This tab is ready to pay…"*
pattern from the customer-visible allowlist.

### 1.2 No new copy

`'Your dining session has ended. Please scan the QR code to start a new order.'` is **already on
`main`**, byte-identical, in `lib/session-guard.ts:27` and
`app/api/tabs/[tabId]/view/route.ts:118`. Nothing here needs signing off.

### 1.3 The reason to hold it — the 410 is not a message, it is an eviction

This is not in the commit message and it is the thing worth seeing before it ships.

`app/menu/[restaurantId]/cart/page.tsx:342` — **identical on both branches, already in production** —
does this:

```ts
if (response.status === 410) {
  handleSessionExpired(restaurantId)
  return
}
```

and `lib/handle-session-expired.ts` clears `flashtap_session_token`, `flashtap_tab_id`,
`flashtap_table`, **the customer's cart** (`flashtap_cart_${restaurantId}`, `cart`,
`cart_session_id`), then hard-redirects to `/menu/{id}/session-ended`.

So the carefully-worded 410 body is **never rendered on this path**. What the customer gets is a
wiped cart and a "session ended" screen.

**In the race the check exists for, that is a regression:**

| | staff press Ready to Pay mid-order |
|---|---|
| **today, on `main`** | HTTP 400 → toast with *"This tab is ready to pay — you cannot add more items."* Cart intact, customer still on the cart screen, can talk to staff. |
| **after `d55f3a9`** | HTTP 410 → **cart wiped, token deleted, redirected to session-ended.** The customer must rescan the QR and rebuild their order. |

The window is sub-second and the commit's measurement that no *other* caller reaches the branch
looks right. But the race is exactly the case the check was kept for, and in that case the new
behaviour is worse for the customer, not better. At a trading restaurant, "staff pressed Ready to
Pay while I was ordering, so my basket vanished" is a support call.

**My recommendation:** ship the consolidation, but return a status the cart does not treat as
eviction — a 409 with the same `reason: 'tab_not_open'` — or special-case `reason` in the cart's
410 branch so a not-open tab shows a message instead of clearing the basket. Either is a small
change on top. I have not made it; this is yours to rule on.

### 1.4 Click-test for `d55f3a9`

1. Open a tab, add an item, leave the cart populated.
2. Staff: mark the tab **Ready to Pay**.
3. Customer: press Place Order. **Expect the ruled behaviour** — either the cart survives with a
   message, or (if you ship as-is) the cart is emptied and you land on session-ended.
4. Repeat after **Close Table**. Same status, same message, and here eviction *is* correct.
5. Confirm the old sentence *"This tab is ready to pay — you cannot add more items."* appears
   nowhere.

---

## 2. `cd2802e` — the Tab screen had no way out

### 2.1 What it changes

`app/menu/[restaurantId]/tab/page.tsx` gains a back control at the top of the screen —
`data-testid="tab-back-to-menu"`, an `ArrowLeft` icon plus a label. It is a **forward navigation**
to `/menu/{restaurantId}/browse?table={tableNumber}`, deliberately not `router.back()`: the Tab
screen is reachable from more than one place, and history can hold a stale confirmation screen or
an ended session.

`lib/customer-copy/qr-redesign-copy.ts` adds the label to `QR_REDESIGN_PENDING_COPY`.

Purely additive — one button, one copy key, one new test. It cherry-picks onto `main` **clean**.
The "No active tab" empty state already had its own exit and is untouched.

### 2.2 Safe to ship while ChowNow trades

Yes. No API, no data, no money path, no session logic. Worst case is a misplaced button.

### 2.3 THE COPY — this is what needs your signature

Exactly one unsigned string exists in the whole four-file gap. Quoted byte for byte from
`lib/customer-copy/qr-redesign-copy.ts:135`:

```
  tabBackToMenu: 'PENDING COPY - back to the menu',
```

Note it is a plain ASCII hyphen-minus with single spaces — `PENDING COPY - back to the menu` — not
an en dash.

**Every screen it appears on: one.**

| where | file | what the customer sees |
|---|---|---|
| **The Tab screen**, top-left, above the "Table N Tab" heading | `app/menu/[restaurantId]/tab/page.tsx:418` | `←  PENDING COPY - back to the menu` |

That is the only render site. `git grep tabBackToMenu` across `app/`, `components/` and `lib/`
returns the definition and that one usage, nothing else. The Tab screen itself is reached from two
places — the browse tab-strip and the header — so the string is on one screen but arrives by two
routes.

**Suggested wording, for you to accept or replace:** `Back to menu`. It names the destination
rather than a direction, which is the ruling recorded in the commit, and it is short enough not to
wrap next to the arrow on a phone.

### 2.4 One thing to do at the same time as signing off

`__tests__/customer-screens-have-an-exit.test.ts:55` asserts the placeholder is still a placeholder:

```ts
expect(copy).toMatch(/tabBackToMenu:\s*'PENDING COPY/)
```

That is a deliberate tripwire — it fails the moment the copy is signed off, so the string cannot
ship half-done. **Signing off the wording means updating that assertion in the same commit**, to
match the real text. Do not delete the test; change what it asserts.

### 2.5 Click-test for `cd2802e`

1. Scan the QR, place an order, open **Tab** from the browse strip.
2. The control is top-left and reads the signed-off text. Tap it → lands on
   `/menu/{id}/browse?table={n}`, same table, tab intact.
3. Press browser-back from browse — you must **not** land on a stale confirmation or an ended
   session.
4. Open Tab from the **header** instead; the control behaves identically.
5. Empty state: with no active tab, the existing exit still works and there are not two of them.
6. On a narrow phone, the label sits on one line beside the arrow.

---

## 3. Recommended order

1. **Sign off the wording** for `tabBackToMenu`, and I update the string plus the test assertion.
2. **Rule on §1.3** — 410-as-eviction, or a 409 / `reason`-aware cart branch.
3. Ship `cd2802e` first. It is additive, independent, and clean to cherry-pick.
4. Ship `d55f3a9` **as one commit covering both its files.** Splitting them is the one hazard:
   dropping the allowlist entry while the route still emits the old sentence leaves a live refusal
   that no longer matches the customer-safe allowlist. The reverse order is harmless.
5. Neither needs an out-of-hours window. No migration, no schema change, no data written, and
   `git revert` plus a `production-worker.yml` dispatch is a complete rollback.
