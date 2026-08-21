# Incident 2026-08-21 — FNB ChowNow terminal, first trading session

**Read-only investigation. Nothing was changed. No money needed correcting.**

All times local (UTC+2). Production DB read with the service-role key; Finatic queried live with
FNB ChowNow's own merchant credentials.

---

## Headline

**The card cleared, the order is correct, and the terminal lied about it.** #851 was settled by the
webhook-signature fallback at 07:14:37 — 3 minutes 41 seconds *before* the terminal displayed
"FAILED". Nothing needs fixing in the data.

**One thing is genuinely wrong, and it is not the one that was suspected:**

**Chownow Nedbank has no Finatic credentials.** It has not opened yet — its devices were handed
over on 2026-08-20 and have not been used — so nothing is broken today. The moment it takes its
first card, the recovery path that saved #851 cannot run at all. See §3.

> **Correction, 2026-08-21.** An earlier version of this document concluded that terminal
> `ft-2aceb31b` was mis-paired and that Nedbank trade was being booked against FNB ChowNow. **That
> was wrong.** The terminal is at FNB ChowNow, and orders #850–#858 are real FNB ChowNow trade,
> correctly attributed. Chownow Nedbank has zero orders because it has not opened, not because its
> sales are landing elsewhere. The error came from assuming the incident happened at Nedbank and
> reading the zero-order count as displacement rather than as a venue that has not started trading.

---

## 1. What corrected #851 — the fallback, working exactly as designed

Order `058c53b9-9232-4265-bf95-772b4bd106d2`, order number **851**, N$51.00.

The order has exactly **two** audit rows. There is no third actor.

| time (local) | action | detail |
|---|---|---|
| 07:14:18.585 | `payment.attempt_started` | terminal `2aceb31b`, app v1.89, `businessOrderNo FT17872892573153650`, source `terminal_app` |
| 07:14:37.566 | `payment.completed` | `path: fallback_verified_paid`, `source: paycloud_webhook_fallback_finatic_verified` |

The `payment.completed` metadata carries the whole answer:

```
signatureFailureReason  Encryption block is invalid.      <- #107, the known webhook rejection
finaticStatus           2                                  <- Finatic says PAID
finaticAmount           51
finaticTransactionId    08210514374337928720
amount                  51
amountMeaning           order_total                        <- amount gate satisfied
```

`orders.paid_at` = `orders.completed_at` = **07:14:37.126**.

**So: the PayCloud webhook arrived, its signature failed to verify, and
`app/api/webhooks/paycloud/route.ts` took the `fallback_verified_paid` branch — it called
`queryFinaticOrderPaid` with the restaurant's real credentials, Finatic answered paid for the
matching amount, and it settled the order through `markOrdersPaidConfirmedByIds`** — the shared
helper, so atomic claim and audit log, not a hand-written status update.

**Not a retry. Not an auto-reconcile sweep. Not a human.** This is the designed recovery for #107,
firing in under 19 seconds.

### Re-verified independently, just now

Not taken from our own records, since our records were the thing under suspicion.
`queryFinaticOrderPaid` called live with FNB ChowNow's merchant credentials
(`342600131153` / `4426015803`):

| order | merchantOrderNo | Finatic |
|---|---|---|
| **#851** | `FT17872892573153650` | **PAID**, `trans_status 2`, amount **51**, txn `08210550236458703100` |

**The order is correct as it stands. Nothing to correct.**

### What the terminal was actually showing

The terminal's notify arrived *after* the fallback had already settled the order, so our API
answered "already paid". The terminal maps any non-OK response to **FAILED**, and appends
"Contact support before retrying" — on a paid order. Filed as **#326**, together with the
concatenation bug.

### Is the notify gap still open for the next new venue? **Yes — and it is not the notify step**

The entire recovery hangs on one line inside the fallback:

```ts
const creds = await getRestaurantFinaticCredentials(restaurantId)   // throws if unconfigured
```

Production `restaurants` rows:

| restaurant | finatic_merchant_no | finatic_store_no | |
|---|---|---|---|
| Riviera | 342600171063 | 4426017125 | CONFIGURED |
| FNB ChowNow | 342600131153 | 4426015803 | CONFIGURED |
| Mingle Brew & Pour | 342600160494 | 4426016800 | CONFIGURED |
| **Chownow Nedbank** | **NULL** | **NULL** | **MISSING** |
| bob's, Digi Cofee, + 5 test rows | NULL | NULL | MISSING |

