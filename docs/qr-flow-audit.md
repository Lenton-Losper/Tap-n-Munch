# FlashTap — QR Customer Flow Audit

**Read-only investigation.** Nothing in this audit modified code, schema, or data. Every database
interaction was a `SELECT` or a PostgREST `GET`. This document is the only file created.

Started 2026-08-15.

---

## 0. STATE AT START OF AUDIT

Measured, not inherited. Every command run from the main checkout
`C:\Users\223125318\Desktop\mvp\restaurant-menu-screen` (worktrees share one `.git`, so refs are
global).

| | |
|---|---|
| `origin/main` | `9dcf40154ab9d2fcbe5f9e0cd7e4793b400be741` — *"#272: drop two unused eslint-disable directives from the parity test"* |
| production `/api/version` (cache-busted ×2) | `9dcf40154ab9d2fcbe5f9e0cd7e4793b400be741` — **matches `origin/main`** |
| `origin/cloudflare-staging` | `4861492b26798eeeebe6f5f74c6544b010ac5a77` — *"fix(tabs): the PIN rendered twice; keep the strip's, drop the header line"* |
| local commits not on origin | **zero**, across all 80 local branches |
| audit branch | `docs/qr-flow-audit`, cut from `origin/cloudflare-staging` `4861492`, worktree `../wt-qr-audit` |

The unpushed-commit count used the **positional** form required by Revision 3 Rule 13
(`git rev-list --count <branch> --not --remotes=origin`), and was two-sided-controlled: the same
form returns **114** for `origin/main --not origin/cloudflare-staging`, so the predicate is capable
of returning non-zero.

Production `/api/version` was probed with `?cb=100001` and `?cb=100002`; both returned the same SHA,
so this is neither a stale edge cache nor mid-propagation.

### The two refs are NOT the same system, and this audit has to say which one it means

`main` is built by cherry-pick, so the two branches diverge in both directions. The single largest
divergence for this audit's subject:

> **Customer order editing exists only on `cloudflare-staging`. It is absent from
> `origin/main`, therefore absent from production.**
> VERIFIED: `git ls-tree origin/main -- 'app/api/guest/orders/[orderId]/edit/route.ts'` → empty.
> `git ls-tree origin/main -- lib/orders/edit-lock.ts` → empty.

So sections 5, 6, 7, 8 and 16 have **two answers each**, and both are stated:

- **PRODUCTION (`9dcf401`)** — a QR customer cannot edit a placed order at all. There is no edit
  route, no edit lock, no `edit_lock_*` columns in main's migration set.
