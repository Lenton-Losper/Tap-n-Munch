# URGENT — what a pre-fix APK does with `success: false`, and what the server does if it retries

Written 2026-08-24. **Read the first two sections before touching the terminal repo.**

The server now answers `success: false` for `outcome: 'left_pending_finatic_uncertain'`. That change
is live. Devices in the field were written against the old contract, where that same case answered
`success: true`, so old builds are receiving a value they have never seen.

**Superseded 2026-08-24:** this section originally cited staging's 19 terminals. Production is 87
across eleven versions with 27 unknowns — see §0, which replaces that reasoning entirely.

---

## 0. THE PRODUCTION FLEET, measured 2026-08-24 — read this before anything else

**87 terminals. Eleven versions. 27 reporting no version at all.** Staging's 19 were not
representative and nothing below should be reasoned about from them.

```
1.89 x4    1.85 x12   1.78 x1    1.75 x2    1.69 x10
1.59 x3    1.34 x10   1.30 x8    1.25 x1    1.18 x9
none x27
```

`success: false` for the uncertain outcome is **already reaching all of them.**

### What "no version" means, and it is the worst reading

`restaurant_terminals.app_version` is written **only** by the heartbeat, **only** when the device
sends `appVersion`, and **is never cleared**. A device that has ever reported a version keeps it
forever.

So a device that is heartbeating *now* and still shows NULL has **never sent one** — which means a
build older than the field itself. **The 27 unknowns are most likely the oldest software in the
fleet, not unidentified modern devices.** `probe-terminal-versions.ts` now partitions them three
ways — never activated, heartbeating-but-versionless, long stale — and cross-checks against
`payment_events.app_version`, which records the version *at the time of a sale* and can date a device
that has since gone quiet.

Run it again before deciding: the partition is the number that matters, not the 27.

### 87 rows is not 87 terminals

Several were last seen 6000+ minutes ago. The probe now reports the fleet in four windows — 15
minutes, 24 hours, 7 days, 30 days — plus never-seen.

**The rollout is the 30-day set.** A till that is off tonight is still a terminal that will take a
card on Monday; "online now" understates the fleet as badly as the row count overstates it.

### What this changes about the decision

The question was *"what does a 1.34 device do with `success: false`"*. With eleven versions and 27
unknowns it is now **"what do eleven builds plus an unknown tail do"**, and that is not answerable
by reading one handler. It has to be answered by the **oldest** build still in service, because that
is the one whose behaviour nobody has looked at in the longest time.

