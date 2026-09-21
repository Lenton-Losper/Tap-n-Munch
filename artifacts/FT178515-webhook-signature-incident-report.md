# Incident report: Finatic webhook “Encryption block is invalid” (FT17851560177204384)

**Status:** Findings only — no key rotate, no deploy, no reconciliation writes performed.  
**Date investigated:** 2026-07-28  
**Restaurant:** FNB ChowNow (`b161c758-582d-4dfa-839a-9fa35c492a49`)  
**Merchant order:** `FT17851560177204384`

---

## 1. Current state of this specific order

**Cron corrected it to paid.** It is not stuck.

| Field | Value |
|--------|--------|
| FlashTap order id | `a399582d-3998-48ef-b8e4-471067e64b87` |
| Order # | **631** |
| `paycloud_merchant_order_no` | `FT17851560177204384` |
| `total` / Finatic paid | **43** |
| `placed_at` | `2026-07-27T12:40:15.36Z` (matches Finatic ~12:40:25) |
| `paid_at` | `2026-07-27T18:42:12.281Z` (**~6h 2m later**) |
| `status` / `payment_status` | `completed` / `paid` |
| Receipt | `RCT-000517` issued `2026-07-27T18:42:18.52Z` |

### Audit trail (real row)

```json
{
  "action": "payment.completed",
  "entity_id": "a399582d-3998-48ef-b8e4-471067e64b87",
  "created_at": "2026-07-27T18:42:16.856152+00:00",
  "metadata": {
    "amount": 43,
    "source": "auto_cancel_cron_finatic_verified",
    "reference": "FT17851560177204384",
    "voucherNo": "07271842161695078712",
    "businessOrderNo": "FT17851560177204384",
    "correctionReason": "Order hit the stale-POS timeout with no confirmed terminal callback, but Finatic confirmed a successful payment before cancellation -- corrected instead of cancelled."
  }
}
```

**Interpretation:** Webhook path never reconciled this payment. After `f8b2bd8` (order.query verify guard) shipped to production (`workflow_dispatch` deploy `2026-07-27T18:33:08Z`), the stale-POS cron’s Finatic order-query path confirmed `trans_status=2` and marked the order paid at ~18:42Z.

---

## 2. Signature failure — exact underlying error

### What Finatic saw vs what our code returns

Webhook handler (`payments/webhook.js` → `verifyPayloadSignature`):

- forge throw is **caught**
- HTTP **401** with `{ error: <forge message> }`
- Finatic classifies non-success ACK as **SYS500** / delivery failure (same pattern as earlier ack-format SYS500 work)

### Exact node-forge error (not just the wrapper)

Local reproduction against **`verifyPayloadSignature` / `verifyWebhook`**:

| Input | Result |
|--------|--------|
| Finatic-signed payload + **wrong** RSA public key | **`Encryption block is invalid.`** |
| Garbage short `sign` (`AAAA`) | `Encrypted message length is invalid.` |

Live probes (staging + production webhook, garbage `sign`):

```text
{"error":"Encrypted message length is invalid."}
```

That matches garbage-signature probes. Finatic’s dashboard message for this incident is the **wrong-key** message: **`Encryption block is invalid.`**

### Real Finatic-signed body (historical checkout error response in repo `.tmp-test-payment-live-output.txt`)

Verified locally with the UAT/app public key from `check-uat-keypair-match.js` (i.e. merchant-side public, **not** Finatic gateway):

```text
verify with UAT app public THREW → "Encryption block is invalid."
verifyWebhook result { ok: false, reason: 'Encryption block is invalid.' }
```

So the raw forge error Finatic would have received in the 401 body is literally:

```text
Encryption block is invalid.
```

### Gap: this incident’s raw `notify_data`

The Finatic delivery log for **FT178515** was summarized in chat but the **full signed notify JSON was not pasted** into the agent environment. Prior Finatic dashboard pastes for other orders often omit `sign` in the “notify_data” panel (sign may be on the HTTP envelope). Re-running verify on **that exact** notify body still needs the raw delivery payload (or Worker logs of the 401).

Evidence that production webhook verify fails the same way on real Finatic RSA signatures does **not** depend on that paste:

