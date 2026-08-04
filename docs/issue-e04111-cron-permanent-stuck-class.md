# The E04111 permanent-stuck class

Referenced by `scripts/resolve-mingle-pending-20260803.ts` and issues #149 / #153 / #154.

## What E04111 is

Finatic's `order.query` (`/api/entry/orderquery`) answers **HTTP 200** with a body carrying
`code: 'E04111'`, `msg: '[E04111]Merchant order number is invalid'`. Despite the wording, this
is not a format complaint — it means *"I have no record of this `merchant_order_no`."*

**It is time-dependent, and this is the single most important fact about it.** On 2026-08-03,
order **#149** logged E04111 for reference `FT17857583233613303` at 13:58:48 and was confirmed
**PAID on that same reference at 13:59:10** — 22 seconds later
(`docs/finatic-questions-for-vernon.md`). So E04111 means "not registered at the gateway
*yet*", and a single observation is never proof that no payment exists.

## Why orders get stuck forever

`payments/paycloud.js` treats any non-success `body.code` as a business failure and **throws**
a `PaycloudRequestError` with `phase: 'business'` and the gateway body on `responseBody`:

```js
// payments/paycloud.js — queryPaymentOrder
const successCode = String(body.code || '').toUpperCase()
if (successCode && !['0', 'SUCCESS', '200'].includes(successCode)) {
  throw new PaycloudRequestError(`PayCloud query failed: ${body.code} ${failReason}`, {
    httpStatus: response.status, responseBody: body, rawText: raw, phase: 'business',
  })
}
```

`queryFinaticOrderPaid` does not catch it, so it surfaces at the caller. In
`lib/orders/auto-cancel-stale-pos-orders.ts` the caller is a `catch` that deliberately refuses
to cancel on an inconclusive answer:

```ts
} catch (err) {
  // Finatic unreachable, errored, or credentials missing -- no confident answer.
  // Never default to cancelling here; leave payment_status='pending' and retry next run.
  result.skippedUncertainIds.push(orderId)
}
```

That policy is correct — it is the guard put in after the 2026-07-27 FNB ChowNow incident, where
cancelling on `payment_status` alone auto-cancelled real successful charges. But E04111 is
**indistinguishable from a network timeout** at that catch site, so an order that Finatic will
*never* recognise is retried every 2 minutes forever. The Cloudflare cron
(`wrangler.toml`, `crons = ["*/2 * * * *"]` → `/api/cron/cleanup-stale-orders`) re-probes it,
gets E04111, skips it, and writes nothing. Observed: orders stranded **100+ minutes across
50–150 runs**.

This is the permanent-stuck class. It is not a bug in the skip policy; it is the absence of any
terminal decision for the one error code that is both persistent and evidential.

## Where E04111 is swallowed

Three sites, all now classified via the shared `isE04111()` in
`lib/payments/finatic-error-codes.ts` (reads `responseBody.code`, falls back to the message):

| Site | Behaviour on E04111 |
|---|---|
| `lib/orders/auto-cancel-stale-pos-orders.ts` | skipped, retried next run; reported in `e04111Ids` |
| `lib/payments/webhook-sig-fallback.ts` | `fallback_query_failed` → route returns 503 so Finatic retries |
| `lib/payments/handle-terminal-payment-failed.ts` | order left pending, `payment.verification_uncertain` audit |

Retrying is the correct response in all three: the reference may register later. What was
missing is a rule for when it never does.

## Evidence standard for calling an E04111 order genuinely unpaid

No single signal is sufficient. `scripts/resolve-mingle-pending-20260803.ts` requires all of:

1. `status` and `payment_status` both `pending`; `payment_reference`, `payment_voucher_no`,
   `payment_checkout_url`, `terminal_sn`, `terminal_status` all never set.
2. `paycloud_merchant_order_no` allocated (so a launch was attempted).
3. `audit_logs` contains only `payment.verification_uncertain` — no `payment.completed`.
4. No `payment_events` row references the order.
5. A fresh live `order.query` returns E04111 at resolution time.
6. A **same-session control probe** on a known-paid reference for the same restaurant resolves
   correctly, proving the credentials and the query path are live.

Point 6 is what separates "this order does not exist" from "our credentials are broken".
Without it the two are identical on the wire, and acting on the difference would mass-cancel
real payments.

**The control probe is necessary but not sufficient.** It exercises an *old* reference, which
Finatic has long since indexed. It cannot detect a gateway incident in which recent references
are missing or lagging while old ones resolve fine — which, given that E04111 is a recency
artifact, is the most likely shape of a systemic failure. The volume circuit breaker in the
auto-cancel rule exists specifically for that hole: an incident is characterised by *count*.

The discriminator has been validated against a control group rather than assumed. On
2026-07-31, 13 payments that succeeded on the identical path in the same window all set both
`payment_reference` and `payment_voucher_no`; the 6 failures set neither. Successes log
`payment.completed`, failures log only `payment.verification_uncertain`; no order has both.
Re-run `scripts/diagnose-mingle-cluster-discriminator-20260731.ts` to re-validate on new data.

## Recovery: an E04111 order can come back

Because E04111 is time-dependent, any order resolved or cancelled on this evidence may later
turn out to be paid. Two independent channels must therefore keep working after the fact:

- **Webhook** (`app/api/webhooks/paycloud/route.ts`) — the path that recovered #149, via
  `paycloud_webhook_fallback_finatic_verified`.
- **Reconcile** (`lib/payments/reconcile-orphan-payments.ts`) — sweeps sale `payment_events`
  whose orders are still unpaid, 48h lookback.

Both were repaired in PR 1 (see `lib/payments/e04111-recovery.ts`). Before that fix:

- the webhook path called `markOrderPaidConfirmed` with the default
  `CLAIMABLE_PAYMENT_STATUSES` (`['unpaid','pending']`), so a **cancelled** order matched zero
  rows, returned `claimed: false`, and the discarded result still produced a **200 ACK** —
  telling Finatic to stop retrying a payment we had just verified and thrown away;
- the reconcile path used a bulk update that set `payment_status`/`status` but left
  `cancelled_at` and `cancellation_reason` in place, producing a self-contradictory
  `completed` + `paid` + `cancellation_reason` row and alerting nobody.

Recovery is now scoped to orders carrying an `auto_cancelled_e04111*` reason only —
`auto_timeout`, `hosted_timeout` and staff cancellations are deliberately **not** revivable
from a webhook — and emits `payment.recovered_after_auto_cancel` at error severity, surfaced
as a critical alert by `computePlatformAlerts`.

## Root cause worth fixing separately

The POS/terminal client never sends `x-idempotency-key` though the server reads it
(`app/api/terminal/orders/route.ts`). Verified: **0 of 102** sampled Mingle POS orders carry
one. Each staff retry after a failed launch therefore creates a brand-new order rather than
reusing the existing one, which is why one failed sale becomes two or three stranded orders.
The POS client is a separate APK, not in this repo.

## Related

- `docs/finatic-questions-for-vernon.md` — the open questions with Finatic, incl. #149.
- `scripts/diagnose-mingle-pending-20260803.ts` — read-only checklist.
- `scripts/resolve-mingle-pending-20260803.ts` — gated manual resolution.
- `scripts/control-e04111-discriminator-20260803.ts`,
  `scripts/control-finatic-success-lookup-20260803.ts` — control probes.
