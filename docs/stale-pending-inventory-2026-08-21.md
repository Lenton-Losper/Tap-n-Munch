# Stale PENDING orders — inventory and verification

**Read-only. Nothing changed. No order was cancelled.**

Production `bbce8cb`. All 2894 orders read with pagination — an unpaginated read stops at 1000 and
would have missed a third of the table, which is #323's exact failure and would have made every
count below wrong.

---

## The buckets

| bucket | count |
|---|---|
| **1. PROVABLY UNPAID — safe to cancel** | **0** |
| **2. CONFIRMED PAID — need `markOrderPaidConfirmed`** | **0** |
| **3. UNCERTAIN or UNREACHABLE — skip, change nothing** | **17** |

**Bucket 1 is empty, and not because I was cautious — because this repository already ruled on
exactly this question and the ruling says these must not be cancelled.** See
[Why bucket 1 is empty](#why-bucket-1-is-empty).

## First, what is NOT in scope

455 orders are non-settled by a naive definition. **438 of them are `completed / cash_pending`** —
finished cash sales whose `payment_status` was never moved off `cash_pending`. They are not
abandoned sale flows, they are completed trade, and cancelling them would destroy real sales
records. They are excluded and are their own separate question.

The real candidate set is the **17 orders with `payment_status = 'pending'`**.

## The inventory — all 17

| # | restaurant | ord | placed (UTC) | age | total | status | `attempt_started`? | `paycloud_merchant_order_no` | creds |
|---|---|---|---|---|---|---|---|---|---|
| 1 | *(none — `restaurant_id` NULL)* | – | 2026-06-16 09:10 | 66d | 0 | `test` | no | **NULL** | **none** |
| 2 | Digi Cofee | 9 | 2026-07-17 09:22 | 35d | 5 | `cancelled` | no | **NULL** | **none** |
| 3 | Digi Cofee | 17 | 2026-07-22 08:31 | 30d | 3 | `ready` | no | **NULL** | **none** |
| 4 | Digi Cofee | 18 | 2026-07-27 10:56 | 25d | 8 | `ready` | no | `FT17851500264915187` | **none** |
| 5 | Digi Cofee | 20 | 2026-07-29 12:59 | 23d | 3 | `pending` | no | **NULL** | **none** |
| 6 | FNB ChowNow | 819 | 2026-08-06 10:14 | 15d | 85 | `pending` | **YES** | `FT17860112754682028` | yes |
| 7 | Riviera | 4 | 2026-08-12 15:59 | 9d | 20 | `pending` | **YES** | `FT17865504162630722` | yes |
| 8 | Mingle | 435 | 2026-08-13 05:58 | 8d | 55 | `pending` | **YES** | `FT17866007453150737` | yes |
| 9 | Mingle | 462 | 2026-08-13 13:34 | 8d | 30 | `pending` | **YES** | `FT17866280515004311` | yes |
| 10 | Mingle | 494 | 2026-08-14 13:21 | 7d | 55 | `pending` | **YES** | `FT17867137199497281` | yes |
| 11 | Mingle | 523 | 2026-08-18 07:03 | 3d | 65 | `pending` | **YES** | `FT17870366208595546` | yes |
| 12 | Riviera | 13 | 2026-08-19 00:05 | 2d | 20 | `completed` | no | **NULL** | yes |
| 13 | Riviera | 14 | 2026-08-19 00:34 | 2d | 50 | `ready` | no | **NULL** | yes |
| 14 | Mingle | 548 | 2026-08-19 05:10 | 2d | 35 | `pending` | **YES** | `FT17871162309977918` | yes |
| 15 | FNB ChowNow | 840 | 2026-08-20 11:12 | 20h | 165 | `pending` | **YES** | `FT17872243794696498` | yes |
| 16 | FNB ChowNow | 868 | 2026-08-21 05:53 | 1.5h | 33 | `ready` | **YES** | `FT17872916395951625` | yes |
| 17 | FNB ChowNow | 876 | 2026-08-21 06:09 | 1.3h | 7 | `pending` | **YES** | `FT17872925889458690` | yes |

Total exposure if every one were a real uncollected sale: **N$639**.

## Bucket 3, broken down

### 3a. Cannot be verified at all — no Finatic credentials (5)

**#1–#5.** Digi Cofee has `finatic_merchant_no` and `finatic_store_no` NULL, so
`queryFinaticOrderPaid` cannot be called for it under any circumstances. #1 has no restaurant at all
(`restaurant_id` NULL, `total` 0, `status` `test`) — it is part of #324's 1315-row legacy Firebase
population.

**Skipped, not cancelled**, exactly as instructed. Chownow Nedbank has no pending orders, so it does
not appear.

### 3b. No gateway order was ever created (2)

**#12, #13** — Riviera 13 and 14. `channel = 'table'`, no `payment_channel`, no `payment_method`, no
terminal, **no audit rows at all**, and `paycloud_merchant_order_no` NULL. Nothing was ever sent to
any gateway, so there is nothing to query by.

These are **not abandoned terminal sale flows** — they are QR/table orders that never reached
payment. The auto-cancel cron does not consider them either: it is scoped `.eq('channel','pos')`.
Out of scope for this cleanup.

### 3c. Finatic says E04111, and that is NOT proof of unpaid (10)

**#6–#11, #14–#17.** All ten are `channel='pos'`, `payment_channel='card_manual'`,
`payment_method='card'` — the abandoned-terminal-sale shape. All ten returned:

```
E04111 — Merchant order number is invalid
```

## The control, which is why I am not calling those ten "unpaid"

Ten identical negatives is the shape of a broken query, so I ran positive controls: known-paid
orders from the same three restaurants, on the same credentials, in the same run.

| control | result |
|---|---|
| FNB ChowNow 929 / 930 / 931 | **PAID**, amounts 21 / 47 / 81 — match the order totals |
| Riviera 6 | **PAID**, amount 20 |
| Mingle 610 / 613 / 614 | **PAID**, amounts 75 / 45 / 45 |
| Riviera 12 | **E04111** ← |

**7 of 7 card controls passed. The query path works on all three restaurants.**

The eighth is a flaw in my control selection, not a broken query, and it is worth recording because
it nearly read as one: Riviera 12 is `payment_method = 'cash'`, `channel = 'table'`. It carries a
merchant order number because one was allocated, but it settled in cash and no card ever reached
Finatic — so E04111 is the *correct* answer for it. I had selected controls as "any paid order with
a merchant order number" rather than "any paid **card** order".

So: E04111 on the ten is a genuine "the gateway has no record of this reference".

## Why bucket 1 is empty

**That still does not make them provably unpaid, and this repository already established why.**

`lib/orders/auto-cancel-stale-pos-orders.ts` carries a removal note dated 2026-08-05:

> REMOVED 2026-08-05: a branch here cancelled with reason `'no_payment_attempt_made'` when Finatic
> answered E04111 AND no `payment.attempt_started` marker existed. […] **E04111 is time-dependent —
> order #149 returned it at 13:58:48 and was confirmed PAID on the same reference at 13:59:10** — so
> that is a mass-cancel of real payments. Measured blast radius at removal time: **6 stale POS orders
> worth N$335 would have been cancelled on the first tick.**
>
> Marker ABSENCE carries no information and must never authorise a cancel. **Marker PRESENCE is
> sound as a one-way guard and may be used to SPARE an order** — that asymmetry is what PR2 should
> build on.

Two things follow, and they point the same way:

1. **A single E04111 observation is never terminal.** I have exactly one observation per order.
2. **All ten carry `payment.attempt_started`.** By the recorded asymmetry, marker *presence* is a
   reason to **spare** an order, never to cancel it. A payment was launched at the reader; a card
   may have been presented.

**None of the ten has a terminal-reported outcome.** Their audit trails are
`payment.attempt_started` and, for six of them, `payment.verification_uncertain` — written by
`lib/payments/handle-terminal-payment-failed.ts`, the terminal's *synchronous* failure path, within
~30 seconds of the attempt. (Corrected: an earlier version of this sentence attributed those rows to
the cron. The cron writes nothing when it skips.)

Contrast **#850 this morning**, which I *was* able to classify as not-debited: it had
`payment.failed` with `cancellation_reason: terminal_cancelled_by_user_pre_gateway` and WiseCashier
code **K026** — the terminal explicitly reporting an operator abort before the reader contacted the
gateway. E04111 corroborated that report. **None of these ten has that report**, so the corroboration
has nothing to corroborate.

This is a recorded decision that predates me, it was made with a measured blast radius, and #851 this
morning is a live example of an order that looked abandoned and had cleared. I am not overriding it.

## 5. Staleness, and whether the cron should have caught these

**An order is stale after 2 minutes.** `STALE_POS_TIMEOUT_MS = 2 * 60 * 1000`.

**There is no window they fell outside.** The candidate query is
`.eq('channel','pos').eq('payment_status','pending').lt('placed_at', cutoff)` — a single upper bound
and no lower bound. Every one of the ten matches it, and has matched it on every tick since it was
rung up.

**The cron is scheduled on production and it is running.** `wrangler.production.toml` carries
`crons = ["*/2 * * * *"]`, and it demonstrably cancelled orders #854 (2.0 min) and #901 (2.3 min)
today.

> **CORRECTED 2026-08-21.** This paragraph originally said the `payment.verification_uncertain`
> audit rows were "that cron doing its work and choosing not to act". **That was wrong.** Those rows
> are written by `lib/payments/handle-terminal-payment-failed.ts` — the terminal's *synchronous*
> failure path — within ~30 seconds of the attempt. **The cron's skip path writes no audit row at
> all**, only a `console.warn`, so there is no database trace of it having looked at any of these.
> That observability gap is itself part of the finding. See
> [order-876-and-the-cron-gap-2026-08-21.md](order-876-and-the-cron-gap-2026-08-21.md).

**So the cron is not broken and this is not a windowing bug. These orders are skipped by design**,
every two minutes, for the reason above.

### The actual fix, which the removal note names

> A single E04111 is never terminal (#149 registered 22s later); **deciding on persistence is the
> separate auto-cancel pass's job.**

That pass — "PR2" — was never built. It is the missing piece:

- **E04111 observed once means nothing. E04111 observed repeatedly over 15 days means something.**
  Order 819 has been pending since 2026-08-06. The removal note's counterexample flipped in 22
  seconds; nothing flips after two weeks.
- ~~The guard to build it on is already specified: **marker presence spares, marker absence decides
  nothing.** Since the marker is now actually being written — it was written zero times when the
  gate was removed, and all ten of these carry it — that asymmetry has become usable in a way it was
  not on 2026-08-05.~~

  **Withdrawn 2026-08-26 (#158).** The premise is right — the marker is written now, 1,009 rows
  since 2026-08-06 — but the conclusion does not follow, and the sentence "all ten of these carry
  it" is itself the counter-example that was misread as support. A spare-gate is only worth
  building if some orders lack the marker; **all** of the stuck ones carry it. Measured across POS
  orders placed on/after 2026-08-06: paid 94.5% marked, cancelled 74.3%, stale-pending 100%. The
  marker is *more* common on stuck orders than on paid ones, so it separates nothing in either
  direction and a spare-gate would spare 100% of the backlog. **Marker absence deciding nothing
  still stands** — for the design reason (a 2 s swallowed timeout, launch started first), which
  adoption cannot retire. Persistence, a positive control and a volume circuit breaker are what PR2
  actually needs; none of them involve this marker.

### And the upstream cause, already diagnosed

Two known defects produce these, and neither is fixed:

1. **The terminal's SALE path does not report an operator cancel unambiguously.** The REFUND path in
   the same file already models it correctly with a distinct `status: 'CANCELLED', retryable: false`.
   If SALE did the same, the server could cancel on the terminal's own word without a Finatic
   round-trip — which is precisely what made #850 classifiable and these ten not.
2. **The POS client sends no `x-idempotency-key`**, though the server reads it. So each staff retry
   after a failed launch creates a *brand-new* order instead of reusing the existing one. That is why
   one failed sale becomes two or three stranded rows.

Fixing (1) is what actually drains this queue. Everything else is triage.

## What I recommend

**Cancel nothing today.** Instead, in order of value:

1. Build the persistence pass. A second and third E04111 observation, days apart, recorded per order
   — then a cancel authorised on *persistent* E04111 **plus** an explicit terminal report, never on
   either alone.
2. Fix the terminal SALE cancel report (1 above). It removes the ambiguity at source.
3. Digi Cofee: either give it credentials or deactivate its terminal. Four of the seventeen are
   unverifiable purely because it has none.

If you want these seventeen off the operational view sooner, the safe move is a **display** change —
stop showing pending POS orders older than N days on the dashboard — which changes no financial
record. That is reversible and needs no verification. Say the word and I will scope it.
