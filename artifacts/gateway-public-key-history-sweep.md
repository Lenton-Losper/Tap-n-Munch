# Investigation: Is Finatic’s gateway public key already in our history?

**Mode:** Report only — no code/secret/deploy changes.  
**Date:** 2026-07-28  
**Base:** `main` @ `7182fa8` (pulled fresh)

---

## Verdict

**No recoverable candidate key material exists in git history, docs, or this environment that we can wire in.**

We **do** have strong evidence that a **different** configured key once worked:

| Item | Finding |
|------|---------|
| Historical fingerprint | `ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e` |
| Where it appears | Only as a **fingerprint string** in local test **log files** (`.tmp-*-live-*.txt`), never as the PEM/base64 body |
| Provenance | Local `PAYCLOUD_GATEWAY_PUBLIC_KEY` on a developer machine during live PayCloud tests, **2026-03-27** and **2026-03-30** |
| Did it verify Finatic? | **Yes** — `test-payment-live.js` STEP4 (`verifyPayloadSignature` on real Finatic checkout HTTP body) returned **`"ok": true`** while that fingerprint was configured |
| Can we recover the key bytes? | **No** — not in any git blob, committed env, Postman, README, or agent transcript |
| FT178515 notify re-test | **Blocked** — raw signed notify still not in this environment; and without the `ad7ccabe` body there is nothing to test |

**Conclusion for Finatic outreach:** Treat the correct gateway public key as **external**. Ask Finatic / copy `gateway_rsa_public_key` from the merchant portal. Optionally also search **local machine backups** of `.env` / `.env.local` from ~Mar 27–30 2026 (outside this repo) for a value whose SPKI sha256 is `ad7ccabe…b4d47e`.

---

## 1. Full git history sweep — `PAYCLOUD_GATEWAY_PUBLIC_KEY`

### What was searched

- `git log -S` / `-G` / `git grep` across **all commits** for `PAYCLOUD_GATEWAY_PUBLIC_KEY`
- Historical committed env files (`.env.production`, `.env.staging` at `085bb68`)
- Working-tree `.tmp*` live-test logs, docs, scripts, Postman-like assets
- Agent transcripts / agent-tools under `/tmp/cursor` and project agent-tools

### What git actually contains

| Source | Value |
|--------|--------|
| `CREDENTIALS_SETUP.md` (since `b51f42e`, 2026-03-28) | `PAYCLOUD_GATEWAY_PUBLIC_KEY=` **empty placeholder** |
| `ENVIRONMENT_SETUP.md` | Name + description only (“Gateway RSA public key…”) |
| Early `payments` code (`7a87a78`) | Placeholder `PASTE_PAYCLOUD_GATEWAY_PUBLIC_KEY_HERE` — not a real key |
| `.env.production` / `.env.staging` (`085bb68`) | **No PayCloud keys at all** (only app URL + Supabase anon) |
| `.gitignore` | `.env`, `.env.*`, `.env*.local` — secrets intentionally never committed |
| Any `PAYCLOUD_GATEWAY_PUBLIC_KEY=MII…` in history | **Zero hits** |

**Only committed public key body in the whole repo:** UAT app public in `check-uat-keypair-match.js`  
(`…qmGBa23VxYTr…`, fingerprint `f099f80cab1acf93320a8fe294ce2b41eaa87de2b77606ec9aaa7366cef4f1e8`) — this is the **merchant/app** public half, not Finatic’s gateway key.

---

## 2. The `ad7ccabe…b4d47e` candidate — where / when / what we know

### Chronology from committed live-test logs

| When (from log timestamps) | File(s) | `derived` (from private) | `configured` (GATEWAY_PUBLIC) | Match? | STEP4 verify Finatic `sign` |
|----------------------------|---------|--------------------------|-------------------------------|--------|------------------------------|
| **2026-03-27** | `.tmp-test-payment-live-output.txt` | `fe8000ae…` | **`ad7ccabe…b4d47e`** | **No** | **`ok: true`** |
| **2026-03-30** | `.tmp-paycloud-test-live-output.txt`, `.tmp-test-payment-live-after-receipt.txt` | `f099f80c…` (UAT private) | **`ad7ccabe…b4d47e`** | **No** | **`ok: true`** |
| **2026-03-31** | `.tmp-live-full-output*.txt`, `.tmp-sign-enforce-test.txt`, `.tmp-live-mixed-checkout.txt` | `fe8000ae…` | `fe8000ae…` (same) | **Yes** | **`ok: false`** |

Context on the successful runs: endpoint `https://open.finatic.africa/api/entry`, app `wz6***fb5`, merchant `342***359`, store `442***791`.

