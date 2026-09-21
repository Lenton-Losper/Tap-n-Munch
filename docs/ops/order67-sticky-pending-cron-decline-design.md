# Staging order #67 sticky pending — cron / CRON_SECRET / decline design

**Status:** Investigation + design proposal only. No app/workflow implementation in this PR.  
**Order:** `#67` / `fc059012-2f97-4121-a170-dff1df3ad3a7` (staging), NAD 11.99, Finatic-UAT decline N003  
**Merchant order:** `FT17852482265916501`  
**Placed:** `2026-07-28T14:17:01.409Z` · attempt_started launch `14:17:07.093Z`  
**Date of this follow-up:** 2026-07-28  

Related: prior dump PR tooling on `cloudflare-staging` (`[investigate-uat-1199]`, `[probe-order67-cron]`).

---

## 1. Did `cleanup-stale-orders` actually fire for #67?

### Direct answer

**No — the staging Worker’s scheduled cron did not run the cleanup route during this window.**

Evidence (stronger than “we couldn’t find logs”):

| Check | Result |
| --- | --- |
| Cloudflare Worker secret list (`wrangler secret list` via staging CI token) | **`CRON_SECRET` is absent** from `flashtap-staging` secrets |
| GitHub secret `STAGING_CRON_SECRET` in Actions env | **Empty** (`stagingCronSecretEnvLength: 0`) |
| Every sampled successful staging deploy (incl. 09:35Z, 14:33Z) | Logs: `WARNING: STAGING_CRON_SECRET not set — expire-pending will reject all callers until configured` and **does not** run `wrangler secret put CRON_SECRET` |
| Worker code (`workers/flashtap-worker.ts` `scheduled()`) | If `env.CRON_SECRET` is missing → `console.error('[CRON] CRON_SECRET missing…; skipping cleanup-stale-orders')` and **return** — no call into the route |

So for the entire window from #67’s placement (~14:17 UTC) onward, Cloudflare Cron Triggers may still *tick* every 2 minutes (`wrangler.toml` `*/2 * * * *`), but each tick **silent-skips** before invoking `/api/cron/cleanup-stale-orders`.

### Observability logs caveat

This agent could not pull Cloudflare Observability/tail logs for the Worker (no CF log API session in this environment). The secret-list + deploy-warning + code path are conclusive enough: cleanup could not have run successfully without a `CRON_SECRET` binding.

Unauthenticated HTTP POST to the route returns `401 {"error":"Unauthorized"}` (route is mounted; auth gate works). Authenticated invoke was skipped because the Actions env also has no `STAGING_CRON_SECRET`.

### Ops implication

Set `STAGING_CRON_SECRET` in GitHub Actions secrets, redeploy staging (so `wrangler secret put CRON_SECRET` runs), then confirm Observability shows `[CRON] cleanup-stale-orders ok …` on subsequent ticks.

---

## 2. Would #67 land in `skippedUncertainIds` if cron *did* run?

### Direct answer

**Yes — when we simulated the cron’s Finatic path in CI, `#67` was in `skippedUncertainIds` and stayed pending.**

Simulated call (service-role, `autoCancelStalePosOrders({ restaurantId, verifyWithFinatic: true })`) at ~14:50 UTC:

```json
{
  "cancelledCount": 0,
  "cancelledIds": [],
  "correctedToPaidCount": 0,
  "correctedToPaidIds": [],
  "skippedUncertainCount": 2,
  "skippedUncertainIds": [
    "fc059012-2f97-4121-a170-dff1df3ad3a7",
    "0eed17f3-ed87-4ffd-a075-2d93686344e8"
  ]
}
```

```json
{
  "inSkipped": true,
  "inCancelled": false,
  "inCorrected": false
}
```

### Why uncertain (important nuance)

This was **not** a clean Finatic `paid:false` or a discriminator E04111 path. The skip reason logged was:

> `No Finatic credentials configured for restaurant`

for restaurant `a1999166-ddfa-40d1-ad1f-2f01282a1652` (staging test).

So for #67 specifically:

1. **`payment.attempt_started` is present** → cron will **not** take the `no_payment_attempt_made` shortcut (discriminator working as designed).
2. Finatic verify throws (here: missing restaurant credentials) → **`skippedUncertainIds`** → leave pending.
3. That matches the sticky-pending symptom **even if** cron had been firing.

On a restaurant that *does* have Finatic creds, a real N003 decline can still look uncertain if Finatic `order.query` returns **E04111** after `attempt_started`: staging tip code only treats E04111 as confident cancel when the attempt-started marker is **absent**. With the marker present, E04111 falls into the same skip/uncertain bucket. That is intentional for “maybe the gateway is lagging / weird,” but it also means a genuine decline that Finatic reports as E04111 will not auto-cancel via cron.

---

## 3. Correction: `status: 'failed'` on the backend is not “audit-only”

The terminal agent’s note that `status: 'failed'` only logs an audit with no state change is **out of date relative to current staging/main**.

