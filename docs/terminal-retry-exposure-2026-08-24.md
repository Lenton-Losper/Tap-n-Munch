# URGENT — what a pre-fix APK does with `success: false`, and what the server does if it retries

Written 2026-08-24. **Read the first two sections before touching the terminal repo.**

The server now answers `success: false` for `outcome: 'left_pending_finatic_uncertain'`. That change
is live. Devices in the field were written against the old contract, where that same case answered
`success: true`. The staging fleet spans **1.31 → 1.88 across 19 terminals, seven of them on 1.34**,
and #868 happened on **1.89** — so old builds are receiving a value they have never seen.

---

## 1. WHAT TO LOOK FOR IN THE TERMINAL SOURCE

The question: **when the response is `success: false`, does the device show a terminal error state, or
does it re-arm the reader?** A retry loop on a payment screen is a double-charge path.

### Where to look

Find the handler for the **payment-status POST**, i.e. whatever calls:

```
POST /api/terminal/orders/{orderId}/payment
```

Search the repo for these, in this order — the first hit is usually the file:

```
orders/                     the URL path fragment
/payment                    "
success                     the response field being branched on
canClose                    sent alongside it; only this route sends it
left_pending_finatic_uncertain
corrected_to_paid
```

In a typical RN layout this is a service module (`api/`, `services/`, `network/`) plus one screen
(`PaymentScreen`, `CheckoutScreen`, `SaleScreen`). **You want the screen**, because the retry decision
is a UI decision.

### THE SHAPE THAT IS FINE — a terminal error state

The handler reaches a state the operator has to *leave* deliberately, and does not call the reader
again on its own:

```js
if (!res.success) {
  setState('FAILED')                 // or navigate to an error screen
  showMessage(res.reason ?? '...')   // whatever it shows, it STOPS here
  return
}
```

Markers of the safe shape:
- a `return` / `throw` / `navigate(...)` immediately after the failure branch
- the next card transaction requires an operator **tap** — an `onPress`, a button, a new sale
- no timer, no loop, no recursion around the pay call

### THE SHAPE THAT IS DANGEROUS — an automatic retry

Any of these around the pay call or its failure branch:

```js
// 1. recursion
async function pay(attempt = 0) {
  const res = await postPayment(...)
  if (!res.success && attempt < 3) return pay(attempt + 1)     // <-- re-arms the reader
}

// 2. a timer
if (!res.success) setTimeout(() => pay(), 3000)                // <-- same thing, slower

// 3. a loop
while (!ok && tries < N) { ok = (await postPayment(...)).success }

// 4. a generic HTTP layer that retries non-2xx or a falsy `success`
axios.interceptors.response.use(null, retryOn(...))            // <-- WORST: invisible at the call site
apiClient.post(url, body, { retry: 3 })
useQuery(..., { retry: 3 })                                    // react-query retries by DEFAULT
```

**Number 4 is the one to hunt hardest.** A retry policy in a shared HTTP client is invisible in the
payment screen and applies to every call. Grep the whole repo for:

```
retry            maxRetries       attempts        backoff
setTimeout(      setInterval(     interceptors    axios.create
useQuery         useMutation      p-retry         async-retry
```

If a shared client retries and the payment POST goes through it, **every device using that client is
affected regardless of the screen's own logic.**

### THE THIRD SHAPE, and it is easy to miss

The response is `success: false`, the screen shows a failure, and the **operator** presses "retry" —
which is correct behaviour and still a second card transaction. What matters then is what the retry
button DOES:

- **Re-POSTs the same `orderId`** → the reader takes a second payment for one order. See §2.
- **Starts a NEW SALE** → a brand-new order, no relationship recorded to the first. See §2, worse.

Answer these three, in this order:

1. Does any shared HTTP layer retry automatically? (repo-wide grep above)
2. Does the payment screen's `!success` branch return/navigate, or re-call?
3. Does the operator-facing retry re-send the same `orderId`, or begin a new sale?

---

## 1b. THE OPERATOR RETRY — what the terminal SHOULD do, and why

This is the design question, and it is the one that is easy to get backwards, because the *correct*
behaviour and the *dangerous* behaviour look identical on the screen.

An operator pressing retry after a genuine failure is **correct**. It is also a second card
transaction. So the question is not whether to allow it — you must — but **what the retry is attached
to.**

### The answer, first

| outcome | what a retry should do | why |
|---|---|---|
| `cancelled` — definitively not paid | **resume the SAME order** | nothing was taken; the order is still owed for. A new order would strand the first. |
| `left_pending_finatic_uncertain` | **resume the SAME order, and only after the operator confirms with the customer** | this is the dangerous one — see below |
| `corrected_to_paid` | **no retry at all** — it is paid | the screen should not offer one |

**Same order, in all cases where a retry is offered. Never a new sale.**

### Why "same order" is the safe default

A retry that starts a **new sale** creates a second order, and:

- the first order stays `pending` forever and is stranded — that is #868's neighbour, the exact shape
  `docs/order-876-and-the-cron-gap-2026-08-21.md` describes, where the stale-order cron has a branch
  with no terminating condition
- **the two charges have no recorded relationship.** Two orders, two references, nothing linking
  them. Neither of the two duplicate-charge signals in §2 can see it, because both work by finding
  two references against **one** order id
- the customer's bill is now two orders for one meal, and reconciliation is manual

Re-POSTing the **same** `orderId` keeps every one of those problems visible: the server refuses with
409, and — from 2026-08-24 — **writes an audit row carrying both gateway references and a
`distinctGatewayTransaction` flag.** A second charge against the same order is detectable. A second
charge against a new order is not.

### But `left_pending_finatic_uncertain` is different, and this is the crux

For `cancelled`, the gateway has told us no money moved. Retrying is unambiguous.

