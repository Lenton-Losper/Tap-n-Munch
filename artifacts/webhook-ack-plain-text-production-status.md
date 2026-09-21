# Webhook plain-text ack fix — production status

**Question:** Did the July 22 `webhookAck()` / plain-text `"success"` fix ever reach production?  
**Answer:** **Yes.** It was merged to `main` as `e02c73c` and deployed by `production-worker.yml` **the same night** (`2026-07-22T23:51:46Z`, run `29967396229`, head SHA `e02c73c`).

No deploy/rotate performed in this investigation.

---

## Timeline (git + Actions, not “code on main = live”)

| When (UTC) | Event |
|------------|--------|
| `2026-07-22` ~22:27 | `ec4fccf` — fix on staging lineage: duplicate + order-not-found → `webhookAck()`; missing `merchant_order_no` left as **400 JSON** on purpose |
| `2026-07-22` ~23:49 | `e02c73c` — merge to **main**: “SYS500 webhook ack + stale POS/hosted order cleanup **to production**” |
| `2026-07-22T23:51:46Z` | **First successful `production-worker.yml` deploy of `e02c73c` itself** (run `29967396229`) |
| Ongoing | Every later successful production deploy through current `7182fa8` still has `e02c73c` as ancestor |
| `2026-07-26` | `7efd00c` — security hardening **changes** order-not-found (and several fail paths) away from silent `webhookAck()` toward **fail-closed / force Finatic retry** |
| `2026-07-26T21:10:29Z` | First successful production deploy containing `7efd00c` (`197824a`, run `30220522489`) |
| Now | Live `/api/version` production **and** staging: `7182fa8…` |

So: the July 22 plain-text fix was **not** left staging-only. It was explicitly merged for production and **was included in a production-worker run**.

---

## Current `app/api/webhooks/paycloud/route.ts` on `main` (also live prod)

### Branches that return plain-text `success` (`webhookAck()`)

| Branch | Status |
|--------|--------|
| Already-paid duplicate | `webhookAck()` |
| Non-paid notify (`trans_status` not paid) | `webhookAck()` |
| Paid + mark-paid succeeded | `webhookAck()` |
| `GET` (URL verification) | `webhookAck()` |

Live probe: `GET /api/webhooks/paycloud` → body `success`, `Content-Type: text/plain`, HTTP 200 (prod + staging).

### Branches that still return JSON (intentional under current design)

| Branch | Response | Why it is JSON (not an unfinished Jul 22 leftover) |
|--------|----------|------------------------------------------------------|
| Rate limit | 429 JSON | Reject / backoff |
| Invalid JSON body | 400 JSON | Malformed request (`7efd00c` stopped ACKing garbage) |
| Signature reject | 401 JSON | Fail-closed — must **not** ACK or Finatic stops retrying / we pretend success |
| Missing `merchant_order_no` | 400 JSON | Left as real error in **`ec4fccf` itself** (“deliberately NOT changed”) |
| Order resolve / load / mark-paid failures | 503 JSON | Durable write failed — Finatic should retry |
| **Order not found** | **503 JSON** | **`7efd00c` deliberately replaced Jul 22’s `webhookAck()`** so Finatic **retries** until the order exists |

Important nuance on Jul 22’s order-not-found choice: `ec4fccf` switched `{"received":true}` → `webhookAck()`, but the commit text also said Finatic’s **retry-on-non-success** recovers the race. Returning plain-text `success` **stops** that retry. `7efd00c` fixed that inconsistency by returning **503** (retry), at the cost of Finatic logging a failed delivery (often SYS500-class) until the order appears or retries exhaust.

---

## Was anything “still only on staging”?

**No** for the July 22 ack fix — it reached production on **2026-07-22**.

What *is* live now is **July 22 ack + July 26 fail-closed/retry policy**, not the pure Jul 22 “ACK order-not-found” behavior.

---

## Should we “fix” remaining JSON branches to `webhookAck()`?

**Not without an explicit product decision.** Blindly converting every JSON branch to plain-text `success` would:

1. **ACK signature failures** → Finatic stops notifying; paid sales stay unpaid in FlashTap (exactly the FT178515 class of pain, once the gateway key works).
2. **ACK order-not-found** → Finatic will **not** retry the timing race; you’d rely only on cron/reconcile.
3. Conflict with the Jul 26 security hardening already in production.

Recommended policy (for the upcoming gateway-key + webhook reliability work — **not applied here**):

- Keep **`webhookAck()`** only for: processed paid, duplicate paid, non-paid notify, GET.
- Keep **non-success** (401/400/503) for verify failures and durable-write / not-found retries.
- Optionally: make retry responses **plain text** (e.g. body `failure` / empty) **without** the word `success`, if Finatic’s logger prefers non-JSON — separate from “ack success”. Needs Finatic confirmation; do not guess in this report.

---

## Staging / production deploy status for *this* check

- No code change required for “land the Jul 22 fix” — **already live**.
- No production deploy requested or performed.
- Staging and production workers both report commit `7182fa8…` (same webhook route).

---

## Bottom line

| Question | Answer |
|----------|--------|
| Did Jul 22 plain-text ack reach production? | **Yes** — `e02c73c` deployed via `production-worker.yml` at **2026-07-22T23:51:46Z**. |
| Is it only on staging? | **No.** |
| Is every branch plain-text `success` today? | **No** — success/duplicate/non-paid/GET are; errors and **order-not-found** are JSON by later design (`7efd00c`, in prod since **2026-07-26**). |
| Need a fix+deploy right now for ack format? | **No** for re-shipping Jul 22. Any change to order-not-found / error bodies is a **new** policy decision, to stage-verify with the gateway-key fix — not done here. |
