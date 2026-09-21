# July 24→27 webhook “regression” — what actually changed

**Status:** Findings only — no production changes, no secret writes.  
**Date:** 2026-07-28  
**Trigger:** Finatic order `FT17848930568827320` showed `code: "0", msg: "success"` at **2026-07-24 13:37:44**; by Jul 27 Finatic delivery logs show `Encryption block is invalid.`

---

## Verdict

**This was not a Cloudflare secret rotation of `PAYCLOUD_GATEWAY_PUBLIC_KEY`.**  
There is **no evidence** in git, CI, or this agent’s session history of anyone running `wrangler secret put PAYCLOUD_GATEWAY_PUBLIC_KEY` in the Jul 24–27 window.

The Jul 24 “success” **does not prove RSA verification was working.** On that day’s production code, the webhook **failed open**: signature errors were logged and ignored, and the **boolean return value of `verifyPayloadSignature` was not checked at all**. Finatic got plain-text `success` ACK for paid notifies even when crypto threw (`createVerify` / unenv) or would have returned false.

The break is a **code behavior change** that shipped to production in **one deploy**:

| When (UTC) | Deploy / commit | What changed |
|------------|-----------------|--------------|
| **2026-07-24 13:37** | Live code = `fce69843` (deployed 09:22 UTC) | Fail-**open** webhook (below) |
| **2026-07-26 21:10** | `197824a` — Merge PR #79 (includes PR #76 fail-closed + forge) | Fail-**closed** + `node-forge` verify |

**Reverting the forge commit alone will not restore Jul 24 behavior** in a good way: you’d get `[unenv] crypto.createVerify is not implemented yet!` 401s (observed on staging Workers Jul 26 before the fix).  
**Reverting fail-closed** would again ACK Finatic without a valid signature — a security regression, not a key restore.

You still need the correct Finatic **gateway** public key for fail-closed verify to succeed. There is nothing to “roll back” in secrets based on evidence found here.

---

## 1. Git history — `PAYCLOUD_GATEWAY_PUBLIC_KEY` / paycloud / webhook