For **uncertain**, the gateway could not tell us either way. **A retry there may be charging a card
that has already been charged**, and no amount of client logic can determine that — the information
does not exist on the device, or on our server, at that moment.

So the uncertain screen should not present a bare "Retry" button. It should present the *state*, and
make retry the deliberate second step:

1. say plainly that the payment could **not be confirmed**, and that the food must **not** be
   released
2. offer **"Check payment status"** as the primary action — re-query rather than re-charge. Any
   endpoint that re-reads the order is safe to press repeatedly; a charge is not
3. offer retry only as a secondary action, and word it so the operator knows what they are doing —
   the customer may already have been debited

If you want one rule for the APK: **the primary action on an uncertain outcome must be idempotent.**
Re-reading is idempotent. Re-charging is not. Making the safe action the big button is worth more
than any warning text.

### And regardless of which retry shape you choose — send the key

Whatever the retry does, it should carry a stable `x-idempotency-key` for the sale, per §1 item 3.
That is what makes "resume the same order" safe even if the operator presses twice, and it is what
would bound the new-sale shape if you ever did need it.

**Generate it when the operator starts ringing up. Hold it for that sale, across retries. Clear it
when the sale completes or is abandoned.** A key minted per render does not survive a navigation and
is no key at all.

---

## 2. DOES THE SERVER PROTECT YOU IF AN OLD DEVICE RETRIES?

**Partly — and it protects the bookkeeping, not the card. Plainly: the exposure is bounded in our
database and UNBOUNDED at the gateway.**

### What IS protected

`markOrderPaidConfirmed` is an atomic conditional claim: the UPDATE re-checks that `payment_status`
is still claimable, so a second success callback for the same order cannot mark it paid twice. The
route returns **409 `ALREADY_PAID`**. Verified in `lib/payments/mark-order-paid-confirmed.ts` and
`app/api/terminal/orders/[orderId]/payment/route.ts:135-143`.

So: no duplicated `paid` row, no duplicated receipt from that path, no doubled tab total.

### What is NOT protected

**The card is charged on the device, by the reader, before our server is involved at all.** Nothing
we return can prevent a second transaction — by the time the POST arrives, the money has moved. Our
409 is bookkeeping applied after the fact.

**FIXED 2026-08-24.** That branch used to return before writing anything, so the single moment the
server learns a payment succeeded for an already-paid order produced no record at all. It now
writes a `payment.refused_already_paid` audit row carrying BOTH gateway references and a
`distinctGatewayTransaction` flag — true when the reference differs from the one the order already
carries, which is a second transaction rather than a repeated callback. The refusal itself is
unchanged; only its visibility.

The flag is derived at the moment both references are in hand, because the order's reference is
whatever the FIRST payment wrote and never changes — the comparison cannot be reconstructed later.

### The one place a second charge WOULD leave a trace

`payment_events` is keyed `idempotency_key: businessOrderNo`, which is per gateway transaction. A
genuine second charge carries a new `businessOrderNo`, so it inserts a **second `sale` row naming the
same `order_ids`**.

That makes it *detectable after the fact* — and only if the device posts the sale event.
**Nothing detects it today.** There is no monitor, no alert, no cron. The only acknowledgement that
this category exists is a `duplicate_charge` reason code on the refund route, i.e. a human cleaning
it up afterwards.

I have prepared a detector for you to run: `scripts/prod/probe-duplicate-charges.ts`, and the same
two signals as a reusable library, `lib/payments/detect-duplicate-charges.ts`, so a one-off and a
scheduled check cannot drift apart in what they consider a duplicate.

**Should it be scheduled? Yes, but hourly, not on the 2-minute tick.** A double charge is not
time-critical in the way a stranded pending order is -- the money has already moved and the remedy
is a refund a human performs -- so the value is *never missing one*, not *catching it in ninety
seconds*. It should run alongside the other self-limiting crons (negative-stock-balances,
reap-abandoned-tabs), scan only rows newer than its last run, and `console.error` per hit with the
order number and both references. It is NOT built: putting a scheduled writer on the payment path
the same night as a promotion is the kind of thing that should land on its own.

### The worse retry shape

If the operator's retry starts a **new sale** rather than re-sending the same order, the server has
no defence at all: a new order, a new charge, and **no recorded relationship between the two**. The
mechanism that would bound this — `x-idempotency-key` — is read and honoured by
`app/api/terminal/orders/route.ts`, and **0 of 1545 production POS orders have ever carried one.**

### What this means for your shipping decision

| | |
|---|---|
| double-marking paid | **prevented** by the atomic claim |
| double-charging the card | **not preventable server-side**, ever — the reader acts first |
| a second charge being visible | **only** as a second `payment_events` row, and only if posted |
| anything alerting on it | **nothing** |
| the new-sale retry shape | **entirely unbounded** until the terminal sends `x-idempotency-key` |

**If the answer to §1 is "a shared client retries automatically", treat it as live and ship
immediately** — that is an unattended double-charge path on every affected device.
**If it is "the operator must press retry", the exposure is one deliberate human action per
occurrence**, which is materially slower, and the APK can follow the normal release path.

Either way, run script 5 first: it tells you whether this has already happened.

---

## 3. WHY THE SERVER CHANGE WAS STILL RIGHT

Worth having to hand, because it will be asked.

Before, `left_pending_finatic_uncertain` answered `success: true` — the same value as a confirmed
payment and a confirmed cancel. On 2026-08-21 the reader reported order #868 **declined**, the server
answered `success: true`, and **N$33 of food was released on a payment that never cleared**.

The old contract's failure released goods. The new contract's worst case is a retry that costs a row
or a second charge that is refundable. That is the right direction — but it is a trade, not a
free win, and the fleet spread is why it needs the terminal fix behind it.