- **STAGING (`4861492`)** — the order-editing feature (#276) exists, with a database-held lock.

**Convention used throughout:** an unqualified file:line citation refers to `4861492`
(cloudflare-staging). Any claim about production is written as `origin/main:<path>` and labelled.

### Ref movement during the audit

None yet. If `origin/main` or `origin/cloudflare-staging` moves before this document is finished, the
move is recorded here with the list of findings revalidated and the list still pinned to the earlier
SHA.

### Governing documents read

- `docs/agent-operating-contracts.md` at `37a59c9` — revision 3 governs (rules 10–13 plus revisions
  1–2, nothing retired).
- `docs/handover-2026-08-11-sprint.md` at `37a59c9`, latest checkpoint
  *"2026-08-14. Autonomous run: 19 commits, staging drift CLEAN, #262 closed on staging"* — which
  records `origin/cloudflare-staging` at `b3d5c6d`. **That is stale: staging is now `4861492`**,
  which is a descendant. Re-verified rather than inherited, per the checkpoint's own instruction.

---

## FINDINGS INDEX

Findings are numbered `QRA-nn` and carry a severity (P0–P3) and an evidence label
(VERIFIED / INFERRED / UNPROVEN). The full structured list is section 19-Q; entries appear here as
they are established so that nothing depends on reaching the end of the audit.

| ID | Sev | Evidence | One line |
|---|---|---|---|
| QRA-01 | P1 | VERIFIED | Customer order editing is non-functional on staging: the acquire write stores a JSON array into a `text` column and every later check reads it as a scalar, so the holder is refused their own lock. |

---

## QRA-01 — the edit lock cannot be committed by the session that holds it

**Severity P1** (core workflow defect; feature is 100% non-functional). **VERIFIED.**
**Ref `4861492`. Not present on `origin/main`, so production is unaffected.**
Invariants: none violated — this fails *closed*. It is a correctness defect, not a security one.

### The defect

`app/api/guest/orders/[orderId]/edit/route.ts:300-308` acquires the lock with

```ts
.update({
  edit_lock_token: newToken,
  edit_lock_session_id: parsed.sessionIds,   // ← a JS array of strings
  edit_lock_expires_at: expiresAt,
})
```

`parsed.sessionIds` is `string[]` (`route.ts:178-179`, `:198-207`, built by `normalizeSessionIds`).

The column is scalar text. `supabase/migrations/20260813120000_order_editing_lock.sql`:

```sql
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS edit_lock_session_id text,
```

(identically for `public.order_requests`).

The reader treats it as a scalar. `lib/orders/edit-lock.ts:113-120`:

```ts
export function isEditLockHeldByOther(row: EditLockRow, params: EditLockAsker): boolean {
  if (!isEditLockActive(row, params.nowMs)) return false
  const holder = String(row.edit_lock_session_id ?? '').trim()
  if (!holder) return true
  return !normalizeSessionIds(params.sessionIds).includes(holder)
}
```

### What the database actually stores — measured, not reasoned

PostgREST builds the UPDATE record with `json_populate_record`. Run read-only against the linked
**staging** project (`mdqjpxwczrhkxkbqatqa`, `flashtap-staging`) — a pure `SELECT`, no write:

```
$ npx supabase db query --linked "select pg_typeof(x.edit_lock_session_id) as t,
    x.edit_lock_session_id as v
    from json_populate_record(null::public.orders,
      '{\"edit_lock_session_id\": [\"sess_a\", \"session_b\"]}'::json) x"

  t     | v
  text  | ["sess_a", "session_b"]
```

So the stored holder is the **JSON text of the array**, including brackets, quotes and the
inter-element space — never a bare session id. This holds for a one-element array too: `["sess_a"]`.

### The consequence, step by step

1. `POST .../edit` — at acquire time `edit_lock_token` is NULL, so `isEditLockActive` is false,
   so `isEditLockHeldByOther` is false (`edit-lock.ts:114`) and the gate passes. The write lands.
   The customer is handed a `lockToken` and the editor opens. **This step works.**
2. The row now holds `edit_lock_token = <uuid>`, `edit_lock_expires_at = now+3min`,
   `edit_lock_session_id = '["sess_a", "session_b"]'`.
3. `PATCH .../edit` (commit) calls `refusalFor` → `editRefusalReason` (`route.ts:375`) →
   `isEditLockHeldByOther`. The lock is active; `holder` is `["sess_a", "session_b"]`;
   `normalizeSessionIds(['sess_a','session_b']).includes('["sess_a", "session_b"]')` is **false**;
   the function returns **true**.
4. `route.ts:376` → `refuse('locked_by_other')` → **HTTP 409**, copy
   *"Someone else at your table is changing this order. Try again in a moment."*
   (`edit-lock.ts:296`).

The customer is told another diner is editing their order, when the only holder is themselves.
Re-opening (`POST` again) fails the same way at `route.ts:293-294`. The order stays locked for the
full 3-minute TTL unless the client issues `DELETE` — which *does* still work, because `DELETE`
never calls `refusalFor` (`route.ts:555-584`) and is conditioned on the token alone.

**Net effect: an edit can be started and can never be saved.** Every commit path returns 409.

### Why no test catches it

`__tests__/order-edit-route.test.ts` mocks Supabase (`:37-96`). The mock's `update` records the
patch but no round-trip type coercion happens, and the fixture rows supply a **scalar**
`edit_lock_session_id` (`:120`, `:132` — `liveLock(token, session = SESSION)` returns
`edit_lock_session_id: session`, a plain string). The test therefore asserts the *rule*
(`edit-lock.ts` behaves correctly given a scalar holder) and never the *call site* (that the route
writes a scalar). This is exactly the residual Revision 2 names: *"a test that restates the rule
instead of importing it proves nothing"* — here the rule is imported, but the write's shape is not
under test at all.

`__tests__/order-edit-lock.test.ts` supplies scalars throughout (`:107`, `:117`, `:127`, `:161`,
`:178`, `:333`).

### Why the staging race probe did not catch it either

`scripts/probe-order-edit-lock-race-staging.ts` runs four scenarios against the deployed worker and
is recorded green in the 2026-08-13 checkpoint. It was green at that time and the finding does not
contradict it: the array write was introduced **afterwards**.

VERIFIED by `git log -L 300,310:'app/api/guest/orders/[orderId]/edit/route.ts'`:

```
ae9c65e  feat(order-editing): ...        edit_lock_session_id: parsed.sessionId    ← scalar
f063bc3  fix(order-editing): the edit route rejected the customer's own order with a 404
                                          -  edit_lock_session_id: parsed.sessionId
                                          +  edit_lock_session_id: parsed.sessionIds   ← array
```

`f063bc3` is an ancestor of `origin/cloudflare-staging` (verified with
`git merge-base --is-ancestor`). The probe's recorded green run predates it. The session-id
consolidation fixed a real 404 (single id vs. two mints) and, in the same edit, changed the *type*
written to a scalar column — a change no gate in the pipeline inspects, because `tsc` sees
`Record<string, unknown>` on the way into `.update()`.

### Corroborating measurement (read-only, staging DB)

```
GET /rest/v1/orders?select=id,edit_lock_session_id&edit_lock_session_id=not.is.null&limit=10        → 0 rows
GET /rest/v1/order_requests?select=id,edit_lock_session_id&edit_lock_session_id=not.is.null&limit=10 → 0 rows
GET /rest/v1/orders?select=id,customer_edit_count&customer_edit_count=gt.0&limit=10                  → 0 rows
GET /rest/v1/order_requests?select=id,customer_edit_count&customer_edit_count=gt.0&limit=10          → 0 rows
```

**No customer edit has ever committed on staging**, on either surface. That is consistent with the
defect and is *not* proof of it on its own (the feature is new and the human's click-test was
recorded as still in progress) — the proof is the type measurement above.

### Expected safe behaviour

`isEditLockHeldByOther` should compare against the holder **set**. Two shapes are available and this
is an implementation choice inside an existing ruling, not a policy question:

- write only the **primary** id (`parsed.sessionIds[0]`) — matching the code comment at
  `route.ts:196-197` which already says *"order is preserved so the primary id stays first — that is
  the one written to `edit_lock_session_id`"*, i.e. the comment describes the pre-`f063bc3`
  behaviour and is now false; or
- keep the list and change the column to `text[]`/`jsonb` with a set-membership read.

Not proposed as a fix here; stated only to show the defect is in the write/read pair, not in the
ruling.

### Likely cause

`f063bc3` widened *who may be recognised as the owner* (`sessionOwnsRow`, `normalizeSessionIds`) and
carried the same widening into the **stored holder**, where the storage is scalar. Nothing in the
type system, the test suite or the staging probe observes the shape of a value on its way into a
`text` column.

---
