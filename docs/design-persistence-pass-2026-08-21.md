# Design: the persistence pass, the skip audit row, and the terminal SALE report

**Scoped, not built.** Ruled 2026-08-21: this touches money and does not get built at speed. Nothing
in here is implemented.

The problem, measured: `lib/orders/auto-cancel-stale-pos-orders.ts` partitions stale POS orders on
`paycloud_merchant_order_no`. No reference → cancelled outright in ~2 minutes. **Has a reference →
Finatic → E04111 → `skippedUncertainIds` → nothing, on every run, forever.** There is no terminating
condition, so those orders accumulate and each one costs a Finatic query every 2 minutes: ten of them
is roughly **7,200 queries a day** that can never change anything.

---

## Part 1 — The persistence pass

### The rule it has to obey

From the 2026-08-05 removal note, which is a recorded decision and the reason this is a design rather
than a patch:

> **E04111 is time-dependent** — order #149 returned it at 13:58:48 and was confirmed PAID on the
> same reference at 13:59:10. […] Marker ABSENCE carries no information and must never authorise a
> cancel. **Marker PRESENCE is sound as a one-way guard and may be used to SPARE an order.**

So: **repeated E04111 over a long interval AND an explicit terminal report. Never either alone.**

### 1.1 How observations are recorded

A new append-only table. It is the smallest thing that makes "persistent" a measurable word rather
than a feeling.

```
payment_verification_observations
  id                uuid pk
  order_id          uuid  not null   -> orders(id)
  restaurant_id     uuid  not null
  merchant_order_no text  not null   -- the reference actually queried
  observed_at       timestamptz not null default now()
  gateway_code      text            -- 'E04111', or null when the query itself failed
  outcome           text  not null   -- 'e04111' | 'not_paid' | 'paid' | 'query_failed'
  raw_message       text
  UNIQUE (order_id, observed_at)
```

**Append-only, never updated.** One row per observation, so the history is the evidence. A counter
column on `orders` was considered and rejected: a counter cannot distinguish ten observations over
ten minutes from ten over ten days, and the interval is the entire point.

**This needs a migration**, which is currently off the table — so the pass cannot ship before that
ruling changes. Flagged here rather than discovered at implementation time.

Cheaper interim if a migration stays blocked: write an `audit_logs` row per observation
(`payment.verification_observed`) and read the history back from there. It works, it is queryable,
and it pollutes the audit table with high-frequency machine noise — acceptable as a bridge, not as
the design.

### 1.2 What counts as persistent

Three conditions, all required:

| condition | value | why this and not something else |
|---|---|---|
| **span** | first and latest E04111 at least **24 hours** apart | The counterexample flipped in 22 seconds. Hours would be defensible; 24h is chosen because the shortest safe interval nobody has to argue about is "longer than any plausible gateway lag", and settlement runs on a daily cycle. |
| **count** | at least **6** observations, all `e04111` | At one query per 2 minutes this is reached in 10 minutes, so count alone proves nothing — it exists to reject a single flaky reading, not to establish age. Span does the real work. |
| **purity** | **zero** `paid` observations, ever | One `paid` observation permanently disqualifies the order from cancellation regardless of what follows. |

**Cut the query rate at the same time.** Once an order has 6 E04111s, drop it to one observation per
hour. That alone removes ~95% of the 7,200 daily queries, and it is worth doing even if the cancel
half is never built.

### 1.3 What authorises a cancel

**Persistence is necessary and not sufficient.** The second half is an explicit terminal report:

```
cancel authorised  ⇔  persistent E04111 (1.2)
                   ∧  an explicit terminal outcome for this order
                   ∧  no `paid` observation, ever
                   ∧  payment_status is STILL 'pending' at the moment of the write
```

"Explicit terminal outcome" means the device said what happened — today that is an audit row of
`payment.failed` carrying a `cancellation_reason`, as #850 had with
`terminal_cancelled_by_user_pre_gateway` and WiseCashier `K026`. **Not** `payment.attempt_started`,
which says a payment was launched and nothing about how it ended, and which by the recorded
asymmetry *spares* rather than condemns.

**On today's data this authorises nothing.** All ten stale in-flight orders carry
`attempt_started` and none carries a terminal outcome — which is the correct result, and is exactly
why Part 3 matters more than Part 1.

