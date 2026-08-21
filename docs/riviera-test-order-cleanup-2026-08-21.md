# Riviera test-order cleanup — inventory and verification

**Read-only. Nothing changed. Awaiting confirmation.**

Scope: Riviera `01bf27f1-a958-4322-bb3e-cc5240987808` only. FNB ChowNow, Chownow Nedbank and Mingle
were not queried or touched.

**Date range: your brief carried `[DATE RANGE]` unfilled**, so I took **all time** — which for Riviera
is **2026-08-12 13:15 → 2026-08-21 07:51**, 15 orders, N$1595. Narrow it and I will re-cut.

---

## The blocker, before the lists

**No existing cancel path can act on the five removal candidates, and that is deliberate.** All five
are `status = 'completed'`, `payment_status = 'paid'`. Both paths refuse:

| path | why it refuses |
|---|---|
| `cancelByIds` (`lib/orders/auto-cancel-stale-pos-orders.ts:54`) | re-asserts `.eq('payment_status','pending')`. These are `paid`. |
| `PATCH /api/terminal/orders/[id]/status` | `isValidTransition` returns **false** when `currentStatus === 'completed'` — cancelling a completed order is not a legal transition. |

That guard *is* the append-only protection you invoked. Un-booking a completed paid sale is not a
supported operation in this codebase, by design.

Refund is not a back door either: `totalRevenue = grossPaid − refundedDistinct`, and
`refundedDistinct` is derived from payment projections, which need real refund events — and
`refund_events` is **absent from production** (confirmed in the ledger audit).

**So step 4 cannot be executed as written.** Options are at the bottom; all of them need a decision
from you, and I have not taken any.

---

## The full inventory — all 15

| ord | placed (UTC) | total | method | pay_status | status | chan | `attempt_started` | gateway ref |
|---|---|---|---|---|---|---|---|---|
| 1 | 08-12 13:15 | 20 | cash | cancelled | cancelled | table | YES | `FT17865407517436390` |
| 2 | 08-12 13:38 | 20 | card | cancelled | cancelled | pos | YES | `FT17865419344826717` |
| 3 | 08-12 15:43 | 20 | card | cancelled | cancelled | pos | no | — |
| 4 | 08-12 15:59 | 20 | card | **pending** | pending | pos | YES | `FT17865504162630722` |
| **6** | 08-12 16:05 | **20** | **card** | **paid** | completed | pos | YES | `FT17865507287746658` |
| 5 | 08-12 16:02 | 20 | card | cancelled | cancelled | pos | YES | `FT17865505515941135` |
| 7 | 08-12 20:17 | 20 | cash | cancelled | cancelled | table | no | — |
| 8 | 08-17 20:12 | **640** | cash | paid | completed | table | no | — |
| 9 | 08-18 08:55 | 20 | card | cancelled | cancelled | pos | YES | `FT17870433619529933` |
| 10 | 08-18 15:01 | **290** | cash | paid | completed | table | no | — |
| 11 | 08-18 23:44 | **365** | cash | paid | completed | table | no | — |
| 12 | 08-18 23:45 | 20 | cash | paid | completed | table | YES | `FT17870967741284193` |
| 13 | 08-19 00:05 | 20 | — | **pending** | completed | table | no | — |
| 14 | 08-19 00:34 | 50 | — | **pending** | ready | table | no | — |
| 15 | 08-21 07:51 | 50 | cash | paid | completed | pos | no | — |

## Finatic verification — all seven references, both credential pairs

Not trusted from our own records. Queried with **Riviera's card pair** `342600171063 / 4426017125`,
and where that found nothing, also with its **checkout pair** `342600032359 / 4426010221` — which is a
different merchant number, so a hosted payment would be invisible to the card credentials.

| ord | method | our record | Finatic (card) | Finatic (checkout) |
|---|---|---|---|---|
| 1 | cash | cancelled | E04111 | E04111 |
| 2 | card | cancelled | E04111 | E04111 |
| 4 | card | pending | E04111 | E04111 |
| 5 | card | cancelled | E04111 | E04111 |
| **6** | **card** | **paid** | **PAID, amount 20, status 2, txn `08210805248808691770`** | — |
| 9 | card | cancelled | E04111 | E04111 |
| 12 | cash | paid | E04111 | E04111 |

**Ord 6 is the positive control as well as the answer** — it proves the query path works on Riviera's
credentials in this run, so the six E04111s are genuine "no such order at the gateway", not a dead
query. Its amount matches the order total exactly.

The eight orders with no reference cannot have a gateway payment: nothing was ever created for them.

---

## The two lists

### A. KEEP — card, verified at Finatic. Do not touch. **1 order, N$20**

| ord | total | evidence |
|---|---|---|
| 6 | 20 | Finatic `trans_status 2`, amount 20, txn `08210805248808691770`. Real money. |

### B. CANDIDATES FOR REMOVAL — cash or manually marked paid. **5 orders, N$1365**

| ord | total | method | note |
|---|---|---|---|
| 8 | 640 | cash | no gateway reference, no audit rows |
| 10 | 290 | cash | no gateway reference |
| 11 | 365 | cash | no gateway reference |
| 12 | 20 | cash | a card WAS launched (`attempt_started`, reference allocated) then settled as cash; Finatic confirms no card cleared |
| 15 | 50 | cash | settled via `terminal_callback` — the cash-settlement path |

**These five are the whole of Riviera's reported revenue except ord 6.**

### C. ALREADY CANCELLED — nothing to do. **6 orders, N$120**

Ords 1, 2, 3, 5, 7, 9. Already `cancelled / cancelled`; they are out of the reporting set already.

### D. AMBIGUOUS — skipped, telling you. **3 orders, N$90**

| ord | total | why ambiguous |
|---|---|---|
| 4 | 20 | card, `pending`, `attempt_started` present, E04111. **Exactly the class I declined to cancel for the other restaurants an hour ago** — E04111 alone is not proof, and marker presence spares. It is neither cash nor marked paid, so it falls outside your stated criteria either way. |
| 13 | 20 | `payment_method` NULL, `payment_status` pending but `status` completed — an inconsistent pair. Never paid, never a card. |
| 14 | 50 | same shape, `status` ready. |

**15 = 1 + 5 + 6 + 3. N$1595 = 20 + 1365 + 120 + 90.**

---

## Reporting baseline, for step 5

The summary keys on `payment_status = 'paid'` alone (`app/api/orders/history/route.ts`).

```
today   : 6 paid orders, totalRevenue N$1385.00
after B : 1 paid order,  totalRevenue N$   20.00   (ord 6, the kept card sale)
```

So the target end state is **not zero** — it is **N$20**, which is the real card sale you asked me to
keep. If you want a true zero, ord 6 has to go too, and that would mean cancelling a payment that
actually cleared at Finatic.

---

## Options, since no existing path will do it

1. **Cancel via a new, narrowly-scoped script** that lifts the completed-order guard for these five
   ids only, writes `order.cancelled` audit rows with an explicit reason, and refuses any order not
   in the list or not on Riviera. Honest, auditable, append-only — but it creates a capability to
   un-book completed paid sales, which is what the guards exist to prevent. It should be one-shot
   and not committed as a reusable route.
2. **Exclude the restaurant from reporting** until it opens — a display change, no financial record
   touched, fully reversible. Does not do what you asked (they stay in the data) but costs nothing
   and risks nothing.
3. **Leave them.** Riviera has not opened; its reported revenue is not being read by anyone yet.

I would do (1) only with the list above frozen and the script refusing anything outside it.

**Nothing is cancelled. Confirm which option and which orders, and I will act on exactly that list.**