1. Same code path + same env key as order.query response verify  
2. `f8b2bd8` already traced live production order.query bodies throwing **`Encryption block is invalid`** under `PAYCLOUD_GATEWAY_PUBLIC_KEY`  
3. Local forge confirms that exact string is the wrong-public-key failure mode  

---

## 3. Root cause

### Primary: `PAYCLOUD_GATEWAY_PUBLIC_KEY` is the wrong key (merchant/app public, not Finatic gateway public)

`CREDENTIALS_SETUP.md` / `ENVIRONMENT_SETUP.md`: gateway public key = **PayCloud/Finatic gateway** RSA public key (used to verify **Finatic-signed** responses/webhooks).

Outbound signing uses `PAYCLOUD_PRIVATE_KEY` (merchant key). The matching public for that private is **not** what Finatic uses to sign notifies.

**Smoking gun from local KEYDIAG** (dotenv `.env.local` in prior sessions):

```text
derived_public_fingerprint_sha256= 1e5dcffc7f814c75e6cab7f1ab348879206956f555807998178a53ec95db2783
configured_public_fingerprint_sha256= 1e5dcffc7f814c75e6cab7f1ab348879206956f555807998178a53ec95db2783
fingerprints_match= true
```

When `configured === derived`, `PAYCLOUD_GATEWAY_PUBLIC_KEY` is the **public half of our private key**. Verifying Finatic signatures with that key produces forge **`Encryption block is invalid.`** — exactly what Finatic logged 16+ times.

Code already treats this as known mismatch (best-effort ignore on checkout/query):

```text
// Response RSA verify is best-effort only (Finatic key mismatch must not block ...)
```

Webhook is **fail-closed** (correct for security) → Finatic retries until max → payment never reconciles on the intended path.

### Not the primary cause (this incident)

| Hypothesis | Finding |
|------------|---------|
| `cut -d= -f2` env truncation | No evidence in this investigation. Truncation more often yields **length** errors; Finatic’s message matches **wrong RSA key**. |
| Missing `sign` only | Would return `Missing webhook signature`, not Encryption block. |
| Payload canonicalization alone | Would typically return `ok: false` / `Invalid RSA signature` without throwing; forge throw ⇒ RSA block decrypt with wrong modulus. |

### Historical fingerprint that may be the real gateway key

Older live test logs (`.tmp-test-payment-live-output.txt`, merchant `342600032359`) had:

```text
derived= fe8000ae...
configured= ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e
```

That **mismatched** pair is what you want for gateway verify (configured = Finatic, derived = us). Later logs show operators “fixed” match by setting configured = derived — which **breaks inbound verify**.

**Action for fix decision:** Obtain Finatic’s official gateway public key for app_id / ChowNow merchant (`342600131153` / store `4426015803`), fingerprint it, compare to Worker secret + `.env.local`. Do **not** set gateway public = app public.

### `.env.local` vs Worker secrets byte-for-byte

This cloud environment has **no** `.env.local` / Cloudflare secret read access (`PAYCLOUD_*` are Worker secrets, not GitHub Actions secrets). Cannot confirm Worker fingerprint equals desktop `.env.local` from here. Both staging and production webhooks accept the verify path (configured key present); both fail closed on bad/wrong signatures.

---

## 4. Scope — other affected payments

### No durable “Encryption block” rows in DB

Webhook rejects do **not** write `audit_logs`. Scope is inferred from reconciliation backfills + cancelled-with-MO leftovers. Cloudflare Worker request logs were not available to this agent.

### Cron rescues after order.query guard (`auto_cancel_cron_finatic_verified`)

**15 orders**, all FNB ChowNow, all corrected in one batch `2026-07-27T18:41:41Z`–`18:42:16Z` (minutes after production deploy `18:33Z`):

