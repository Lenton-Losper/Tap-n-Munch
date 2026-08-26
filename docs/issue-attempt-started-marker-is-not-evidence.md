# `payment.attempt_started` is not evidence, and must never gate a cancel

**Status:** open. Blocks any rule that treats marker absence as "no payment was attempted".
**Measured:** 2026-08-04, production (`ihlmmpmolnpchzgwyhgh`), read-only.

> ## Correction, 2026-08-26 (#158)
>
> **Everything below the "Claim" heading is a 2026-08-04 measurement and is preserved as one. One
> sentence of it is now false and one conclusion has to change.**
>
> **False:** "`payment.attempt_started` has never been written in production." It has, since
> 2026-08-06 — the day after the branch this document blocked was removed. Re-measured on
> production 2026-08-26: **1,009 rows, exactly one per order**, across four venues, every one
> `source: 'terminal_app'` from APK 1.75 / 1.78 / 1.85 / 1.89 / 1.97. The endpoint is live and
> terminals call it. The "0 of 496 paid orders carry it" table below describes a window that
> closed; today 893 of 945 paid POS orders (94.5%) carry one.
>
> **Still true, and now the load-bearing reason:** absence proves nothing about the world.
> `notifyPaymentAttemptStarted` races a 2 s timeout, swallows every failure, and `launchPayment`
> is started first — a card can be charged with no marker ever written. That is a property of the
> design, not of the adoption rate, so no amount of rollout retires it. **The rule at the bottom of
> this document stands unchanged.**
>
> **What has to change:** the recommendation that presence may safely *spare* an order. That was
> offered on the reasoning that the asymmetry would become usable once the marker was adopted.
> Adoption arrived and the asymmetry did not, because the marker turns out not to discriminate at
> all. POS orders placed on/after 2026-08-06 carry it: **paid 94.5% (893/945), cancelled 74.3%
> (107/144), stale-pending backlog 100% (7/7)**. It is *more* common on stuck orders than on paid
> ones. A spare-gate built on it would spare 7 of the 7 orders currently stuck and change nothing.
> **Do not build it.**
>
> The marker keeps its place for a different reason: `orders.payment_attempt_started_at` is the
> only payment-duration telemetry that exists, and #158 used it to replace the ~57 s median this
> repo previously had to take on faith (real measured p50 is 14.9 s over 894 settled payments).

## Claim

**Marker absence proves nothing.** `payment.attempt_started` has never been written in
production, and even once the plumbing exists it is lossy by design. Any auto-cancel rule
gated on `!attemptStarted` degrades to an unguarded cancel. This document is the proof.

## The measurement

```
payment.attempt_started audit rows (30d)      : 0
payment.attempt_started audit rows (ALL TIME) : 0

PAID POS orders with a reference (30d)        : 496   <- a WiseCashier launch definitely
  ...carrying the marker                      : 0       happened for every one of these
                                                (0.0%)

  FNB ChowNow           paid=384  marked=0  coverage=0.0%
  Mingle Brew & Pour    paid=112  marked=0  coverage=0.0%

PENDING POS orders with a reference (30d)     : 4
  ...marker-less                              : 4  (100%)
```

496 orders that were paid — so the terminal certainly launched WiseCashier and Finatic
certainly charged the card — carry no marker. Not a low coverage rate: **zero, all time.**

Staging has 4 rows all time, consistent with `scripts/probe-attempt-started-http-staging.ts`
rather than real traffic.

## Three independent reasons, each sufficient on its own

**1. The endpoint does not exist in production.**
`app/api/terminal/orders/[orderId]/attempt-started/route.ts` and
`lib/payments/mark-payment-attempt-started.ts` exist only on `cloudflare-staging`. They are
absent from `main`, and `.github/workflows/production-worker.yml` hard-fails any deploy whose
ref is not `refs/heads/main`. A perfectly correct APK would receive a 404.