**Was `success: false` safe to ship ahead of the APK?** Honestly: it was shipped without knowing, and
that is now visible. The direction is still right — the old contract released food on an unconfirmed
payment (#868, N$33), and no reading of a failure screen is worse than that. But the trade was made
against a fleet assumed to look like staging's 19, and it looks like 87 across eleven versions.

Two things follow, in order:

1. **Establish what the oldest in-service build does** (§1). If a shared HTTP client retries, that is
   an unattended double-charge path across an unknown number of devices and the APK is tonight's
   work.
2. **If it does not auto-retry**, the exposure is one deliberate operator action per occurrence, and
   the APK follows the normal release path — with §1b's design decided before it is written.

---

## 0a. THE FLEET, MEASURED ON PRODUCTION 2026-08-25 — the answer is two builds, not eleven

**87 terminal rows is not 87 terminals, and eleven versions is not eleven live builds.** Measured
directly, read-only:

### What has actually attempted a payment

`audit_logs.action = 'payment.attempt_started'` carries `appVersion`, and it is **the only reliable
version record that exists** — see the warning below about `payment_events`.

```
LAST 7 DAYS          1.89   416 attempts   last 2026-08-24 12:45
                     1.85   102 attempts   last 2026-08-24 15:03

LAST 30 DAYS         1.89   416
                     1.85   292
                     1.78    54            last 2026-08-07   (18 days ago)
                     1.75     1            last 2026-08-06   (one attempt, ever)

ALL TIME             the same four. Nothing older has EVER attempted a payment.
```

**1.18, 1.25, 1.30, 1.34, 1.59, 1.69 — none of them has ever tried to take a card.** They exist as
rows in `restaurant_terminals` and nowhere else.

### So the supported version floor is 1.85

Everything transacting in the last week is **1.85 or 1.89**. `1.78` is the oldest build to transact
in 30 days and has been silent for 18 days. A floor of **1.85** covers 100% of current payment
traffic; a floor of 1.78 covers everything that has transacted this month.

### 87 rows, 16 real devices

```
ever posted a sale                16 of 87 rows
status=active, active=true        76 rows   39 seen in 30d   16 with no version
status=pending, active=false      11 rows    8 seen in 30d   11 with no version
seen in the last 15 minutes        0
last 24 hours                      5
last 7 days                       18
last 30 days                      47
never seen at all                  0
```

The 11 `status=pending, active=false` rows are **dead registrations** — activation was started and
never completed. Every one of them has no version, which is consistent: they never got far enough to
heartbeat one.

### THE 27 NO-VERSION DEVICES: none of them has ever reported a version through any channel

```
never activated (no last_seen_at)          0
heartbeating but never sent a version      5     <- and all 5 last seen 4.4+ days ago
last seen more than 7 days ago            22
reported a version on a past sale          0 of 27
```

So they are not modern devices with a reporting bug. They are devices that have **never** sent a
version by heartbeat or by sale, and **none of them has ever attempted a payment**. They are noise in
the registration table, not risk in the field.

### WARNING — `payment_events.app_version` IS NULL ON ALL 489 SALES

The column exists, the sale route writes it from `body.app_version`, and **no device has ever sent
one**. Any analysis that reads the version from `payment_events` — including the version breakdown in
the duplicate-charge detector — returns nothing and will look like "no data" rather than "not
recorded".

Use `payment.attempt_started` instead. This is the same shape as
`customer_sessions.last_seen_at` (#338): a column that reads as evidence and is never populated.

### What this means for the APK decision

The risk was framed as *"eleven builds plus 27 unknowns receiving `success: false`"*. The measured
answer is **two builds, 1.85 and 1.89, are taking payments**, and both are recent. The long tail is a
reporting artefact.

That makes the §1 investigation dramatically smaller: **check what 1.85 does**, and 1.89 if it
differs. It does not remove the need — an auto-retry in either is still an unattended double-charge
path across the entire live estate, because the live estate *is* those two builds.

### One more measured fact, for the retry question

`payment_events` records **489 sales, and the last one was 2026-08-20 11:14** — four days ago, while
`payment.attempt_started` shows payments being attempted **today**. Sale events cover only **16.9%**
of terminal-shaped paid orders overall, and of the orders actually paid by a terminal callback, 46
have a sale event and 30 do not.

The bulk — **948 of 1045** missing sale events — were paid by
`paycloud_webhook_fallback_finatic_verified`, i.e. the Finatic fallback resolved them rather than a
device reporting. That is #107's world working as designed, and those correctly have no sale event.
So the duplicate-charge blind spot is **far smaller than the raw gap suggests**, and signal B (the
409 refusal row) covers the device-side path that signal A cannot see.

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

## 2b. DOES SIGNAL B SHARE SIGNAL A's BLIND SPOT? NO — DIFFERENT ENDPOINT, DIFFERENT GAP

This matters because signal A looked blind on most card traffic, and the two are often assumed to
stand or fall together. They do not.

**They are posted to different endpoints, by different code, at different moments:**

| | signal A | signal B |
|---|---|---|
| written by | the DEVICE, `POST /api/terminal/payment-events/sale` | OUR SERVER, in the payment route |
| trigger | the device chooses to report a completed sale | a second success callback is refused |
| needs the device to | call a SECOND endpoint after paying | call the payment endpoint at all |
| blind when | the build never posts sale events | the second charge never reached us |

A build that calls `POST /orders/:id/payment` but never `POST /payment-events/sale` is entirely
possible — they are separate calls, and the sale event was added later. **Such a build is invisible
to A and fully visible to B.** That is the common case among old software, which is precisely the
tail that worries us.

So signal B is **narrower in what it detects** — only refused second callbacks, not every duplicate
— and **broader in which devices it covers**. It requires nothing of the device beyond reaching the
endpoint it was already going to call.

### The gap they DO share

A charge taken on a device that then reaches our server for neither call — no payment callback, no
sale event — leaves **no trace at all**, and no query can find what was never sent. Both signals are
blind there, and nothing can fix that server-side. It is an argument for the gateway's own
transaction listing being the authority, not our database.

### And B has a start date

Signal B begins the moment the promotion deploys. It says nothing about the past. **Only signal A can
see history**, which is why the sale-event gap is worth understanding rather than dismissing:
whatever A cannot see before today is permanently unknowable.

---

## 3. WHY THE SERVER CHANGE WAS STILL RIGHT

Worth having to hand, because it will be asked.

Before, `left_pending_finatic_uncertain` answered `success: true` — the same value as a confirmed
payment and a confirmed cancel. On 2026-08-21 the reader reported order #868 **declined**, the server
answered `success: true`, and **N$33 of food was released on a payment that never cleared**.

The old contract's failure released goods. The new contract's worst case is a retry that costs a row
or a second charge that is refundable. That is the right direction — but it is a trade, not a
free win, and the fleet spread is why it needs the terminal fix behind it.