| Order # | Merchant order | Amount | Delay (placed → paid) |
|--------:|----------------|-------:|----------------------:|
| 593 | FT17851489600499103 | 130 | ~479 min |
| 595 | FT17851498809509823 | 20 | ~464 min |
| 596 | FT17851500460458165 | 25 | ~461 min |
| 597 | FT17851504171779370 | 90 | ~455 min |
| 598 | FT17851504640572805 | 90 | ~454 min |
| 600 | FT17851505762206984 | 90 | ~452 min |
| 601 | FT17851506524553179 | 125 | ~451 min |
| 602 | FT17851507074353315 | 125 | ~450 min |
| 603 | FT17851508662728181 | 90 | ~448 min |
| 604 | FT17851509079883854 | 100 | ~447 min |
| 610 | FT17851515202821245 | 90 | ~437 min |
| 616 | FT17851525372106345 | 52 | ~420 min |
| 618 | FT17851526406132904 | 25 | ~418 min |
| 626 | FT17851533072433770 | 35 | ~407 min |
| **631** | **FT17851560177204384** | **43** | **~362 min** |

These are real Finatic-paid sales that the **webhook path failed to reconcile** (and that order.query could not rescue until `f8b2bd8`). Money was collected; FlashTap lagged hours.

### Jul 27 ChowNow payment.completed sources

| Source | Count |
|--------|------:|
| `terminal_callback` | 28 |
| `auto_cancel_cron_finatic_verified` | 15 |
| (missing / legacy metadata) | 3 |

There is **no** `paycloud_webhook` audit source — the webhook route updates `payment_status` directly and does **not** call `markOrderPaidConfirmed`, so successful webhooks would not appear in this breakdown either. Given fail-closed verify + Finatic’s terminated retries, treat webhook as **broken for RSA-signed notifies** until the gateway public key is corrected.

### Still cancelled with MO set (Jul 27 ChowNow) — Finatic said not paid (or cancelled before rescue)

Cron cancelled these in the same run (or earlier) rather than correcting — i.e. order.query did **not** report paid. Still worth a Finatic dashboard spot-check for large amounts:

| Order # | MO | Total | Notes |
|--------:|----|------:|-------|
| 629 | FT17851539382574245 | 71 | cancelled 18:42Z same batch |
| 599 | FT17851505036358727 | 90 | cancelled 18:41Z |
| 592 | FT17851488156961056 | **245** | cancelled 18:41Z — priority spot-check |
| 582 | FT17851310694003401 | 46 | cancelled earlier 05:57Z |

### How far back

- Documented gateway-verify mismatch in code/comments and `f8b2bd8` (order.query) — systemic, not one order.  
- Cron backfill visible for **2026-07-27** afternoon backlog once query path worked.  
- Older ChowNow `payment.completed` rows often lack `source` (pre-`markOrderPaidConfirmed`); silent webhook failures before that are harder to count without Finatic delivery logs / Worker logs.

---

## 5. Recommendations (decision only — not executed)

1. **Replace `PAYCLOUD_GATEWAY_PUBLIC_KEY`** in production + staging Worker secrets (and `.env.local`) with Finatic’s **gateway** public key for this app_id/merchant. Confirm fingerprint **≠** `derived_from_private`. Candidate historical fingerprint to validate against Finatic docs/portal: `ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e`.  
2. After rotate: replay one real Finatic-signed notify (or order.query response) through `verifyPayloadSignature` — expect `ok: true`, no throw.  
3. **Manual Finatic check** on cancelled MO list above (especially #592 N$245).  
4. Optional: paste FT178515 raw notify (with `sign` / headers) for byte-for-byte confirm; optional: Worker log pull for `Signature rejected: Encryption block is invalid`.  
5. Consider webhook writing `markOrderPaidConfirmed({ source: 'paycloud_webhook' })` so future incidents are auditable (separate change).  
6. Security note (separate): `scripts/fixRLS.ts` contains a hardcoded production service-role JWT — rotate/remove when convenient.

---

## 6. Bottom line

| Question | Answer |
|----------|--------|
| Is FT178515 stuck? | **No** — paid via **`auto_cancel_cron_finatic_verified`** at 18:42Z; receipt **RCT-000517**. |
| Did webhook work? | **No** — Finatic exhausted retries with Encryption block / SYS500. |
| Exact forge error? | **`Encryption block is invalid.`** (wrong RSA public key). |
| Root cause? | **`PAYCLOUD_GATEWAY_PUBLIC_KEY` set to merchant/app public (matches private), not Finatic gateway public.** |
| Scope? | At least **15** ChowNow paid sales cron-rescued the same evening; webhook path systemically broken for RSA notifies until key fixed. |
| Deploy/rotate done? | **None** (per request). |