| Path | Commits Jul 23–27 touching it |
|------|-------------------------------|
| `PAYCLOUD_GATEWAY_PUBLIC_KEY` **value** | **Never in git** (`.env*` gitignored; docs are empty placeholders) |
| `payments/config.js` | **Zero** commits in Jul 20–28 |
| `payments/webhook.js` | **Zero** commits in Jul 20–28 |
| `payments/signature.js` | **`597d1aa`** (2026-07-26) — `createVerify` → `node-forge` |
| `payments/paycloud.js` | **`f8b2bd8`** (2026-07-27) — try/catch around order.query verify (does not change webhook) |
| `app/api/webhooks/paycloud/route.ts` | **`7efd00c`** (PR #76) — **fail-closed** verify |

---

## 2. July 24 production webhook code (smoking gun)

Deploy live at 13:37 UTC: **`fce69843`** (`production-worker` run `30082325889`, 09:22 UTC).

Relevant excerpt from `app/api/webhooks/paycloud/route.ts` at that SHA:

```ts
const sign = extractSign(payload, req.headers)
if (sign) {
  try {
    const copy = { ...payload }
    verifyPayloadSignature(copy, sign)  // return value IGNORED
  } catch (e) {
    console.warn('[PayCloud webhook] Signature verification error; continuing', e)
  }
}
// ... then mark paid + return webhookAck() "success"
```

Implications:

1. **`createVerify` throwing on Workers** → caught → **continue → ACK `success`**.
2. **Verify returning `false`** → not checked → **continue → ACK `success`**.
3. Finatic dashboard `code:0` / `msg:success` at 13:37 is therefore **consistent with fail-open ACK**, not with “RSA verify passed against the correct gateway key.”

Verify implementation that day still used:

```ts
const verifier = crypto.createVerify('RSA-SHA256')
...
return verifier.verify(publicKey, sigB64, 'base64')
```

Same `unenv` stack as Jul 26 (`unenv` lockfile version **identical** between `fce69843` and `197824a`). Staging probes on Jul 26 returned:

```text
{"error":"[unenv] crypto.createVerify is not implemented yet!"}
```

So on Workers, RSA verify was already non-functional; Jul 24 simply **did not fail closed**.

---

## 3. node-forge migration — commit, deploy, coincidence with secrets

| Item | Value |
|------|--------|
| Commit | `597d1aa` — 2026-07-26 19:33 UTC (author local 21:33 +0200) |
| Motivation (commit message) | `crypto.createVerify` unimplemented on CF Workers → every check threw |
| First **production** deploy containing forge | **`2026-07-26T21:10:29Z`**, headSha **`197824a`** (PR #79 merge) |
| Same deploy also first to contain fail-closed | **`7efd00c`** (via PR #76 lineage) is ancestor of `197824a` |
| `payments/config.js` / key loader | **Unchanged** — same `normalizeGatewayPublicKeyEnvToPem(process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY)` |
| CI `wrangler secret put` on that workflow | Only `CRON_SECRET`, `TERMINAL_JWT_SECRET`, `RESEND_API_KEY` — **not** any `PAYCLOUD_*` |

Forge did **not** need a secret change to start returning `Encryption block is invalid.`: once fail-closed + forge ran against the **already-wrong** configured key (`configured === derived` / `1e5dcffc…` per KEYDIAG), Finatic began seeing that forge error instead of silent ACKs.

---

## 4. Cloudflare secret change history

| Source | Result |
|--------|--------|
| `production-worker.yml` / `staging.yml` history | Never `secret put PAYCLOUD_GATEWAY_PUBLIC_KEY` |
| Scanned Actions deploy logs (Worker/Staging, recent) | No `PAYCLOUD_GATEWAY` secret puts |
| This agent session transcript | `secret put` targets mentioned: **only** `CRON_SECRET`, `TERMINAL_JWT_SECRET`, `RESEND_API_KEY` |
| CF API from this environment | **No** `CLOUDFLARE_API_TOKEN` — cannot query audit logs |
| CF Workers secrets generally | **No** value readback; **no** secret version history API after put. Account **audit logs** (if enabled on the plan) may show *that* a secret was updated and *when*, but not the value — needs a human with CF dashboard/API token |

**Cannot prove a negative forever without CF audit access**, but every controllable channel (git, CI, this session) shows **no** gateway-key put in the window.

---

## 5. Manual accident during forge fix?

| Check | Finding |
|-------|---------|
| Claude / Cursor `wrangler secret put PAYCLOUD_GATEWAY…` | **Not found** in session transcripts |
| Forge PR / crypto-selftest | Used **throwaway** keypairs; explicitly did **not** touch real gateway secret |
| Co-authored forge commit | Code-only (`payments/signature.js` + unrelated race/auth fixes) |

No evidence someone pasted a placeholder into `PAYCLOUD_GATEWAY_PUBLIC_KEY` as part of the forge work.

---

## Timeline (condensed)

```text
Jul 24 09:22Z  prod deploy fce69843 — fail-OPEN webhook, createVerify verify
Jul 24 13:37Z  FT178489 — Finatic sees success ACK (expected under fail-open)
Jul 25         more prod deploys — still pre-fail-closed / pre-forge
Jul 26 ~13:58Z staging probe: createVerify → unenv 401 (fail-closed already on staging)
Jul 26 19:33Z  commit 597d1aa forge verify
Jul 26 21:10Z  prod deploy 197824a — fail-CLOSED + forge  ← behavioral break
Jul 27 12:40Z  FT178515 paid at Finatic; webhook rejected Encryption block / SYS500
Jul 27 18:33Z  prod deploy f8b2bd8 — order.query verify try/catch (cron rescue)
```

---

## What “revert” can and cannot do

| Action | Outcome |
|--------|---------|
| Revert forge only (`createVerify`) | Workers 401 with **unenv** — worse / not Jul 24 |
| Revert fail-closed only | Finatic ACKs again **without** valid RSA — insecure; hides wrong key |
| Revert both to Jul 24 webhook | Restores silent ACK; **does not** mean the key is correct |
| Restore historical gateway secret `ad7ccabe…` (if PEM found) | Real fix for fail-closed verify — **if** that key body still matches Finatic |
| CF audit log pull (human) | Only useful to confirm no secret put; won’t recover old secret bytes |

---

## Bottom line

1. **Jul 24 success ≠ working signature verify** — it was **fail-open / ignore errors**.  
2. **Jul 26 21:10Z production deploy `197824a`** introduced **fail-closed + forge** together — that is the regression.  
3. **No evidence the gateway secret changed** in that window; wrong-key (`configured === derived`) was likely already present and only **became visible** once verify was enforced with real crypto.  
4. **Do not chase a secret rollback** as the primary fix without CF audit proof; obtain/restore the real Finatic gateway public key (historical fingerprint `ad7ccabe…`) and keep fail-closed.