### Interpretation

1. In late March, local env had a **real third-party gateway public** (`ad7ccabe…`) that **successfully verified Finatic response signatures**.
2. By Mar 31, that was replaced with the **app public** (fingerprints forced to match) — STEP4 immediately started failing. That is the same class of misconfiguration we see in production today (`configured === derived`).
3. Logs only ever print **fingerprints**, never the key body (`get-my-public-key.js` / KEYDIAG print derived/app material, not gateway PEM).

### What we do **not** have

- The PEM/base64 for fingerprint `ad7ccabe…b4d47e`
- Any truncated/corrupt partial of that key in git
- That fingerprint in Cloudflare/GitHub secrets (unreadable from this agent; and even if present as wrong current value, we cannot extract historical Worker secret versions here)

---

## 3. Docs / onboarding / Postman

| Check | Result |
|-------|--------|
| Repo docs mentioning “gateway public key” | Setup checklists only; **no Finatic key pasted** |
| Postman collections | **None** found |
| Wiseasy/Finatic SDK tree (`.tmp-wise-php-demo`) | **Empty directory** |
| External PayCloud docs (credential exchange) | Platform provides a **Public Key** out-of-band (email / merchant portal `gateway_rsa_public_key`). Readme example key fingerprints to `51db92ce…` — **not** `ad7ccabe` (docs sample only) |

---

## 4. Formatting / `cut -d=` truncation?

| Check | Result |
|-------|--------|
| Truncated `PAYCLOUD_GATEWAY_PUBLIC_KEY=MII…` in git | **None** |
| Oddly short / mid-`=` cut public keys in history | **None** |
| Historical failure mode when wrong key used | forge **`Encryption block is invalid.`** / STEP4 `ok: false` — consistent with **wrong full key**, not a truncated fragment |

No evidence the missing gateway key is “already here but mangled.” The problem is **wrong key selected** (app public), and the previously-correct key **never entered version control**.

---

## 5. Verify against FT178515 / real Finatic payloads

### FT178515 raw notify

Still **not present** in this environment (user can paste). Cannot run `verifyWebhook` on that exact delivery without:

1. Raw body + `sign` (or signature header), and  
2. A candidate public key **body** (fingerprint alone is not enough).

### Closest real Finatic-signed evidence already in-repo

Historical STEP4 runs **already** executed `verifyPayloadSignature(lastCheckoutGatewayBody, body.sign)` against live Finatic HTTP responses:

- With configured fingerprint **`ad7ccabe…`** → **`ok: true`** (Mar 27 & 30)
- With configured = derived app public → **`ok: false`** (Mar 31)

So we do **not** need FT178515 to know `ad7ccabe` was once the correct gateway key — we need its **bytes** to put it back.

### Candidates we *can* load today

| Candidate | Fingerprint | Verifies Finatic? |
|-----------|-------------|-------------------|
| UAT app public (`check-uat-keypair-match.js`) | `f099f80c…` | **No** (throws `Encryption block is invalid.` on real Finatic `sign`) |
| Docs sample PayCloud public | `51db92ce…` | Not our gateway; unrelated |
| `ad7ccabe…` key body | — | **Unknown / unavailable** — cannot test |

---

## 6. What to do next (still no deploy from this agent)

1. **Ask Finatic** for the current **gateway / platform RSA public key** for app_id `wz66363c6bb9592fb5` (or whatever is live for ChowNow), **or** copy it from merchant portal “Public Key Management” / `gateway_rsa_public_key`.
2. On any machine that still has March 2026 `.env` / `.env.local` backups, run fingerprint of `PAYCLOUD_GATEWAY_PUBLIC_KEY` and look for **`ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e`** — if found, that value is the historical known-good key (confirm it still matches Finatic’s current gateway key before wiring prod).
3. After obtaining a body: verify with `verifyPayloadSignature` / `verifyWebhook` against a pasted FT178515 notify **or** any fresh Finatic-signed `order.query`/checkout response; require `ok: true` and fingerprint **≠** `derived_from_private`.
4. Only then rotate Worker secrets (staging first) — **not in this investigation**.

---

## Bottom line

| Question | Answer |
|----------|--------|
| Is the correct key sitting in our git history? | **No** (fingerprint only). |
| Did a different historical configured key ever verify Finatic? | **Yes** — fingerprint `ad7ccabe…b4d47e`, Mar 27–30 2026 live tests, STEP4 `ok: true`. |
| Can we restore it from the repo? | **No.** |
| Need Finatic / portal / local backup? | **Yes — definitively.** |