Every cancel writes an audit row naming both halves of the evidence: the observation span and count,
and the terminal report it relied on. A cancel whose reasoning cannot be reconstructed later is not
auditable, and this is money.

---

## Part 2 — The skip path writes an audit row

**Today it writes nothing.** `lib/orders/auto-cancel-stale-pos-orders.ts` pushes to
`skippedUncertainIds`, the cron route `console.warn`s it, and that is all. **Nothing in the database
records whether the cron looked at an order once or sixty times** — which is precisely why this
could not be answered from the data and had to be reconstructed from source.

Minimum viable, independent of Part 1 and shippable without a migration:

```ts
action: 'payment.verification_skipped'
metadata: {
  businessOrderNo, gatewayCode: 'E04111' | null, isE04111,
  reason, observationCount, firstObservedAt, terminalId, source: 'auto_cancel_cron',
}
```

**Write it once per order per hour, not once per run.** At one row per 2 minutes, ten stale orders
would add ~7,200 audit rows a day and bury the human-meaningful entries — the same noise problem
that makes the interim option in 1.1 a bridge rather than a design.

This is the piece worth doing first. It is small, it writes no financial state, and it makes the
next question answerable from data instead of from reading source.

---

## Part 3 — What the terminal SALE path must report

**This is the real fix.** Parts 1 and 2 are instrumentation around an ambiguity; this removes the
ambiguity at source.

### The asymmetry today

The REFUND path already models a terminal-side cancel correctly, with a distinct
`status: 'CANCELLED', retryable: false`. **The SALE path does not.** When staff cancel on the reader,
nothing is sent to the gateway — so E04111 is the correct and expected answer — but the server has no
way to distinguish that from "a payment was launched and its fate is unknown". Both look identical:
`attempt_started` present, reference allocated, gateway says nothing.

### What SALE has to send

An unambiguous outcome for every launch, with a distinct code for each end state:

| outcome | meaning | what the server may do |
|---|---|---|
| `CANCELLED_PRE_GATEWAY` | operator aborted before the reader contacted the gateway (WiseCashier `K026`) | **Cancel immediately.** No Finatic round-trip needed — this is the #850 case, and it is already provable today when the terminal says it. |
| `DECLINED_BY_GATEWAY` | the gateway answered and refused | Cancel after one confirming query. |
| `COMPLETED` | the reader believes it succeeded | Verify, then `markOrderPaidConfirmed`. Never trust it alone — #851. |
| `UNKNOWN` | the app genuinely does not know (crash, power loss, lost connectivity) | Leave pending. This is the only state that should ever reach the persistence pass. |

**The point is that `UNKNOWN` becomes rare and explicit** instead of being the silent default for
every launch that does not report. Today every abandoned sale looks like `UNKNOWN`; with this, most
of them are `CANCELLED_PRE_GATEWAY` and resolve in two minutes with no gateway call at all.

Note what this does to Part 1: if SALE reports properly, the persistence pass stops being the
mechanism that drains the queue and becomes a rare backstop for genuine `UNKNOWN`. That is the right
shape, and it is an argument for doing Part 3 **before** Part 1 rather than after.

### Also required, and separate

The POS client sends no `x-idempotency-key` though the server reads it — **0 of 1545 production POS
orders carry one** — so each retry after a failed launch strands a new order instead of reusing it.
Filed as **#328**. Without it, fixing the reporting still leaves one failed sale producing two or
three rows.

**The terminal is a separate APK and is not in this repository**, so Part 3 and #328 are both
client-side work that cannot be done from here.

---

## Recommended order

1. **Part 2** — the skip audit row. Small, no financial write, no migration, and it makes everything
   else measurable. Plus the hourly rate-cut, which pays for itself immediately.
2. **Part 3** — the terminal SALE outcome. Removes the ambiguity at source and drains most of the
   queue without any of Part 1.
3. **#328** — the idempotency key. Stops the queue refilling.
4. **Part 1** — the persistence pass, last, as a backstop for what is left. It needs a migration
   ruling before it can start.

Doing 1 first also means that by the time anyone builds 4, there is real observation data to choose
the span and count from, instead of the judgement calls in §1.2.
