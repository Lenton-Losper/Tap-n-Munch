# PayCloud / Finatic webhook signature — five-hypothesis isolation report

**Status:** Findings only — no production changes, no secret rotation, no deploy.  
**Date:** 2026-07-28  
**Branch tip when run:** `d563c47` (main) + this report  
**Repro:** `npx tsx scripts/investigate-paycloud-signature-isolation.ts`  
**Raw output:** `artifacts/paycloud-signature-isolation-run.txt`

---

## Verdict (all five)

| # | Hypothesis | Result | Blocks after correct key? |
|---|------------|--------|---------------------------|
| 1 | Encoding / format mismatch | **PASS (ruled out as primary)** | No — whitespace/CRLF tolerated; PKCS#1 still verifies under forge |
| 2 | Signing algorithm / base64url mismatch | **PASS (ruled out)** | No — RSA2/SHA256 correct; verify accepts both encodings |
| 3 | Sandbox vs live different gateway keys | **PASS (evidence against)** | Unlikely — same `ad7ccabe…` fingerprint worked on both endpoints |
| 4 | Verification code bug (independent of key) | **PASS (code OK)** | No — synthetic roundtrip works; verifies JSON root |
| 5 | Clock/replay bundled with signature check | **PASS (ruled out)** | No — no skew window on verify path |

**Net:** Nothing in these five checks explains `Encryption block is invalid.` except a **wrong RSA public key** (or truncation that yields a different ASN.1 error). Getting the correct Finatic gateway public key remains the blocker; these side causes will not keep you blocked once that key is correct.

---

## 1. Encoding / format mismatch — PASS (not the failure mode)

### What the code expects

`loadGatewayPublicKey()` → `normalizePublicKeyMaterialToPem(PAYCLOUD_GATEWAY_PUBLIC_KEY)`:

1. `extractPemBase64Body` strips `BEGIN/END` labels, all whitespace, and literal `\n` / `\r`
2. Re-wraps as `-----BEGIN PUBLIC KEY-----` (SPKI / PKCS#8 public)

`verifyPayloadSignature` then calls `forge.pki.publicKeyFromPem(publicKey)`.

### Empirical results

| Input form | Result |
|------------|--------|
| Full SPKI PEM | verify `true` |
| Bare base64 SPKI body | verify `true` after normalize |
| One-line env with literal `\n` | verify `true` |
| Whitespace / tabs mid-body | verify `true` (stripped) |
| CRLF line endings | verify `true` |
| PKCS#1 `BEGIN RSA PUBLIC KEY` PEM (direct) | verify `true` (forge lenient) |
| PKCS#1 body wrongly wrapped as `BEGIN PUBLIC KEY` | verify `true` under forge; **Node `createPublicKey` rejects** |
| Wrong RSA public key | throws **`Encryption block is invalid.`** |
| Truncated key body (−20 chars) | throws **`Too few bytes to read ASN.1 value.`** |
| Garbage short `sign` (`AAAA`) | throws **`Encrypted message length is invalid.`** |
| Valid key, wrong signature (same length) | returns `false` (no throw) |

### Whitespace / line-ending corruption (requested test)

**Whitespace/line-ending alone does not fail** — so it cannot produce a distinguishable error vs `Encryption block is invalid.`  
Truncation **does** produce a different error (`Too few bytes to read ASN.1 value.`).  
Single-character base64 corruption can still land on `Encryption block is invalid.` (wrong modulus after parse).

### PKCS#1 vs PKCS#8

Code does **not** detect/convert PKCS#1 → SPKI. It always wraps as `PUBLIC KEY`.  
Forge still accepts PKCS#1 material for verify. **PKCS#1-vs-SPKI encoding is not a plausible cause of the live webhook failure.**

---

## 2. Signing algorithm mismatch — PASS (ruled out)

### RSA2 / SHA256

Both sign and verify use `forge.md.sha256.create()` (PKCS#1 v1.5).  
Empirical: SHA-256 signature verifies; a deliberately SHA-1-signed blob returns `ok: false` under the same verify path.

### `PAYCLOUD_SIGNATURE_BASE64URL=false` on verify

| Path | Respects env flag? |
|------|-------------------|
| Outbound `formatPaycloudRequestSignature` | **Yes** — `false` → standard base64; `true` → base64url |
| Inbound `normalizeSignatureForVerify` | **No** — if `sign` contains `-` or `_`, always decoded as base64url |

So `PAYCLOUD_SIGNATURE_BASE64URL=false` **cannot** cause inbound verify failures for base64url Finatic signatures.

### Verify call sites (all use `verifyPayloadSignature` → same normalize)

1. `payments/webhook.js` → `verifyWebhook` (fail-closed)
2. `payments/paycloud.js` checkout response (best-effort try/catch)
3. `payments/paycloud.js` order.query response (best-effort try/catch)
4. `payments/signature.js` `runLocalSignVerifySelfTest`

---

## 3. Sandbox vs live key/endpoint scope — PASS (evidence against different gateway keys)

### Historical live-test logs (decoded UTF-16 `.tmp-*-live-*.txt`)

| When | Endpoint | App | Configured gateway fp | Derived (app) fp | STEP4 |
|------|----------|-----|----------------------|------------------|-------|
| 2026-03-27 | `open.finatic.africa` (live) | `wz6***fb5` | **`ad7ccabe…b4d47e`** | `fe8000ae…` | **`ok: true`** |
| 2026-03-30 | `wiseasy-open.sg.wisepaycloud.com` (sandbox) | `wz7***156` | **`ad7ccabe…b4d47e`** | `f099f80c…` | **`ok: true`** |
| 2026-03-31 | live | `wz6***fb5` | `fe8000ae…` (= derived) | `fe8000ae…` | **`ok: false`** |

**Same gateway fingerprint verified Finatic responses on both sandbox and live.**  
Sandbox used different `app_id` / `merchant_no` / `store_no`, but **not** a different gateway public key in these runs.

When configured was forced to equal derived (merchant/app public), STEP4 failed — same class of mistake as production today (`1e5dcffc…` configured === derived).

### March 27 “RSA Key Pair” email / April 2 sandbox results

**Not present** in this workspace/git as email bodies or dedicated April 2 artifacts. Only the `.tmp` live-test logs above.

### Vercel / Cloudflare env matrix

**Did not finish** in this agent environment:

- No `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`
- `wrangler whoami` → not authenticated
- `gh secret list` → HTTP 403

Script ready for a credentialed run: `scripts/investigate-paycloud-env-matrix.ts` (fingerprints only; CF secret **values** are not readable after set).

Prior KEYDIAG (incident #84): production configured gateway fingerprint **`1e5dcffc…` = derived from private** (wrong key type), not `ad7ccabe…`.

---

## 4. Verification code bug independent of the key — PASS (code OK)

### Synthetic keypair roundtrip

Generated local RSA-2048 keypair (not Finatic).  
`signPayload(private)` → `verifyPayloadSignature(public)` → **`true`**.  
Isolates **bad key** from **bad code**.

### Payload structure vs FT178515 / dashboard nesting

- Webhook route: `JSON.parse(rawBody)` → `verifyWebhook(rawBody, payload)` → `verifyPayloadSignature(parsedBody, …)` on the **HTTP JSON root**.
- Flat notify-like object with matching `sign` → webhook RSA **`ok: true`**.
- Nested dashboard shape `{ root: { request: { notify_data: … } } }` with inner signature → webhook **`Invalid RSA signature`** (returns false, does **not** throw `Encryption block is invalid.`).

**FT178515 raw signed HTTP body is still not in this environment** (PR #84). Cannot byte-replay that notify.  
Historical Finatic **checkout** responses that STEP4 verified were flat JSON roots with a `sign` field — consistent with verifying the HTTP root, not the dashboard `notify_data` nesting.

Wrong payload shape → `false` / `Invalid RSA signature`, **not** `Encryption block is invalid.` (that throw is wrong-key / decrypt).

---

## 5. Clock / timestamp validation — PASS (ruled out)

- `verifyPayloadSignature` / `verifyWebhook` / `app/api/webhooks/paycloud/route.ts`: **no** replay window, skew check, or `PAYCLOUD_CLOCK_OFFSET_MS`.
- `PAYCLOUD_CLOCK_OFFSET_MS` only adjusts **outbound** request timestamps in `payments/paycloud.js`.
- Ancient `timestamp: 1` still verifies when the signature matches the canonical string.
- Mutating `timestamp` after sign fails canonical verify (`ok: false`), not via a separate clock gate.

Clock cannot produce `Encryption block is invalid.`

---

## Bottom line

1. **Code path is sound** for RSA2, encoding flexibility, and synthetic verify.  
2. **Side hypotheses (format, algo, base64url flag, clock, nested dashboard shape) do not produce the observed forge error.**  
3. **Observed error remains the wrong-public-key signature** — production gateway key fingerprint matches merchant private (see #84 / #86).  
4. **Sandbox vs live:** historical evidence says **one** gateway fingerprint worked on both; rotate to Finatic’s current gateway public and confirm fingerprint ≠ derived-from-private.  
5. **Still needed from humans:** Finatic gateway public key bytes; optional Vercel env matrix with tokens; optional FT178515 raw notify paste for byte replay.