Today `POST /api/terminal/orders/[orderId]/payment` with `status: 'failed'` already calls **`handleTerminalPaymentFailed`** (#635 pattern):

| Finatic / state | Outcome | Order change | Audit |
| --- | --- | --- | --- |
| No `paycloud_merchant_order_no` | cancel immediately | cancelled + `payment_declined` (default) | `payment.failed` |
| Finatic confirms **paid** | `corrected_to_paid` | paid | `payment.completed` |
| Finatic confirms **not paid** | cancel | cancelled + `payment_declined` | `payment.failed` with `finaticVerifiedBeforeCancel: true` |
| Finatic error / E04111 / missing creds | `left_pending_finatic_uncertain` | **no change** | **no audit** |

What #67’s DB shows (only `payment.attempt_started`, still pending, no `payment.failed`) is consistent with either:

- APK never successfully POSTed `status: 'failed'`, or  
- APK did POST failed, Finatic verify threw (e.g. missing restaurant Finatic creds / E04111), and the handler returned `left_pending_finatic_uncertain` **without writing an audit**.

That “no state change + no audit” uncertain path is the real gap — not a missing #635 hook.

---

## 4. Design proposal (no implementation yet)

### Question

Should a genuine device-reported decline cancel the order **synchronously** in the payment-failed endpoint (Finatic-verified), rather than waiting for cron?

### Recommendation

**Yes — keep/strengthen the synchronous path that already exists; do not rely on cron as the primary decline resolver.** Cron remains a safety net for silence/abandonment, not for “user just saw N003 on the PIN pad.”

### Safe synchronous flow (same guard family as #635)

Keep this as the contract for `POST .../payment` with `status: 'failed'` (and the status-route cancel path that already shares `handleTerminalPaymentFailed`):

```text
terminal reports failed
  │
  ├─ no paycloud_merchant_order_no
  │     → cancel immediately (nothing could have charged)
  │
  └─ merchant order present
        → Finatic order.query (restaurant creds)
              │
              ├─ paid        → markOrderPaidConfirmed (false-failure guard)  [#635]
              ├─ not paid    → cancel payment_declined + payment.failed audit
              ├─ E04111
              │     ├─ no attempt_started  → cancel no_payment_attempt_made (allocated-only)
              │     └─ attempt_started     → treat as “gateway has no success”
              │           → cancel payment_declined (device already reported failure)
              │           OR leave pending only if we lack confidence (see below)
              └─ network/5xx/creds missing
                    → leave pending + write payment.verify_uncertain audit
                    → cron retries (once CRON_SECRET is fixed)
```

### Why this is safe relative to #635

- The dangerous case is **cancelling a secretly successful charge**. That is prevented by the **paid → correct to paid** branch, which must stay mandatory whenever `paycloud_merchant_order_no` exists.
- A device-reported decline plus Finatic **not paid** is safe to cancel immediately.
- **E04111 after `attempt_started` + device-reported failed** is the policy choice: Finatic has no successful payment to protect. Prefer **cancel as `payment_declined`** on the synchronous path so the Sale tab does not stick pending for 13+ minutes. Cron can keep today’s more conservative “E04111 + attempt_started → skip” for *silent* stale orders where the device never reported failure.

### Concrete product rules to adopt

1. **Primary decline path = synchronous** in `handleTerminalPaymentFailed` (already wired). APK must always POST `status: 'failed'` (or status cancel) after N003 / non-success WiseCashier results — including Try again flows.
2. **Always audit uncertain outcomes** (`payment.verify_uncertain` or similar) with Finatic error class, so sticky-pending is visible without guessing.
3. **Cron is backup**, not the decline UX. Still requires `CRON_SECRET` on staging/production Workers.
4. **Staging restaurant Finatic credentials** must exist for any restaurant used for real UAT card tests; otherwise both sync and cron verify paths will skip forever (`No Finatic credentials configured for restaurant`). Global Worker `PAYCLOUD_*` secrets are not a substitute for `getRestaurantFinaticCredentials`.
5. Optional later: map terminal decline codes (N003, etc.) into audit metadata for support — does not change cancel safety.

### What we are explicitly *not* proposing here

- Blind cancel on terminal `failed` without Finatic when a merchant order number exists (re-opens #635).
- Making cron the only resolver for interactive declines.
- Implementing the E04111-after-attempt_started policy change in this doc PR.

### Suggested adoption order (when approved)

1. Ops: set `STAGING_CRON_SECRET`, redeploy, verify cron logs.  
2. Confirm staging-test restaurant has Finatic UAT merchant/store nos.  
3. Confirm APK always hits payment-failed after N003.  
4. Small code follow-up: audit on `left_pending_finatic_uncertain`; optionally cancel on E04111 when `attempt_started` **and** the caller is a terminal-reported failure (not silent cron).

---

## 5. Order #67 snapshot (still true at ~14:50 UTC recheck)

```json
{
  "id": "fc059012-2f97-4121-a170-dff1df3ad3a7",
  "order_number": 67,
  "total": 11.99,
  "status": "pending",
  "payment_status": "pending",
  "cancellation_reason": null,
  "cancelled_at": null,
  "paycloud_merchant_order_no": "FT17852482265916501",
  "placed_at": "2026-07-28T14:17:01.409+00:00"
}
```

Only audit:

```json
{
  "action": "payment.attempt_started",
  "metadata": {
    "source": "terminal_app",
    "appVersion": "1.71",
    "launchedAt": "2026-07-28T14:17:07.093Z",
    "businessOrderNo": "FT17852482265916501"
  },
  "created_at": "2026-07-28T14:17:07.895871+00:00"
}
```