**Because the webhook signature fails on ~100% of live traffic (#107), the fallback is not a
fallback any more — it is the primary settlement path.** A venue without Finatic credentials has
*no* settlement path: the signature check fails, the fallback throws on credentials, and the order
stays unpaid with the money taken.

Chownow Nedbank has not taken a card yet, so nothing has been lost. It is a pre-launch gap, not a
live one — but it becomes live on its first sale. §3 is what to do about it.

## 2. #850 and #854 — no card was debited for either

| order | placed | total | status | merchantOrderNo | Finatic says |
|---|---|---|---|---|---|
| **#850** | 07:01:30 | N$18 | cancelled `terminal_cancelled_by_user_pre_gateway` | `FT17872884951277543` | **E04111 — "Merchant order number is invalid"** |
| **#854** | 07:39:19 | N$20 | cancelled `auto_timeout` | **NULL** | nothing to query |

**#850 — not debited.** `E04111` means no payment order exists at Finatic under that number, which
is exactly what an operator abort before the reader reaches the gateway produces. The terminal's
own claim was `WiseCashier K026` — operator cancel — and the audit note records that Finatic was
*deliberately* not queried at the time. Queried now, Finatic agrees: nothing was ever created.

**The E04111 is a real "not found", not a broken query.** Positive control: #851 and #855 were
queried in the same run, with the same credentials, and both resolved and read PAID. A credentials
or transport problem would have failed all three.

**#854 — not debited, and it is not the shape it looks like.** `paycloud_merchant_order_no` is
NULL and there is **no `payment.attempt_started` audit row for it at all**. Nothing was ever sent to
the gateway; no card interaction was possible. It was killed by the stale-POS auto-cancel cron
(`auto_timeout`) at 07:41:21, two minutes after being rung up.

**Correction to the premise:** #854 is *not* the same shape as the incident. #851 had a payment
attempt that succeeded and a notify that arrived late. #854 had no payment attempt whatsoever — an
abandoned ring, re-rung 23 seconds later as **#855** (Monster Black N$30 + the same 2× Boiled eggs
and Oven Buns = N$50), which Finatic confirms **PAID**, amount 50, txn `08210550238542015650`.

**Nothing to refund and nothing to correct on either.**

## 3. Chownow Nedbank cannot settle a card — what Sedrick needs to supply

**Attribution today is correct.** Terminal `ft-2aceb31b-152c-4a0c-8a75-5cecb8084b37` is registered
to `restaurant_id = b161c758` — **FNB ChowNow** — activated 2026-08-20 08:32, and orders #850–#858
are real FNB ChowNow trade, correctly attributed. Nothing is commingled.

**Chownow Nedbank (`38c493cf`, created 2026-08-19) has zero orders because it has not opened.** Its
devices were handed over on 2026-08-20 and have not been used. That is a venue waiting to start,
not a venue whose sales are going somewhere else.

### The gap, and why it only bites on the first sale

`restaurants` on production:

| restaurant | `finatic_merchant_no` | `finatic_store_no` | `checkout_merchant_no` | `checkout_store_no` |
|---|---|---|---|---|
| Riviera | `342600171063` | `4426017125` | `342600032359` | `4426010221` |
| FNB ChowNow | `342600131153` | `4426015803` | **NULL** | **NULL** |
| Mingle Brew & Pour | `342600160494` | `4426016800` | **NULL** | **NULL** |
| **Chownow Nedbank** | **NULL** | **NULL** | **NULL** | **NULL** |

Two things fall out of that table that were not the point of this investigation:

- **Riviera's checkout merchant number is a different number from its card one** (`342600032359`
  vs `342600171063`). So the hosted-checkout pair is genuinely separate, not a copy — which is why
  §"Exactly what to get from Sedrick" says ask rather than assume.
- **FNB ChowNow and Mingle have no checkout credentials at all.** If either is expected to accept
  QR / hosted-checkout payments today, it cannot: `app/api/orders/route.ts:519` reads the checkout
  pair with no fallback and would send Finatic a blank merchant number. Card-present is unaffected,
  which is why nobody has noticed. Worth confirming whether those two venues are meant to offer QR
  payment at all — if they are not, this is correct as it stands and needs nothing.

The sequence on Nedbank's first card, with today's code:

1. Card is presented and **clears at Finatic**. The money leaves the customer's account.
2. PayCloud posts the webhook. Its signature fails — `Encryption block is invalid.` — as it does on
   ~100% of live traffic (#107).
3. The `fallback_verified_paid` path runs, and calls
   `getRestaurantFinaticCredentials(restaurantId)`, which throws:
   `No Finatic credentials configured for restaurant`.
4. **The order is never settled.** The card is debited, FlashTap shows unpaid, and there is no
   second recovery path behind the one that just threw.

That is the same 19-second rescue that saved #851 this morning, except it cannot start.

### Exactly what to get from Sedrick

Two values are **required** before the first card. Both are per-venue and both come from Finatic's
merchant onboarding for the Nedbank site:

| field | what to ask for | format seen on the three live venues |
|---|---|---|
| `finatic_merchant_no` | **Merchant number** for the Chownow Nedbank merchant | 12 digits, all beginning `3426` — e.g. `342600131153` |
| `finatic_store_no` | **Store number** for that merchant's Nedbank store | 10 digits, all beginning `4426` — e.g. `4426015803` |

Two more are **required only if Nedbank will take QR / hosted-checkout payments** (customer pays on
their own phone rather than tapping the terminal):

| field | what to ask for |
|---|---|
| `checkout_merchant_no` | the **hosted-checkout** merchant number — often the same as the card one, but ask rather than assume |
| `checkout_store_no` | the hosted-checkout store number |

**These two need their own check, because the credential guard does not cover them.**
`getRestaurantFinaticCredentials` throws only when the *card* pair is missing. If the card pair is
set and the checkout pair is empty, it returns empty strings and
`app/api/orders/route.ts:519` uses them **with no fallback** — so a QR payment would go to Finatic
with a blank merchant number instead of failing cleanly. Card-present would work while QR silently
did not.

One field is **optional** and does not block anything: `finatic_terminal_sn`, which is only stamped
into payment-attempt audit metadata.

**Nothing app-level is needed.** `app_id` (`wz66363c6bb9592fb5`), the signing private key and the
gateway public key are environment-wide and already configured — Sedrick does not need to issue new
ones per venue, unless Nedbank is being onboarded under a different Finatic account entirely. Worth
asking him that one question explicitly, because if it is a separate account the app-level keys
change too and this becomes a much bigger job than four columns.

## 4. The N$51 breakdown — the 6.00 is not VAT

```
Cappucinno   1 × 45.00   taxRatePercentage 0   tax 0.00
Oven Buns    1 ×  6.00   taxRatePercentage 0   tax 0.00
                 -------
total            51.00   subtotal 51.00   tax 0.00
```

The 6.00 is **a second line item** — Oven Buns — not tax. FNB ChowNow's items carry
`taxRateId fea8ac7f-…` at **0%**, so the order has no VAT at all. For contrast, Mingle's order the
same morning used `taxRateId 33eb2e73-…` at 15% and split N$45 into 39.13 + 5.87.

Nothing is wrong here; the totals are internally consistent. Whether a 0% tax rate is correct for
FNB ChowNow is a business question, not a defect.

## 5. Filed

- **#325** — Order History renders TABLE as `0` for every POS row. Line 586 uses `??` (misses `0`);
  line 587, MEMBER, uses `||` and is correct. One line, adjacent, different operators.
- **#326** — the terminal's concatenated "already paid. — could not notify" copy, *and* the more
  expensive half: it renders a confirmed-paid order as FAILED and invites a retry.

## 6. Duplicate order numbers — re-measured, and the premise does not hold

```
orders with both columns non-null : 2824
distinct pairs                    : 1880
DUPLICATE PAIRS                   :  282
  legacy restaurant_test_*        :  279
  REAL restaurants                :    3
      FNB ChowNow / 420  x2
      FNB ChowNow / 448  x2
      FNB ChowNow / 314  x2
```

**The three FNB ChowNow duplicates are NOT resolved.** All six rows are still `completed`/`paid`,
and **`updated_at` is NULL on every one of them** — nothing has touched these rows at any point.

| | |
|---|---|
| orders with `restaurant_id IS NULL` | **1315** (#324's population) |
| orders with `firebase_restaurant_id LIKE restaurant_test_%` | **1314** |

**Would `orders_unique_order_number` apply cleanly now? No — and clearing the legacy rows alone is
not enough.** `CREATE UNIQUE INDEX` aborts on *any* duplicate, so it is blocked by both
populations:

1. #324 clears the 1315 legacy rows → removes 279 of the 282.
2. The **three real pairs still block it**, and they are live financial records at a trading
   restaurant. Renumbering one of each is a decision about customer receipts, not a cleanup.
3. Only then can the index be created.

**This ties `20260809120000_orders_unique_order_number` to #324 — but as a necessary, not a
sufficient, condition.** They are currently filed as unrelated; they are not. #127 carries the
production evidence for the three real pairs.

## 7. #311 — the answer to your question before implementing

**It is worse than a stranded row: there is no status to move a withdrawn request to.**

`20260726120000_order_requests_accepting_status.sql`, **confirmed applied on production** (it is in
the ledger):

```sql
CHECK (status = ANY (ARRAY['waiting_review', 'accepting', 'accepted', 'declined']))
```

There is no `withdrawn`, and no withdraw or cancel path exists in the codebase today — the only
writers are accept, decline and review.

So option **C** costs one of:

- **a migration** to widen the CHECK — excluded by the standing rules; or
- **overloading `declined`**, which makes a customer changing their mind indistinguishable from the
  restaurant refusing them. Given #285 is already open about `accepted` rows with NULL
  `accepted_order_id` being unlinkable, adding a second ambiguity to this column is the wrong
  direction.

And **B alone leaves the row exactly as stranded as it is today** — a `waiting_review` row with no
reaper (#215) is the 20-day row #311 was filed about. Telling the customer how long they have
waited does not resolve the record.

**Re-ruling needed.** My recommendation is now: **B only, plus the migration for C when migrations
are back on the table** — or accept a migration for this one and do B+C together as ruled.