**2. The live APK predates the feature.**
Live terminals run versionCode 70. In `C:\RN\FlashTapTerminal`, `notifyPaymentAttemptStarted`
was introduced by commit `10ac28f` ("hold-for-signoff: PR89 attempt-started …"), whose parent
contains zero references to it — and that same commit bumped `versionCode` **60 → 73**. No
commit reachable from any of the 8 local/remote branches sets versionCode 70, so vc=70's exact
tree is unrecoverable and cannot be read directly. But every reachable state numbered below 73
lacks the feature entirely. For vc=70 to have shipped it, someone would have had to build
PR89's code under a lower version number than the commit that introduced it. Nothing supports
that.

**3. Even once deployed, it is lossy by design — correctly so.**
`src/lib/payment.ts:110-153`:

```ts
const ATTEMPT_STARTED_TIMEOUT_MS = 2000;

async function notifyPaymentAttemptStarted(...) {
  try {
    const result = await Promise.race([ markTerminalPaymentAttemptStarted(...), /* 2s reject */ ]);
    ...
  } catch (err) {
    console.warn('[payment] attempt-started failed (payment continues)', ...);
  }
}
```

It *is* awaited (`payment.ts:259`) — this is not the unawaited-`recordSaleEvent` bug. But it
races a 2-second timeout and swallows every failure, and `launchPayment` is started **first**
(`:253`), so WiseCashier is already launching when the marker call runs. A Cloudflare Worker
cold start over 2s silently drops the marker while the card is being charged.

That behaviour is *right for payments* — a telemetry write must never block or fail a charge —
and exactly *wrong as evidence*. The two requirements are irreconcilable: you cannot have a
marker that never obstructs a payment and also treat its absence as proof.

Coverage is not the weak point: both card paths go through `processPaymentIntent`
(`PaymentScreen.tsx:457` single order, `TableDetailScreen.tsx:251` tab settle).

## Consequence for the auto-cancel rule

The branch on `cloudflare-staging` cancels when Finatic answers E04111 **and** no marker
exists:

```ts
if (isFinaticMerchantOrderInvalidError(err) && !attemptStartedIds.has(orderId)) {
  cancelByIds(supabase, [orderId], 'no_payment_attempt_made')
}
```

In production today `attemptStartedIds` would be empty for 100% of orders, so the gate is
always true and the rule collapses to **`E04111 → cancel` on a single observation**. Given
that E04111 is time-dependent — order #149 returned E04111 and was confirmed paid on the same
reference 22 seconds later — that is a mass-cancel of real payments.

Staging check, 2026-08-04: **0 orders have ever been cancelled as `no_payment_attempt_made`**,
so the rule has not yet done damage. It has simply never had traffic that reached it.

## Rules going forward

1. **Marker absence must never gate a cancel.** Not as the sole gate, not as one of several.
   It carries no information.
2. **Marker presence is sound as a one-way guard.** A recorded marker proves a launch happened,
   so it may be used to *spare* an order from cancellation — never to authorise one. That
   asymmetry is safe and costs nothing.
3. Persistence across many observations, plus a same-run control probe, plus a volume circuit
   breaker must carry the cancel decision on their own
   (see `docs/issue-e04111-cron-permanent-stuck-class.md`).

## To make the marker meaningful later (none of this is required for PR 2)

- Land the endpoint and `markPaymentAttemptStarted` on `main` so production has them at all.
- Ship an APK ≥ vc73 to every live terminal and confirm the rollout, per terminal.
- Only then measure real coverage over a sustained window. Even a good number would justify
  rule 2 above, never rule 1.
- Consider recording the marker **server-side** in `prepare-payment`, which already runs
  before the launch and is not subject to a device-side timeout. That would be evidence the
  device cannot drop — though it proves "we were about to launch", not "we launched".

## Reproduce

- Production coverage: the queries in this document, service-role read-only against
  `orders` + `audit_logs`; join paid POS orders having `paycloud_merchant_order_no` against
  `audit_logs.action = 'payment.attempt_started'`.
- APK: `C:\RN\FlashTapTerminal`, `git log -L 98,99:android/app/build.gradle`,
  `git show 10ac28f -- src/lib/payment.ts`.
