# #876, and why the stale-order cron will never resolve it

**Read-only. Nothing changed.** FNB ChowNow order **#876**, 2026-08-21 08:09:43 local, 1× Vetkoek,
N$7.00, card.

---

## 1. Which shape is it? — **#851's, not #854's**

| | #876 |
|---|---|
| `payment.attempt_started` audit row | **YES** — 08:09:50 local, terminal `ce106a73`, app v1.89 |
| `paycloud_merchant_order_no` | **non-null** — `FT17872925889458690` |
| `payment_reference` / `payment_voucher_no` | both NULL |

**A payment was launched at the reader.** That is the #851 shape — the one where a card may have
been presented — not #854's, which had no attempt row and a NULL reference.

## 2. Did the card clear? — **No. Nothing was taken.**

`queryFinaticOrderPaid`, FNB ChowNow's credentials `342600131153 / 4426015803`:

```
#876  FT17872925889458690   E04111 — gateway has no such order
```

**With live positive controls in the same run**, because ten identical negatives earlier today were
already once the shape of a broken query:

```
#931  CONTROL  known paid   PAID  amount=81  status=2  txn=08210817421526247419
#929  CONTROL  known paid   PAID  amount=21  status=2  txn=08210817421342257220
```

The query path is working on these exact credentials right now. **No N$7 was taken, so nothing goes
to `markOrderPaidConfirmed`.** Nothing to correct.

One honesty note: this is the **second** E04111 for #876, about 29 minutes after the first, on an
order now 2h+ old. That is materially stronger than a single reading — the 2026-08-05 counterexample
flipped in 22 seconds — but it is still not the *persistent* evidence the removal note asks for, and
the `attempt_started` marker is present, which by that ruling **spares** an order. So: not paid, and
still not mine to cancel.

## 3. Why the cron did not touch it — **it is in scope, and skipped by design**

**#876 is not outside the cron's window. It matches the candidate query exactly.**

```js
.eq('channel', 'pos')            // #876 is pos          ✓
.eq('payment_status', 'pending') // #876 is pending      ✓
.lt('placed_at', now - 2min)     // #876 is 2h+ old      ✓
```

Staleness is **2 minutes** (`STALE_POS_TIMEOUT_MS`), the cron runs **every 2 minutes**
(`wrangler.production.toml`, `crons = ["*/2 * * * *"]`), and there is no lower bound on the query.

**The cron was demonstrably alive after #876 went stale**: it cancelled order **#901 at 06:44:09
UTC** with `auto_timeout` — 34 minutes after #876 was placed.

### The actual cause: a partition on `paycloud_merchant_order_no`

`lib/orders/auto-cancel-stale-pos-orders.ts:133-136`:

```js
const noAttempt   = rows.filter(o => !o.paycloud_merchant_order_no)   // no gateway reference
const withAttempt = rows.filter(o =>  o.paycloud_merchant_order_no)   // has one

result.cancelledIds.push(...await cancelByIds(supabase, noAttempt.map(o => o.id)))  // cancelled outright
```

- **No reference → cancelled immediately, no Finatic call.**
- **Has a reference → Finatic → E04111 → `catch` → `skippedUncertainIds` → nothing happens.**

Today's four cases prove it, and the discriminator is the reference and nothing else:

| ord | total | reference | outcome |
|---|---|---|---|
| 854 | N$20 | **NULL** | cancelled by cron, **2.0 min** after placing |
| 901 | N$67 | **NULL** | cancelled by cron, **2.3 min** after placing |
| 868 | N$33 | **PRESENT** | still pending |
| **876** | **N$7** | **PRESENT** | **still pending** |

**The split is backwards from what an operator would expect.** An order where *nothing* ever reached
the gateway is cancelled in two minutes. An order where a payment *was launched* — the one that
might have taken money — sits indefinitely.

The caution is right in direction. It is the class that could have been charged, and #851 is this
morning's proof. **What it lacks is any terminating condition.** There is no "still E04111 after N
hours" rule, so the branch has no exit and these orders accumulate forever.

### Two things that make it worse

**It leaves no trace.** The skip path writes **no audit row** — only `console.warn` in the cron
route. So from the database there is no way to tell whether the cron has looked at #876 sixty times
or zero times.

> **Correction to this morning's stale-pending report.** I wrote that the
> `payment.verification_uncertain` rows were "the cron running and declining to act". **That was
> wrong.** Those rows are written by `lib/payments/handle-terminal-payment-failed.ts` — the
> terminal's *synchronous* failure path — within ~30 seconds of the attempt. The most recent one is
> 06:00:22, while orders were still being placed at 08:13. The cron writes nothing at all, which is
> the point above.

**It re-queries forever.** Every stale in-flight order is sent to Finatic on every run. Ten such
orders across production × 30 runs/hour ≈ **7,200 gateway queries a day** for orders that can never
resolve, and the count only grows.

### The fix

Not a window change — the window is already 2 minutes and it is matching. The branch needs an exit,
and the removal note already specifies its shape:

> "A single E04111 is never terminal […] **deciding on persistence is the separate auto-cancel
> pass's job.**"

Persist each E04111 observation per order with a timestamp, and authorise a cancel only on
*repeated* E04111 over a long interval **and** an explicit terminal report — never on either alone.
Upstream, the terminal SALE path still does not report an operator cancel the way the REFUND path
does; fixing that removes the ambiguity at source and drains this queue properly.

## 4. Sweep — today's FNB ChowNow orders

**85 orders placed today. Exactly 2 are non-settled**, and you had already spotted one of them.

| ord | placed (local) | total | method | status | pay_status | reference | classification |
|---|---|---|---|---|---|---|---|
| 868 | 07:53:57 | N$33 | card | **ready** | pending | PRESENT | E04111, `attempt_started` present — same class as #876 |
| **876** | 08:09:43 | N$7 | card | pending | pending | PRESENT | E04111, `attempt_started` present |

The other 83: **76 `completed / paid`**, **7 `cancelled / cancelled`**. Nothing else is open, and
nothing today is in the "confirmed paid but unrecorded" bucket.

**#868 is the one worth a second look.** Its status is `ready` — the kitchen made the food — with
payment still pending and E04111 at the gateway. N$33 of food went out and no card cleared. It also
carries a `payment.verification_uncertain` row at 05:54:28, 28 seconds after the attempt, so the
terminal itself recorded that it could not confirm.

**Total open exposure today: N$40**, across two orders, neither of which was charged.

---

**Nothing changed. No order was cancelled, corrected or edited.**
