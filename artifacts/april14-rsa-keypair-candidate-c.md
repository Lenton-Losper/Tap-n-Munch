# April 14, 2026 PayCloud “RSA Key Pair” email — fingerprint only

**Status:** Findings only — no deploy, no secret write, **private key body not stored in git**.  
**Source:** Second “RSA Key Pair” email from PayCloud to Sedrick, dated **2026-04-14** (≈2.5 weeks after the March 27 email).  
**Date analyzed:** 2026-07-28

---

## Fingerprint

| Field | Value |
|--------|--------|
| SPKI sha256 | **`8f417499aee53947b82075c5ccf341d07a7d3c4468f9020efe7df7e536555b6a`** |
| Form | Bare base64 SPKI body (parses via `normalizePublicKeyMaterialToPem`) |
| Bits | 2048 |
| Label in this note | **Candidate C** (April 14 email) |

Public body starts `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A…` / ends `…gHIcQIDAQAB` — complete and loadable.

---

## Comparisons (known fingerprints in this repo)

| Known material | Fingerprint | Match Candidate C? |
|----------------|-------------|--------------------|
| Historical working **gateway** (Mar 27/30 STEP4 ok) | `ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e` | **No** |
| Wrong prod gateway (= derived from merchant private) | `1e5dcffc7f814c75e6cab7f1ab348879206956f555807998178a53ec95db2783` | **No** |
| Live Mar 27 derived (app) | `fe8000ae605c76f43508f6d78ad7d803e00af219707532fbbc660ac46a5a4aa6` | **No** |
| Sandbox Mar 30 derived (UAT app) | `f099f80cab1acf93320a8fe294ce2b41eaa87de2b77606ec9aaa7366cef4f1e8` | **No** |

User-stated **Candidate A** (deployed, working) and **Candidate B** (March 27 email, rejected) fingerprints were **not pasted in this turn** and are not stored in-repo under those labels — so equality to A/B was not re-checked here beyond “C ≠ ad7ccabe / 1e5dcffc / fe8000ae / f099f80c”.

---

## Private half (paste quality only — not stored)

| Check | Result |
|--------|--------|
| Base64 length | **1273** chars (`len % 4 == 1` → invalid) |
| Typical PKCS#8 RSA-2048 length | ~1624 chars → **~350 chars missing** (paste truncated mid-key; ends `…jsI9Bm`) |
| Node `createPrivateKey` | **Fails** (`DECODER routines::unsupported`) for both `PRIVATE KEY` and `RSA PRIVATE KEY` wrappers |
| Same modulus as public? | **Yes** — full public modulus bytes found inside the truncated private blob (pair is matched, but private is unusable until complete paste) |

**Do not deploy this private paste.** Re-copy the full private key from the email if it is needed as a merchant signing key; treat the chat paste as compromised for any future use of that material.

---

## Role interpretation (critical)

This email is an **RSA Key Pair** (public **and** private). That pattern is **merchant/app signing material**, not Finatic’s **gateway-only public** used to verify webhooks/responses.

| If used as… | Effect |
|-------------|--------|
| `PAYCLOUD_PRIVATE_KEY` (+ matching app public registered with PayCloud) | Plausible merchant signing rotation candidate (once private paste is complete) |
| `PAYCLOUD_GATEWAY_PUBLIC_KEY` alone | **Wrong role** unless Finatic also signs notifies with this key (no evidence; historical working gateway was `ad7ccabe…`, not `8f417499…`) |
| Both gateway public **and** private set to this pair | Recreates `configured === derived` class of bug → webhook verify throws **`Encryption block is invalid.`** |

---

## What this does / does not prove

- **Proves:** Distinct third key material exists (April 14), fingerprint `8f417499…`, not equal to historical gateway `ad7ccabe…` or the known-wrong `1e5dcffc…`.
- **Does not prove:** That Candidate C is the correct **gateway** public for webhook verify.
- **Cannot test here:** Live Finatic response/webhook verify with C (no PayCloud env / no FT178515 raw notify in this environment).

---

## Recommended next step (human)

1. Paste **Candidate A** and **Candidate B** SPKI fingerprints (or public bodies) for a three-way equality table.  
2. Keep **gateway** (`PAYCLOUD_GATEWAY_PUBLIC_KEY`) on the key Finatic uses to **sign** (historically `ad7ccabe…` when STEP4 worked) — do not set it to a merchant keypair public.  
3. If April 14 pair is meant for **outbound signing**, replace `PAYCLOUD_PRIVATE_KEY` only after a **complete** private PEM is available, and confirm Finatic still has the matching public registered for the app_id.
