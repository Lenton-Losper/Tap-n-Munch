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

### METHODOLOGY CORRECTION — cwd drift fired during this audit, and one claim was wrong because of it

Recorded here because Revision 2's *"Integrator cwd drift"* rule and the memory note *"Bash cwd
drifts between calls"* both exist and neither prevented it.

Partway through section 1 a `pwd` showed the shell standing in
`restaurant-menu-screen` (branch `docs/agent-operating-contracts`, `37a59c9`) rather than the audit
worktree, even though an earlier call in the same sequence had `cd`'d into `../wt-qr-audit`. Files
read with the `Read` tool were unaffected — those used absolute paths into the worktree. Files read
with bare-path `cat` / `sed` / `grep` were read from **whichever tree the shell happened to be in**.

`37a59c9` is a documentation branch whose code tree is an older staging snapshot: 94 files differ
from `4861492`, and the order-editing feature is absent from it entirely.

**The claim it produced, now retracted:** that `cloudflare-staging` had *lost* #262's fix to
`app/api/tabs/[tabId]/join/route.ts` (the `alreadyMember` PIN exemption) while `main` kept it. That
is false. Verified ref-explicitly:

```
git show 4861492:app/api/tabs/[tabId]/join/route.ts | grep -n 'if (pinRequired)'
  163:      if (pinRequired) {          ← the fix IS present on staging
```

`37a59c9` carries the pre-fix `if (pinRequired && !alreadyMember)`, which is correct for a branch
cut before `11062b8`.

**Correction applied to the whole audit:** every claim reached through a bare-path shell read was
re-taken with `git -C <repo> show <ref>:<path>`, and a blob-identity sweep was run over the twenty
files involved to establish which ones actually differ between the two trees
(`git rev-parse 37a59c9:<path>` vs `4861492:<path>`). Eight differed; the rest were byte-identical
and their findings stand unchanged. Where a differing file changed a conclusion, the corrected
conclusion is what appears below — see QRA-04, whose production and staging answers are opposite.

**From this point on, every code citation in this document is either a `Read` against an absolute
path in `wt-qr-audit`, or a `git show <ref>:<path>`.** No bare-path shell read is cited.

---

## FINDINGS INDEX

Findings are numbered `QRA-nn` and carry a severity (P0–P3) and an evidence label
(VERIFIED / INFERRED / UNPROVEN). The full structured list is section 19-Q; entries appear here as
they are established so that nothing depends on reaching the end of the audit.

| ID | Sev | Evidence | Ref(s) | One line |
|---|---|---|---|---|
| QRA-01 | P1 | VERIFIED | staging only | Customer order editing is non-functional: the acquire write stores a JSON array into a `text` column and every later check reads it as a scalar, so the holder is refused their own lock. |
| QRA-02 | **P0** | VERIFIED (code) / UNPROVEN (runtime) | **both, incl. production** | `POST /api/tabs` on an already-occupied table returns a valid tab session token with **no PIN**, no membership and no credential of any kind. Already tracked as #128/#218. |
| QRA-03 | **P0** | VERIFIED (code) | **both, incl. production** | What that token grants, which #218 records as unestablished: add orders to the victim's tab, read every member's raw `session_id`, and move the tab to `ready_to_pay`. |
| QRA-04 | P1 | VERIFIED | staging only | `GET /api/tabs/[tabId]` returns the live `tab_pin` to any session-token holder — and QRA-02 mints such a token without the PIN, so the disclosure argument in its own comment is circular. |
| QRA-05 | P1 | VERIFIED | both | `GET /api/orders?tabId=` selects `session_id` for every order on the tab and returns it to any token holder. `session_id` is the whole authorisation in `ownsOrder`. |
| QRA-06 | P2 | VERIFIED | both | There is no rate limiting anywhere in the application. `CacheKeys.rateLimit` exists in `lib/redis.ts` and has zero consumers. |
| QRA-07 | P2 | VERIFIED | both | `POST /api/orders` applies the session-token guard **only when a `tabId` is supplied**, so an order can be injected onto an occupied table with no credential at all (landing off-tab). |
| QRA-08 | P2 | VERIFIED | both | `POST /api/tabs/[tabId]/join` skips the PIN entirely when `tab_pin IS NULL` even though `pin_required` is true (`pinRequired = pin_required !== false && Boolean(tab_pin)`). Tracked as #236. |
| QRA-09 | P2 | VERIFIED | both | `POST /api/tabs/[tabId]/join` appends to `members` with a read-modify-write; the sibling `POST /api/tabs/join` was fixed to use the `add_tab_member` RPC and this copy was not. |
| QRA-10 | P3 | VERIFIED | both | `app/menu/[restaurantId]/v2/page.tsx` — the first screen every QR customer sees, 1539 lines — begins with `// @ts-nocheck`. |
| QRA-11 | P2 | VERIFIED | both | *End Session* on My Orders clears identity A but not the session token, and the landing refuses to mint a new A while a token exists — so My Orders becomes unreachable in a loop. |
| QRA-12 | P1 | VERIFIED | both | `/tab`'s **"Full tab running total"** is a client sum of *this device's own orders*; the query it comes from is session-scoped by construction. Tracked as #119. |
| QRA-13 | P3 | VERIFIED | both | My Orders renders `sessionInfo.created`, a field `getSessionInfo()` has never returned — so it always reads "Session active since N/A". |
| QRA-14 | P2 | VERIFIED (staging) | both / prod UNPROVEN | `close_table_session` — which settles tabs and evicts every diner — is EXECUTE-able by `anon` and never revoked. **Not exploitable**, because it is SECURITY INVOKER and `anon` has no UPDATE on `tabs`. An invariant attacked and held; recorded with what stops it. |
| QRA-15 | P1 | VERIFIED | both | Nothing re-sums `tabs.total` when an order is cancelled, so the tab strip overstates what is owed until settlement corrects it. |
| QRA-16 | P1 | VERIFIED | staging (edit) / both (requests) | Closing the table does not close editing: an unpaid order stays `pending/pending` and the edit route consults no token, no session version and no `is_closed`. Nothing closes `order_requests` at all. |
| QRA-17 | **P1** | VERIFIED (staging catalogue) | both; prod publication UNPROVEN | **Every customer realtime subscription in the QR app is dead.** All seven target `tabs` / `restaurant_tables`, and neither is in the `supabase_realtime` publication — nothing has ever published them. |
| QRA-18 | P1 | VERIFIED | **both, incl. production** | `PATCH /api/tabs/[tabId]/member` has no session token, **no restaurant scope at all**, a service-role client and a full-array overwrite of `tabs.members`. The tab UUID is handed out unauthenticated by `/api/tabs/active`. |
| QRA-19 | P2 | VERIFIED | **both, incl. production** | `POST /api/guest/orders/[orderId]/receipt/email` will email a **paid** order's full receipt to any address on restaurant scope alone — no table, no session, no rate limit. |

**Cross-reference to the tracker.** QRA-02 is #128 and #218; QRA-06's PIN half is #283; QRA-08 is
#236; the `guestCanAccessOrder` table-number branch discussed in section 13 is #279. None of these
are new discoveries and this audit does not present them as such. **QRA-03, QRA-04 and QRA-05 are
new**: they are the answer to the question #218 explicitly leaves open —
*"What the issued session token grants beyond visibility."*

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

## QRA-02 — an unauthenticated `POST /api/tabs` mints a tab session token with no PIN

**Severity P0.** **VERIFIED in code at BOTH refs, including `origin/main` `9dcf401` = production.**
Runtime **UNPROVEN** — see *What would settle it* below; the one request that proves it is a write,
and this audit is read-only.
Invariants falsified: **INV-9** (an authorization decision resting solely on a client-supplied
identifier), and **INV-1** by consequence.
**Already on the tracker as #128 and #218, both OPEN.** This entry restates it because the audit
must not depend on the reader knowing those issues, and because the reachability described here is
broader than either issue states.

### The mechanism

`baseline.sql:1808` (unchanged at both refs):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "idx_tabs_one_open_per_table"
  ON "public"."tabs" USING "btree" ("restaurant_id", "table_number")
  WHERE ("status" = 'open'::"text");
```

`POST /api/tabs` inserts with `status: 'open'`, so on an occupied table the insert raises `23505`.
The recovery branch — `app/api/tabs/route.ts:150-227` at `4861492`, `:119-196` at `9dcf401` —
fetches the existing open tab and calls `issueTokenForOpenTab`, returning
`{ success: true, tabId, sessionToken, joinedExisting: true }`.

**There is no PIN check, no membership check and no credential of any kind in that branch.** Grepped
ref-explicitly at both refs: the only `tab_pin` / `pinRequired` occurrences in the whole file are at
the *creation* path (`:81`, `:89-90`, `:130-131`, `:260` on staging), all of them above the `23505`
handler and none of them reached by it.

The route itself requires only:

- `restaurantId` — public. It is in every menu URL, and for the Riviera venue it is a compile-time
  constant in the repository: `lib/riviera-subdomain.ts:3`,
  `RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'`.
- `tableNumber` — a small positive integer, printed on the table, and enumerable 1..N.

`middleware.ts:117-119` excludes `/menu` and a handful of auth paths from the matcher and guards
only `/admin/*` (`middleware.ts:83`). No API route under `/api/tabs` has any middleware auth.

### Why the framing here differs from #128 and #218

- **#128** describes it as a *race*: "two people tap Create Tab simultaneously". No race is
  required. The unique index fires on any tab that is already open, whether it opened one second or
  five hours ago.
- **#218** describes it as reachable when the tab is **older than the landing's 12-hour window**,
  because that is what makes the *landing UI* render "Create Tab" instead of "Join Tab". That
  condition governs the button, not the endpoint. A direct request to `POST /api/tabs` needs no
  stale tab and no UI at all.

So the reachable population is not "tables whose tab is >12h old" or "simultaneous taps"; it is
**every occupied table, at all times**.

### What would settle it at runtime

One request:

```
POST https://flashtap.app/api/tabs
Content-Type: application/json
{"restaurantId":"<any restaurant uuid>","tableNumber":<a table with an open tab>,
 "sessionId":"probe","displayName":"probe"}
```

Expected: HTTP 200, body containing `sessionToken` and `joinedExisting: true`, and **no** `tabPin`.

**Not run.** It is a write: the failed insert costs nothing, but `issueTokenForOpenTab` INSERTs a
`customer_sessions` row and UPDATEs `tabs.session_version` on a live tab. On staging it would
perturb a shared test project; on production it would touch a real customer's tab. Needs the
human's go, and on production should not be done at all — a staging tab seeded for the purpose is
the right ceiling.

---

## QRA-03 — what that token grants (the question #218 leaves open)

**Severity P0.** **VERIFIED in code at both refs.** Invariants falsified: **INV-1**, **INV-9**.

#218's "Not yet established" section asks *"What the issued session token grants beyond visibility
— whether it also permits ready-to-pay or settlement."* Answered by enumerating every consumer of
the guard. `requireSessionToken` is imported in exactly five files and called at six sites
(grep run in the audit worktree at `4861492`):

| Site | What the token authorises |
|---|---|
| `app/api/orders/route.ts:98` (POST) | **Place an order onto the tab.** Reached only when `tabId` is supplied; `assertSessionMatchesResource` then binds token→tab. |
| `app/api/orders/route.ts:673` (GET) | **Read every order on the tab, including each one's raw `session_id`** — see QRA-05. |
| `app/api/orders/[orderId]/ready-for-terminal/route.ts:49` | Flag an order for terminal payment. |
| `app/api/payments/receipt/route.ts:49` | Customer receipt lookup. |
| `app/api/tabs/[tabId]/ready-to-pay/route.ts:23` | **Move the tab to `ready_to_pay`.** |
| `app/api/tabs/[tabId]/route.ts:20` | Tab detail — and on staging, **the live PIN**; see QRA-04. |

So the answer to #218 is: **yes to ready-to-pay, and more.** Three consequences, in descending order
of seriousness.

**1. Charges land on a stranger's bill.** With the token, `POST /api/orders` with the victim's
`tabId` passes the guard at `route.ts:96-107`. For `channel: 'table'` the submission becomes an
`order_requests` row (`route.ts:305-335`) carrying `tab_id`. When staff Accept it, it becomes a real
order on that tab and the tab total is re-summed. Staff have no signal distinguishing it from an
order placed by someone sitting at the table — the request carries a `session_id` the attacker
chose and a `customer_name` the attacker chose.

**2. Service denial on a table.** `POST /api/tabs/[tabId]/ready-to-pay` moves the tab to
`ready_to_pay`. That status then refuses further ordering — `app/api/orders/route.ts:138-143`,
*"This tab is ready to pay — you cannot add more items."* — and refuses further joins,
`app/api/tabs/[tabId]/join/route.ts:62-71`, `TAB_PAYMENT_IN_PROGRESS`. The write is CAS'd
(`.neq('status','ready_to_pay')`) so it cannot be double-applied, but nothing lets a customer undo
it; only staff can.

**3. Escalation to the other diners' identities.** See QRA-05.

### The part that makes this a chain rather than three separate issues

The PIN exists to gate exactly the capability above. QRA-02 hands out a token that carries the
capability without the PIN. Every mitigation reasoned about elsewhere in the codebase in terms of
"the token is strictly stronger than the PIN, so disclosing the PIN to a token holder gives them
nothing" (`app/api/tabs/[tabId]/route.ts:47-53` at `4861492`) is sound **only if the token itself
requires the PIN**, and it does not.

---

## QRA-04 — the tab PIN is disclosed to any session-token holder (staging only), closing the circle

**Severity P1.** **VERIFIED.** **Present at `4861492`. NOT present at `9dcf401` — production is
unaffected today, and this is a regression risk on the next promotion, not a live production
defect.**

`app/api/tabs/[tabId]/route.ts` at `4861492`:

```
:31-33   .select('id, restaurant_id, table_id, table_number, status, total, members,
                  session_version, pin_required, tab_pin')
:70-72   const tokenTabId = String(guard.tabId || '').trim()
         const pinRequired = row.pin_required !== false && Boolean(row.tab_pin)
         const disclosePin = Boolean(tokenTabId) && tokenTabId === normalizedTabId && pinRequired
:77-81   tab: { ...safeColumns, members: await redactTabMembers(...),
                ...(disclosePin ? { tab_pin: String(row.tab_pin) } : {}) }
```

At `9dcf401` the same route selects **without** `tab_pin` and has no disclosure branch — verified
with `git show 9dcf401:app/api/tabs/[tabId]/route.ts`, whose `select` string ends at
`session_version`.

The staging code carries its own justification, and it is worth quoting because it is the exact
point at which the reasoning fails:

> *"WHY DISCLOSING IT HERE IS NOT NEW EXPOSURE. The session token is strictly stronger than the PIN:
> the PIN's only power is to mint a token (POST /api/tabs/[tabId]/join), and the caller already
> holds one … It is a downgrade of a credential they hold, not a new one."*

The premise is that holding a token implies having passed the PIN. QRA-02 falsifies exactly that
premise: `POST /api/tabs` mints a token on an occupied table with no PIN. So on `4861492` the full
sequence is

```
POST /api/tabs           {restaurantId, tableNumber}   -> 200, sessionToken       (no credential)
GET  /api/tabs/{tabId}   x-session-token: <that token> -> 200, tab.tab_pin        (the PIN)
```

and the attacker now holds the PIN as well, which survives independently of the token and can be
handed to another device. Note the argument is not wrong about the *relative* strength of the two
credentials; it is wrong about how the stronger one is obtained.

**This is a comment asserting a security property that another file's behaviour removes.** It is the
same class as the base-conditional-comment rule in the operating contract, applied across routes
rather than across branches: nothing in `[tabId]/route.ts` can see that `tabs/route.ts` gives the
token away.

---

## QRA-05 — `GET /api/orders?tabId=` publishes every member's raw `session_id`

**Severity P1.** **VERIFIED at BOTH refs, including production.** Invariants falsified: **INV-9**,
and **INV-1** for the staging edit path.

`app/api/orders/route.ts:689` at `4861492` (`:682` at `9dcf401`, byte-identical select string):

```ts
.select('id, status, payment_status, total, placed_at, tab_id, session_id')
.eq('restaurant_id', restaurantUuid)
.eq('tab_id', tabId)
.eq('is_closed', false)
```

Authorisation is `requireSessionToken` + `assertSessionMatchesResource` bound to the tab — so **any
member of a tab can read every other member's `session_id`**, and via QRA-02 so can someone who
never joined.

`session_id` is not an opaque display value. It is the whole authorisation in `ownsOrder`
(`lib/guest-orders/validation.ts:89-102`), whose own docblock says so:

> *"NOT a credential check. A session id is a bearer value the client supplies, so this answers 'does
> the caller know an id this row was placed under', nothing stronger."*

What a harvested `session_id` buys:

- **Both refs:** `GET /api/guest/orders/by-session?restaurantId=…&session_id=<victim>` returns that
  diner's full order rows — items, totals, notes, `customer_name`, and their own `session_id` back.
  `fetchGuestOrdersBySession` requires only that the session list is non-empty
  (`lib/guest-orders/queries.ts:168-170`).
- **Staging only:** `sessionOwnsRow` in the edit route
  (`app/api/guest/orders/[orderId]/edit/route.ts:139-146`) matches the supplied ids against
  `session_id` / `member_session_id`, so a harvested id is sufficient to **acquire the edit lock on
  another diner's order**. QRA-01 currently prevents the *commit* from succeeding, which is an
  accident rather than a control: fixing QRA-01 without fixing this opens the write.

### The contradiction worth naming

Two sibling routes disagree about whether `session_id` is a secret, and the disagreement is
documented on the side that treats it as one:

- `lib/tab-member-key.ts` / `redactTabMembers` exists specifically so `tabs.members[]` stops
  publishing raw session ids (#262), and it is applied at
  `app/api/tabs/[tabId]/route.ts:79` and on all five guest row exits.
- `app/api/orders/route.ts:689` selects the same value straight out of `orders` and returns it.

`lib/guest-orders/queries.ts:299-308` states the residual explicitly — the #262 redaction *"rewrites
`member_session_id` ONLY; `session_id` is never touched"* — and it is filed as **#282**. This route
is a site of #282 that the filed issue does not name; the issue is written about the guest read
paths.

**Mitigating, and the only reason this is P1 rather than P0:** `GET /api/orders` has **no client
caller.** Grepped at `4861492` across `app/`, `components/`, `contexts/`, `lib/`: the four hits on
`/api/orders` are all `POST`. Nothing in the product reads it. It is live, reachable and unused —
the same shape as the `GET /api/tabs/[tabId]` exposure that #262 closed, and whose own comment says
*"Nothing consumed the field, which is the only reason it was never exploited."*

---

## QRA-06 — there is no rate limiting anywhere in the application

**Severity P2** on its own; it is what turns QRA-08 and #283 from theory into practice.
**VERIFIED at both refs.**

`lib/redis.ts:18-19` defines the key:

```ts
rateLimit: (restaurantId: string, tableNumber: number) =>
  `rate:orders:${restaurantId}:table:${tableNumber}`,
```

and `TTL.RATE_LIMIT = 60` at `:27`. **Nothing consumes either.** `grep -rn "rateLimit"` across the
whole repository excluding `node_modules`, run in the audit worktree, returns exactly that one
definition line. There is no rate-limiting middleware (`middleware.ts` has none), no attempt
counter on `tabs`, and no lockout — while the staff terminal PIN in the same codebase has a
documented 5-attempts-in-10-minutes lockout in `lib/terminal-auth/pin-lockout.ts`.

`generateTabPin` is unchanged at both refs (byte-identical blobs):

```ts
export function generateTabPin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString()
}
```

9000 values, `Math.random()`, unthrottled. This is #283 and its analysis is accurate; recorded here
because it is a precondition for the sections below and because #283 sizes the blast radius as
bounded by needing "the tab UUID and table number as well as the PIN" — QRA-02 supplies the tab
UUID for free, so that bound does not hold.

---

## QRA-07 — order injection with no credential at all, by omitting `tabId`

**Severity P2.** **VERIFIED at both refs.** Invariant: **INV-9**.

`app/api/orders/route.ts:96` gates the entire session-token check behind a conditional:

```ts
if (normalizedTabId) {
  const guard = await requireSessionToken(req)
  ...
}
```

Omit `tabId` and no token is required. The request then reaches `:158-178`, which requires only that
**some** open tab exists at that table:

```ts
if (!isTabOrder && channel !== 'kiosk') {
  ... .from('tabs').select('id').eq('restaurant_id', …).eq('table_number', …).eq('status','open')
  if (!openTabForTable) return 403 'This table has been closed…'
}
```

An occupied table satisfies it. The submission then passes the payment-method allowlist
(`:255`, which *does* apply here because `paymentMethodIsChosenAtSubmission = !isTabOrder`) and is
inserted as an `order_requests` row at `:311-335` with `tab_id: null`.

Consequence: kitchen work is created at a real table, attributed to no tab. It is weaker than
QRA-03 — the charge does not attach to the victim's tab total, because the tab sum filters on
`tab_id` — but it needs no token at all, and it produces a real order at a real table that staff
must dispose of. The order also becomes an unbilled orphan if accepted, since tab settlement sums
by `tab_id`.

This is the same *shape* as #124 (`if (paymentMethod && …)` skipping the whole check when the field
was absent) applied to authentication rather than to the payment allowlist: **an optional field
whose absence removes a check.**

---

## QRA-08 — `tab_pin IS NULL` disables the PIN check while `pin_required` is true

**Severity P2.** **VERIFIED at both refs.** Tracked as **#236**, OPEN. Confirmed still live.

`app/api/tabs/[tabId]/join/route.ts:162-170` at `4861492`:

```ts
const pinRequired = tabData.pin_required !== false && Boolean(tabData.tab_pin)
if (pinRequired) {
  if (!pin)  return 403 'PIN required to join this tab'
  if (String(tabData.tab_pin ?? '') !== pin) return 403 'Incorrect PIN'
}
```

`Boolean(tabData.tab_pin)` makes the *absence of the secret* disable the check that the secret
exists to perform. A tab with `pin_required = true` and `tab_pin = NULL` is joinable by anyone
holding the tab UUID and table number, with an empty body.

The sibling `POST /api/tabs/join` (join by table number) fails closed on the same state: it requires
a non-empty `pin` at `:26-28` and then compares `String(tab.tab_pin ?? '') !== pin`, which for a
NULL pin is `'' !== <non-empty>` → always refuse. **So the two join routes disagree about the same
row.** That divergence is not recorded on #236.

Whether the state occurs: the creation path only writes `tab_pin` when `pinRequired`
(`app/api/tabs/route.ts:89-90`, `tabPin = pinRequired ? generateTabPin() : null`), so
`pin_required=true, tab_pin=NULL` is not produced by creation. It is producible by a settings
change, by `pin_required` flipping on an existing tab, or by a manual edit. **Occurrence on live
data: not measured** — measuring it means reading `tabs.tab_pin` for real tabs, which is reading a
live credential, and was deliberately not done. State it as a latent defect with an unmeasured
population.

---

## QRA-09 — the by-id join still loses concurrent members; its sibling was fixed

**Severity P2.** **VERIFIED at both refs.**

`app/api/tabs/join/route.ts:55-70` (join by **table number**) uses the atomic RPC, and says why:

> *"Append via the DB so simultaneous joiners cannot clobber each other. Reading members here and
> writing the whole array back lost every concurrent joiner but one — and returned HTTP 200 to all
> of them, so nobody found out. `add_tab_member` does the append, the already-a-member check, and
> the 'Person N' fallback inside one UPDATE."*
> — `supabase/migrations/20260730210000_atomic_tab_member_append.sql`

`app/api/tabs/[tabId]/join/route.ts:173-184` (join by **tab UUID**) does the thing that comment
describes as the bug:

```ts
const members = Array.isArray(tabData.members) ? [...tabData.members] : []   // :97
...
.update({ members: [...members, member] })                                   // :182
.eq('id', normalizedTabId).eq('restaurant_id', restaurantUuid)
```

Read-modify-write, no version check, no `add_tab_member`. Two devices redeeming a rejoin at once
lose one member, and both get HTTP 200.

`app/api/orders/route.ts:500-509` does the **same** read-modify-write on `tabs.members` when a
direct (non-request) order is placed on a tab, and it is a third copy of the same append logic
including its own `Person ${members.length + 1}` naming.

So the fix landed on one of three writers. `scripts/qr-audit-repro-member-lost-update.ts` exists in
the tree (added by `67e5eb6`, *"make joining a tab atomic so simultaneous joiners are not lost"*)
and its docblock still points at `app/api/tabs/join/route.ts:55-70` — the copy that was fixed —
rather than at the two that were not. A repro script aimed at the fixed site will now pass while the
defect remains at two other sites.

**Consequence when a member is lost:** the entry is what `alreadyMember` and the tab UI read, and
what supplies `display_name`. Losing it does not lose the *order* (that carries its own
`session_id`), so this is a display/attribution defect, not a money one — which is why it is P2.

---

## QRA-10 — the first screen every QR customer sees is untypechecked

**Severity P3.** **VERIFIED at `4861492`.**

`app/menu/[restaurantId]/v2/page.tsx:1` is `// @ts-nocheck`, on a 1539-line client component that
is the landing target of every table QR (via the redirect at
`app/menu/[restaurantId]/page.tsx:35` and the Riviera rewrite at `middleware.ts:60-66`). It holds
the tab create/join decision, the session-token validation calls, the stale-tab reconciliation and
the hosted-pending-payment block. `tsc` asserts nothing about any of it.

Recorded per the operating contract's SUPPRESSIONS rule, which asks that suppressions be *disclosed
and graded*: this one is an ASSERTION (it quiets the checker over an entire file), not an
ESTABLISHED fact, and its blast radius is the whole QR entry path.

---

# STAGE 1

---

# 1. SYSTEM MODEL

Everything in this section is read at `4861492` unless a production difference is called out, in
which case the production fact is read at `9dcf401`.

## 1.0 The single most important structural fact

**A QR customer's "order" is not an `orders` row.** For `channel: 'table'` and `channel: 'kiosk'`,
`POST /api/orders` inserts into **`order_requests`** and returns that row's id as `orderId`
(`app/api/orders/route.ts:305-365`). An `orders` row only comes into existence when a staff member
presses Accept (`app/api/order-requests/[requestId]/accept/route.ts`). VERIFIED.

The customer's URL does not change when that happens: `fetchGuestOrderById` resolves an id against
`orders` first, falls back to `order_requests`, and if the request has been accepted it recurses
into the real order (`lib/guest-orders/queries.ts:81-133`). So one id addresses two tables across
its lifetime, and **every question in this audit has to be asked twice** — once of the pre-Accept
surface and once of the post-Accept surface. The code is explicit about this; `redactGuestOrderRow`
takes a `surface` parameter precisely because *"every way of guessing from the row's own contents is
wrong for some row"* (`lib/guest-orders/validation.ts:125-131`).

`supabase/migrations/20260726100000_order_requests.sql:1-5` states the rule:

> *"A row here is NOT a real order — nothing downstream (kitchen routing, payment, stock deduction,
> tab totals) should ever read this table."*

## 1.1 Entity by entity

### restaurant

- **Lives in** `public.restaurants`. Identified by `id uuid`. A legacy `firebase_restaurant_id text`
  scope travels alongside it on orders (`app/api/orders/route.ts:315`, `:403`).
- **Referenced by** essentially everything; `restaurant_id` is the mandatory tenant scope on
  `guestCanAccessOrder` (`lib/guest-orders/validation.ts:24-28` — an unmatched or absent
  restaurant is an immediate `false`).
- **Resolution** `resolveRestaurantUuid` accepts a uuid or a slug. It is applied inconsistently:
  `/api/tabs/active` resolves (`route.ts:53`), `/api/tabs/[tabId]/view` deliberately does **not**
  and matches `restaurant_id` raw, with the reason written down (*"Both callers pass the
  `restaurantId` path segment straight into `.eq(...)` today"*).
- **Expiry** none.

### physical table

- **Lives in** `public.restaurant_tables`. Identified by `id uuid`; addressed by customers as
  `(restaurant_id, table_number)`, which has been unique since migration `20260806000000` (#174).
- **Columns that gate the customer** `active` (an inactive table refuses ordering,
  `app/api/orders/route.ts:273-287`), `is_view_only` (refuses ordering unconditionally and scrubs
  the browser's tab state, `route.ts:71-89` and `v2/page.tsx:300-313`), `is_kiosk`,
  `status` (`available` / `occupied`), and **`current_session_version integer`**.
- **`status` is written** to `occupied` on tab creation (`app/api/tabs/route.ts:238`) and reset by
  the close-table RPC. Memory of a prior audit records it going stale; that is #177/#216 and is
  outside this audit's scope except where the terminal reads it.

### QR code

- **Not a database entity.** It is a printed URL. Two forms:
  - `/{origin}/menu/{restaurantId}?table={n}` → `app/menu/[restaurantId]/page.tsx:35` redirects to
    `/menu/{restaurantId}/v2?table={n}`.
  - `riviera.flashtap.app/table/{n}` → `middleware.ts:59-66` **rewrites** (not redirects) to
    `/menu/{RIVIERA_RESTAURANT_ID}/v2?table={n}`. `parseTableLandingPath`
    (`lib/riviera-subdomain.ts:14-20`) accepts only positive integers; `/table/5.5` and
    `/table/%205` 404 (a deliberate known gap, #179).
- **It carries no secret.** `restaurantId` and `table` are the whole payload. This is the root of
  every "possession of an identifier is sufficient" finding in section 13: the QR encodes public
  data, so anything gated on that data alone is gated on nothing.
- **It is permanent.** Nothing rotates it. Separation between successive parties at the same table
  is entirely the job of `current_session_version` and tab status — see 1.11 and section 11.

### table session

There is no `table_sessions` table. "Table session" is the conjunction of three things:

1. `restaurant_tables.current_session_version integer` — the generation counter.
2. `public.tabs` row with `status = 'open'`, at most one per table
   (`idx_tabs_one_open_per_table`, `baseline.sql:1808`).
3. `public.customer_sessions` rows carrying the version they were issued under.

**`current_session_version` has no TypeScript write site.** It is read at
`lib/session-token.ts:44-52` and compared at `:113-116`, and it is *incremented* by plpgsql (the
close-table RPC in `schema.sql`). Grepping for a TS writer finds nothing — the standing warning in
the brief about this symbol is accurate and is repeated here because it is load-bearing for
section 11.

### customer session (server-side)

- **Lives in** `public.customer_sessions`. Created only by `issueSessionToken`
  (`lib/session-token.ts:5-35`).
- **Identified by** `token`, a `crypto.randomUUID()`. **This is the only real credential in the
  QR system.**
- **Belongs to** a tuple: `tab_id`, `table_id`, `restaurant_id`, `session_version`.
- **Expires** 24 hours after issue (`:26`), and is invalidated earlier by any of: `active = false`,
  the tab leaving `status = 'open'`, or `restaurant_tables.current_session_version` moving away
  from the value stamped on the row (`validateSessionToken`, `:74-127`).
- **Issued by** exactly three routes — `POST /api/tabs` (both the normal path and the `23505`
  path, `route.ts:243` and `:210`), `POST /api/tabs/join` (`:74`), `POST /api/tabs/[tabId]/join`
  (`:190`).
- **Consumed by** exactly six call sites (see QRA-03 for the table). Every other customer route —
  including all five guest read routes and the entire edit surface — ignores it.

`issueTokenForOpenTab` also **writes `tabs.session_version` from the table's current version**
(`lib/session-token.ts:53-63`) before minting. That is the mechanism #235 is filed about: issuing a
token re-arms a tab that staff had invalidated.

### customer identity (client-side)

This is where the model is genuinely confusing, and the confusion has produced at least four
recorded bugs. There are **two independently minted session ids** and nothing syncs them:

| | storage | key | format | minted by |
|---|---|---|---|---|
| A | `localStorage` (+ `sessionStorage` mirror) | `flashtap_session_v1` | `sess_<uuid>` | `createFreshSession` / `getOrCreateSession`, `lib/session.ts:20-58` |
| B | `sessionStorage` + a `localStorage` mirror | `tab_session_id` / `flashtap_tab_session_id_mirror` | `session_<uuid>` (new) or `session_<ts>_<rand>` (legacy) | `ensureTabSessionId` → `mintTabSessionId`, `lib/tab-storage.ts:72-132` |

- **B is what the tab flow submits**, as *both* `session_id` and `member_session_id`
  (`cart/page.tsx:287-289`). **A is what the non-tab flow submits**, also into both columns
  (`cart/page.tsx:371-372`).
- **B was hardened to a CSPRNG (#277)** on 2026-08-14, new mints only. `mintTabSessionId` throws
  rather than falling back to `Math.random` — a deliberate loud failure
  (`lib/tab-storage.ts:127-131`). **A was always `crypto.randomUUID()`.** Legacy `session_<ts>_<rand>`
  ids minted before that change are still valid and still accepted.
- `heldSessionIds()` (`lib/tab-storage.ts:154-161`) is the single place the pair is assembled, and
  `ownsOrder` (`lib/guest-orders/validation.ts:89-102`) is the single predicate. Both are recent
  consolidations and both are correct; the residual risk is that **a session id is a bearer token
  and the codebase says so in terms** — see QRA-05.
- `createFreshSession` **refuses to mint while a `flashtap_session_token` exists**
  (`lib/session.ts:22-30`). That interlock has a dead-end consequence — see QRA-11 below.

### session version

Two copies, and they are compared, not joined:

- `restaurant_tables.current_session_version` — the authority.
- `customer_sessions.session_version` — the stamp.
- `tabs.session_version` — a third copy, written by `issueTokenForOpenTab` and read by nothing in
  the customer path (it is selected by `/api/tabs/[tabId]` and `/view` and rendered nowhere).

`validateSessionToken` fails the token when the two disagree (`lib/session-token.ts:113-116`,
*"Session version mismatch — table has been reset"*). **That is the entire mechanism separating a
previous party from the next one**, and it only bites on the six guarded routes.

### tab

- **Lives in** `public.tabs`. Identified by `id uuid`.
- **Created by** `POST /api/tabs` — unauthenticated, needs `restaurantId` + `tableNumber`.
- **Belongs to** a restaurant and a table (`table_id` and a denormalised `table_number`).
- **Key columns** `status`, `total numeric`, `members jsonb`, `tab_pin text`, `pin_required bool`,
  `payment_preference`, `ready_to_pay_at`, `settled_at`, `settled_type`, `session_version`,
  `pin_reset_token` + `pin_reset_token_expires_at` (#265, migration `20260812130000`),
  `linked_unpaid_tab_id` (migration `20260814090000`).
- **Statuses observed in code**: `open`, `ready_to_pay`, `settled`, `closed`. `ACTIVE_TAB_STATUSES`
  in `lib/tab-status.ts` is the allowlist the landing uses.
- **At most one `open` tab per table**, enforced by a partial unique index. This is what makes the
  `23505` branch reachable (QRA-02).
- **`total` is a denormalised cache with exactly five writers** and none of them is a cancellation
  — see 1.7.

### tab PIN

- `tabs.tab_pin`, four digits from `Math.random()` (`lib/tabs/generate-tab-pin.ts`), generated at
  creation only when `restaurant_settings.tab_pin_required !== false`.
- **Returned to the creating device once**, in the create response (`app/api/tabs/route.ts:260`),
  and stored by that device in `sessionStorage.flashtap_creator_tab_pin`.
- On staging it is *also* returned by `GET /api/tabs/[tabId]` to any session-token holder, which is
  how a *joiner* can see it (`browse/page.tsx:300-324`). Production does not do this — QRA-04.
- Checked by `POST /api/tabs/join` and `POST /api/tabs/[tabId]/join`. **Not checked by
  `POST /api/tabs`** — QRA-02.
- Recovery is `POST /api/tabs/[tabId]/reset-pin` (staff, terminal-auth) minting a
  `crypto.randomUUID()` reset token with a 15-minute TTL, redeemed on the join route, which mints a
  new PIN in the same conditional UPDATE (#265).

### order request (`public.order_requests`)

The pre-Accept surface, and where a QR customer's submission actually lands.

- **Created by** `POST /api/orders` for `channel in ('table','kiosk')`.
- **Status** `waiting_review` → `accepting` → `accepted` | `declined`. The CHECK was widened to
  include `accepting` by migration `20260726120000`.
- **Three pricing tiers**, resolved in one place (`lib/orders/order-request-pricing.ts`,
  precedence `reviewed ?? customer ?? original`):
  - `items/subtotal/tax/total` — the customer's original submission, **never mutated after insert**
    (declared in the table definition as an audit trail).
  - `items_reviewed/*_reviewed` — staff edits during review.
  - `items_customer/*_customer` — the customer's own edit (staging only, migration `20260813120000`).
- **RLS is on** (`ENABLE` + `FORCE`), staff-scoped via `user_restaurant_ids()`; guest access is via
  service-role API routes only. No anon grants.
- **`accepted_order_id`** FKs to `orders(id)`, with
  `CHECK (status <> 'accepted' OR accepted_order_id IS NOT NULL)`. That constraint is *why*
  `accepting` exists — see 1.12.

### order (`public.orders`)

- **Created by** `createOrder` from the Accept route for QR, or directly by `POST /api/orders` for
  non-table/kiosk channels, or by the terminal/POS routes.
- **Identified by** `id uuid`; also carries `order_number` (per-restaurant counter),
  `kiosk_order_number`, `idempotency_key` (partial-unique), `paycloud_merchant_order_no`,
  `payment_reference`.
- **Statuses** the staff-settable set is `pending, accepted, preparing, ready, completed, cancelled`
  (`lib/orders/status-transitions.ts:2-9`), plus `ready_for_terminal` and `served` which appear as
  *current* states but are not staff-settable.
- **`orders.status` and `orders.payment_status` have no CHECK constraint** — recorded in the
  operating contract as the reason a closed TypeScript union would assert a guarantee the database
  does not make. Confirmed: no CHECK on either column in the migration set.

### order item

Not a table. `orders.items` and `order_requests.items` are `jsonb` arrays of priced lines. A line
carries `name`, `quantity`, `unitPrice`, `subtotal`, `tax`, `total`, `taxRatePercentage`,
`taxInclusive`, `selectedVariants`, `addons`, `specialInstructions`, `route_to`. **The absence of a
line table is why `repriceKeptLines` addresses lines by array INDEX** (see section 5), and why an
edit and a concurrent staff review cannot be merged.

### cart

Purely client-side (`contexts/cart-context.tsx`, `localStorage` keys `cart` / `cart_session_id`).
**Cart prices are display-only** — `POST /api/orders` calls `calculateOrderPricing` against the live
menu and writes *its* numbers, logging a warning on mismatch but never failing
(`app/api/orders/route.ts:384-395` on the legacy path; on the request path the client totals are not
even compared, `:306`).

### payment / transaction

- `orders.payment_status` — free text; values seen: `pending`, `cash_pending`, `terminal_pending`,
  `paid`, `failed`, `cancelled`.
- `orders.payment_checkout_url` + `paycloud_merchant_order_no` — a live Finatic hosted-checkout
  session. Its presence is what makes an order un-editable even at `payment_status = 'pending'`
  (`lib/orders/edit-lock.ts:173-175`).
- `public.payments`, `public.payment_events` — the ledger. One `payment_event` can cover many
  orders; `event.amount` is per-settle, never per-order.
- Hosted checkout for a QR order is created **at Accept, not at submission**
  (`accept/route.ts:254-282`), deliberately: *"payment must never trigger before Accept."*

### kitchen state / order status / payment status

There is **one** status column, not separate customer and kitchen states.
`lib/orders/active-order-visibility.ts` normalises it for display
(`normalizeOrderStatusForDisplay`), which is the only place the two vocabularies
(`order_requests` and `orders`) are reconciled. Anything making a status visible is required to go
through it — a rule the code states and enforces at
`lib/guest-orders/queries.ts:33-40`.

### customer-visible totals

Four different numbers are shown to a customer, from three different sources:

| Surface | Number shown | Source | Scope |
|---|---|---|---|
| browse tab strip | "Tab open • N$X" | `useTab().tabTotal` ← `/api/tabs/[tabId]/view` ← `tabs.total` | the whole tab (cached) |
| `/tab` | "**Full tab running total**" | client sum of `fetchOrdersForTab` | **this device's orders only** |
| `/tab` | "Tab total" (repeated at the foot) | same client sum | this device's orders only |
| `/my-orders` | "Total Spent" | client sum of `fetchGuestOrdersBySession` | this session's orders only |
| `/order-confirmation/[id]` | order total | the order row | one order |

See 1.7 and QRA-12.

### local/browser state

Complete inventory of customer-owned keys, gathered by grep at `4861492`:

`localStorage`: `flashtap_session_v1`, `flashtap_session_table_v1`, `flashtap_session_restaurant_v1`,
`flashtap_tab_id`, `flashtap_table`, `flashtap_session_token`, `flashtap_tab_session_id_mirror`,
`current_restaurant_id`, `cart`, `cart_session_id`.

`sessionStorage`: `flashtap_session_v1`, `flashtap_session_token`, `tab_session_id`,
`flashtap_tab_session_id` (legacy), `flashtap_session_expired`, `flashtap_session_ended_notice`,
`flashtap_display_name`, `flashtap_creator_tab_id`, `flashtap_creator_tab_pin`, `last_order_id`,
`flashtap_return_order_id`, `flashtap_return_table`, `flashtap_cart_idem_{rid}_{table}`.

## 1.2 What makes A and B members of the same table session

Concretely, and only this:

1. Both devices were handed a `customer_sessions` row pointing at **the same `tab_id`**, by one of
   the three issuing routes.
2. Both devices' `session_id` appears in that tab's `members` jsonb array.

(2) is bookkeeping for display only. **Nothing reads `members` as an authorisation.** Since #262's
fix, `alreadyMember` no longer exempts anyone from the PIN
(`app/api/tabs/[tabId]/join/route.ts:163` at `4861492` — the exemption is gone at both refs).

## 1.3 What remains individually owned

Only the pair (`orders.session_id`, `orders.member_session_id`). Every "is this mine?" question in
the product resolves to `ownsOrder(row, heldSessionIds())`. There is no per-member row, no
per-member balance, and no server-side notion of "A's share".

## 1.4 What stops Customer C, from another or a previous table session

Layer by layer, honestly:

| Attempt | What stops it | Strength |
|---|---|---|
| C reads the menu | nothing, by design | n/a |
| C reads *the tab's* total / member count | **nothing** — `/api/tabs/active` is unauthenticated and keyed on `restaurantId` + `tableNumber` | none |
| C reads the tab detail (members' display names) | **nothing** — `/api/tabs/[tabId]/view` is unauthenticated and keyed on the tab UUID, which `/api/tabs/active` hands out | none |
| C joins the tab | the 4-digit PIN, unthrottled … **or** `POST /api/tabs`'s `23505` branch, which asks for nothing (QRA-02) | none in practice |
| C reads a specific open order | `guestCanAccessOrder`: restaurant + (table number **or** a held session id). Table number is not a secret, so in practice: the order UUID (#279) | UUID possession |
| C reads a diner's whole order list | a session id, which `GET /api/orders?tabId=` publishes to token holders (QRA-05) | bearer id |
| C edits an order (staging) | `sessionOwnsRow` — a held session id, plus the edit lock | bearer id |
| C from a *previous* party at this table | `current_session_version`, but only on the six token-guarded routes | see section 11 |

## 1.5 Entity relationships

```
restaurants 1─* restaurant_tables 1─* tabs(status='open' at most one) 1─* customer_sessions
                       │                    │
                       │                    ├─ members jsonb  [{session_id, display_name, joined_at}]
                       │                    │
                       └────────────────────┴─* order_requests ──accepted_order_id──> orders
                                                     (pre-Accept)                     (post-Accept)
                                                          │                              │
                                                          └── session_id ────────────────┘
                                                              member_session_id
```

`schema.sql` declares only a fraction of the live FKs; the ones above were taken from the migration
DDL (`order_requests` FKs `restaurants(id)` and `orders(id)`; `customer_sessions` and `tabs` FKs are
not declared in the committed migration set and were not enumerated from PostgREST's OpenAPI for
this section because nothing in the audit's conclusions depends on them).

## 1.6 The three writers of `tabs.members`, and the one that was fixed

- `POST /api/tabs/join` → `add_tab_member` RPC, atomic. **Fixed.**
- `POST /api/tabs/[tabId]/join:173-184` → read-modify-write. **Not fixed.**
- `POST /api/orders:500-533` (legacy direct path) → read-modify-write. **Not fixed.**
- `POST /api/order-requests/[requestId]/accept:226-244` → read-modify-write. **Not fixed.**

Four writers, not three; QRA-09 records this.

## 1.7 `tabs.total` is a cache, and nothing invalidates it on cancellation

Every writer of `tabs.total`, enumerated at `4861492`:

1. `app/api/orders/route.ts:519-526` — after a direct (non-request) tab order.
2. `app/api/order-requests/[requestId]/accept/route.ts:235-244` — after Accept.
3. `app/api/guest/orders/[orderId]/edit/route.ts:511-531` — after a total-changing customer edit.
4. `lib/payments/mark-order-paid-confirmed.ts:131`.
5. `app/api/terminal/tabs/[tabId]/settle/route.ts:410-417` — recalculates at settlement, correctly
   excluding cancelled orders via `owesMoney()`.

**No writer fires when an order is cancelled.** `PATCH /api/orders/[orderId]/status` sets
`status='cancelled'`, `payment_status='cancelled'`, `is_closed=true` and writes an audit row
(`route.ts:99-103`, `:179-199`) — and touches no tab.

So between a cancellation and settlement, `tabs.total` overstates what is owed, and that is the
number the browse tab strip renders to every diner. The settle route is the only thing that
corrects it, and it does so at the moment of charging — so the customer is never *charged* the
inflated figure, but is *shown* it for the whole intervening period. Recorded as **QRA-12**.

---

# 2. THE COMPLETE HAPPY PATH

Restaurant exists. Table 12 has a permanent QR. No customers at Table 12. Customer A scans.

Traced at `4861492`. Production differences are marked **[prod]**.

## T0 — the scan

**CUSTOMER SEES** — nothing yet; a redirect.

**BEHIND THE SCENES**
- Riviera host: `middleware.ts:59-66` rewrites `/table/12` → `/menu/{RIVIERA_RESTAURANT_ID}/v2?table=12`.
  Otherwise `app/menu/[restaurantId]/page.tsx:23-36` client-redirects `?table=12` to `/v2?table=12`.
- `app/menu/[restaurantId]/layout.tsx` mounts `FeatureProvider > RestaurantProvider > TabProvider`
  (`CartProvider` is mounted higher up, `app/providers.tsx:44`).
  **`TabProvider` mints session id B on construction** — `useState(() => ensureTabSessionId())`
  (`contexts/tab-context.tsx:109`). So identity B exists before the customer has done anything.
- No API call yet. No server-side row.

## T1 — the landing (`/menu/{rid}/v2?table=12`)

**CUSTOMER SEES** restaurant logo and name, then one of: *Create Tab* / *Join the tab* / a rejoin
card / a view-only menu / an error.

**BEHIND THE SCENES**, in the order the effects run (`v2/page.tsx`):
1. `:187-199` if `sessionStorage.flashtap_session_expired === 'true'` → hard redirect to
   `/session-ended`.
2. `:201-208` `consumeSessionEndedNotice()` → clear tab, cart, banner state.
3. `:218-233` `getRestaurant(restaurantId)` — cached read. On failure: *"Please scan a valid QR
   code…"*.
4. `:238-336` table fetch. `getSupabaseTableByNumber(rid, 12, false)`.
   - not found → *"This table is not available for ordering."*
   - `is_view_only` → scrub tab + cart, render menu-only.
   - if a `flashtap_session_token` **and** a `flashtap_tab_id` are stored →
     `POST /api/session/validate`; a `410` triggers `handleSessionExpired`.
   - otherwise `createFreshSession(rid, '12')` mints identity **A** and `clearCart()`.
5. `:553-572` → `syncTabLandingState()`:
   - re-validates any stored token (`:378-397`);
   - validates any stored tab via `fetchTabById` → `/api/tabs/{id}/view` (unauthenticated);
   - if no stored tab: `fetchGuestActiveTableOrders({countOnly:true})` **with no session id** —
     permitted because `countOnly` bypasses the fail-closed guard
     (`lib/guest-orders/queries.ts:347-349`), so this counts *every* open order at table 12
     regardless of who placed it. Used only to decide whether to clear banner state.
   - `GET /api/tabs/active?restaurantId=…&tableNumber=12` → `{tab: null}` for an empty table.
6. `:574-644` three realtime subscriptions: the stored tab row, the `restaurant_tables` row, and
   all `tabs` for the restaurant (filtered client-side to this table). Plus a `window` `focus`
   listener that re-runs the sync.
7. `:654-…` a 10-minute-window lookup for a recent hosted-pending order, which can block ordering.

**STATE** after T1: `flashtap_session_v1` (A), `flashtap_session_table_v1`,
`flashtap_session_restaurant_v1`, `current_restaurant_id`, `tab_session_id` (B) + its mirror. No
server row.

## T2 — Create Tab

**CUSTOMER SEES** a display-name prompt, then *Create Tab*. On success, the tab PIN.

**BEHIND THE SCENES**
- `createNewTab` (`tab-context.tsx:417-487`) → `POST /api/tabs`
  `{restaurantId, tableNumber, sessionId: B, displayName, customer_name, linkedUnpaidTabId}`.
- Server (`app/api/tabs/route.ts`): resolve restaurant → load the `active` table row → refuse if
  `is_view_only` → read `restaurant_settings.tab_pin_required` → `generateTabPin()` if required →
  validate `linkedUnpaidTabId` (same restaurant, still unpaid, different table; anything else
  stores null) → INSERT `tabs {status:'open', members:[{session_id:B,…}], total:0, tab_pin,
  pin_required, linked_unpaid_tab_id}`.
- On `23505` → **the PIN-free branch (QRA-02)**.
- `UPDATE restaurant_tables SET status='occupied'`.
- `issueTokenForOpenTab` → reads `current_session_version`, writes it to `tabs.session_version`,
  INSERTs `customer_sessions {token, tab_id, table_id, restaurant_id, session_version, active:true,
  expires_at: +24h}`.
- Response `{tabId, sessionToken, tabPin}`. Client stores the token in **both** `sessionStorage` and
  `localStorage` (`tab-context.tsx:471-474`) and `persistTabSession(tabId, '12')`.

**INVARIANT NOTE** — the tab-create response is the only time the PIN is returned on production.

## T3 — the menu (`/menu/{rid}/browse?table=12&tabId=…`)

**CUSTOMER SEES** header (logo, restaurant name, Receipt link, My Orders, Cart+badge), the tab strip
(*"Tab open • N$0.00 • 1 person • PIN: 4821 — Tap to settle →"*), an `OrderStatusBanner`, a
`MenuOrderStatusTracker`, search, category chips, item cards.

**BEHIND THE SCENES**
- Authoritative view-only re-check (`browse/page.tsx:108-129`), never trusted from a URL flag.
- `fetchTabById(effectiveTabId, restaurantId)` → `/view` → sets `pin_required`.
- `GET /api/tabs/{tabId}` with `x-session-token` → `tab.tab_pin` **[staging only; prod returns no
  PIN, so a joiner sees no PIN and only the creator's `sessionStorage` copy is shown]`.
- `TabProvider.loadTab` → `/api/tabs/{tabId}/view?restaurantId&sessionId=A&sessionId=B` →
  `{tab:{…, members:[{display_name, joined_at, member_key}]}, self_member_keys:[…]}`.
  `member_key` is an opaque per-tab derivation of the session id (#262).
- Realtime: `supabase.channel('tab-…').on('postgres_changes', {table:'tabs', filter:'id=eq.…'})`
  → `loadTab()`. Note the subscribe effect is gated `if (tabId && tabStatus) return`
  (`tab-context.tsx:245`) so it subscribes once per `(restaurantId, tabId)`.
- Menu loading is the `lib/menu/load-menu-categories` path with distinct
  loading / empty / failure states (#214).

## T4 — item selection and the item popup

**CUSTOMER SEES** `ItemDetailModal` — image, name, description, variant groups, add-ons,
per-item note, quantity, and an *Add* button carrying the computed price.

**BEHIND THE SCENES** entirely client-side. `lib/menu/variant-groups.ts` computes the display price
and the default selection; `isRequiredVariantMissing` blocks Add. Nothing is sent to the server.
Cart lines are merged by `lib/cart/cart-line-identity.ts`.

**Not every item opens the popup today** — that is the `feat/a-popup-every-item` branch, not on
staging. Section 17 addresses it.

## T5 — the cart (`/menu/{rid}/cart?…`)

**CUSTOMER SEES** lines with edit/remove, an order note, a total, and **Add to Tab** (tab flow) or
**Place Order** / **Pay Securely** (non-tab flow).

**BEHIND THE SCENES** — `handleAddToTab` (`cart/page.tsx:270-344`):
- refuses locally if `tabStatus === 'ready_to_pay'`;
- builds the payload with `sessionId: B` written to **both** `sessionId` and `memberSessionId`;
- mints/reads `flashtap_cart_idem_{rid}_{table}` (a `crypto.randomUUID()` in `sessionStorage`) and
  sends it as `x-idempotency-key`;
- `fetchWithSession('/api/orders', …)` — attaches `x-session-token`, and on `410` calls
  `handleSessionExpired`.

## T6 — order creation (`POST /api/orders`)

Server, in order (`app/api/orders/route.ts`):

1. `:56-62` per-line quantity cap for `table`/`kiosk` (`validateOrderQuantities`).
2. `:73-90` view-only refusal, **unconditional**, before any tab branch.
3. `:96-107` **session-token guard — only if `tabId` was supplied** (QRA-07), then
   `assertSessionMatchesResource(token → restaurant, tab)`.
4. `:120-156` tab load: `ready_to_pay` → 400 *"you cannot add more items"*; non-`open` → 400.
5. `:158-178` if **not** a tab order: require that *some* open tab exists at the table.
6. `:186-207` `checkStockSufficiency` — refuses with `409` + the full `outOfStock` list.
   **A failure to READ stock is swallowed and the order proceeds** (`:202-207`), deliberately.
7. `:210-269` payment-method allowlist, applied to the **resolved** method (#124) and **skipped for
   tab orders** (#202) because the method is chosen at settlement instead.
8. `:271-299` table row must exist and be `active`; kiosk channel must be an `is_kiosk` table.
9. `:305-365` **`calculateOrderPricing`** against the live menu, then INSERT `order_requests`.
   Client `subtotal`/`total` are not read at all on this path.
10. `23505` on `idempotency_key` → return the existing request id.

**Response** `{success:true, orderId:<request id>, requestId, status:'waiting_review',
paymentStatus:'waiting_review'}`.

## T7 — customer confirmation

**Two different destinations, depending on flow:**

- **Tab flow** (`handleAddToTab:329-334`): `clearCart()`, a toast — *"Request sent! Waiting for the
  restaurant to confirm — keep ordering or settle when ready."* — and
  `router.replace('/menu/{rid}/browse…')`. **The customer goes back to the menu; there is no
  confirmation page.**
- **Non-tab flow** (`handlePlaceOrder:416-430`): `router.replace('/menu/{rid}/order-confirmation/{orderId}?table=12')`.

Both write `last_order_id`, `flashtap_return_order_id`, `flashtap_return_table` to `sessionStorage`
and clear the idempotency key.

## T8 — the kitchen receives it

`order_requests` has RLS ON with a staff policy scoped by `user_restaurant_ids()`. The dashboard's
"Waiting for Review" list selects `status = 'waiting_review'` and evicts anything else
(`lib/supabase/order-requests.ts:19`, `:42-44`). Staff see the submitted items, the customer name,
the table, and the total.

## T9 — the restaurant accepts (`POST /api/order-requests/[requestId]/accept`)

1. Load the request; `requireStaffPermission(ORDERS_UPDATE)`.
2. Already `accepted` → idempotent return of `accepted_order_id`.
3. **Atomic claim**: `UPDATE … SET status='accepting' WHERE status='waiting_review'` returning the
   row. Zero rows → `409 "Order request already handled"`.
4. `effectiveRequestPricing(claimed)` → `reviewed ?? customer ?? original`.
5. `enrichOrderItemsWithRouteTo` → kitchen routing.
6. `createOrder({..., preauthorizedPricing})` — Accept does **not** take a third pricing pass, so
   the customer is charged exactly what was quoted and reviewed.
7. Finalize: `UPDATE … SET status='accepted', accepted_order_id, decided_at, decided_by
   WHERE status='accepting'`.
8. Kiosk numbering; **tab members + `tabs.total` re-sum** (read-modify-write, errors discarded);
   hosted-checkout session for non-tab hosted orders (best effort, failures logged only).

**Nothing here is transactional.** The claim, the order insert and the finalize are three
round-trips, and the route says so: a row *can* be stranded in `accepting`, at which point it is
absent from the staff list, refused by accept/decline/review, swept by nothing, and still reads
*"Waiting for confirmation"* to the customer.

## T10 — preparation and ready

`PATCH /api/orders/[orderId]/status` with `requireStaffPermission(ORDERS_UPDATE)`.
`isValidStaffStatusTransition` allows `pending→accepted`, `accepted→preparing`,
`preparing→ready`, `ready→completed`, `ready_for_terminal→accepted`, and `*→cancelled` except from
`completed`/`cancelled`. The write is a CAS on the status that was read.

**[staging]** moving out of `{pending, accepted}` also NULLs the three `edit_lock_*` columns — the
whole of "staff wins".

The customer learns about it by **polling**: `/order-confirmation/[orderId]` polls every
`GUEST_ORDER_POLL_MS = 5000`, `my-orders` polls every 5s, `MenuOrderStatusTracker` polls. There is
**no realtime subscription on `orders` for the customer** — see section 12.

## T11 — settlement

The customer's role ends at *"Ready to pay"*: `POST /api/tabs/[tabId]/ready-to-pay` sets
`status='ready_to_pay'` and a `payment_preference` (validated against
`restaurant_settings.payment_methods`), CAS'd with `.neq('status','ready_to_pay')`.

The charge itself happens on the staff terminal
(`app/api/terminal/tabs/[tabId]/settle/route.ts`), which re-derives the payable amount from the
tab's orders with `owesMoney()` — cancelled orders excluded — writes `payment_status='paid'` on the
claimed orders, records the payment, and updates `tabs.total` to the recalculated figure.

## T12 — table session closure

`POST /api/tables/[tableNumber]/close` → the `close_table_session` RPC, which settles the tab,
resets `restaurant_tables.status`, and **increments `current_session_version`**. Every
`customer_sessions` row stamped with the old version fails `validateSessionToken` from that moment.

---

# 3. EVERY CUSTOMER-FACING SCREEN

Fifteen routes are reachable by a QR customer. Auth column states what the SERVER checks.

| # | Route | Component | Purpose | Auth for its data |
|---|---|---|---|---|
| 1 | `/menu/[rid]` | `page.tsx` | redirect shim to `/v2` | none |
| 2 | `/menu/[rid]/v2?table=N` | `MenuLandingPageV2Content` | QR landing: create/join/rejoin | none |
| 3 | `/menu/[rid]/browse` | `MenuBrowsePage` | menu + tab strip + trackers | none for menu; session token for the PIN read |
| 4 | `/menu/[rid]/cart` | `CartPage` | cart, note, submit | session token **only** when `tabId` present |
| 5 | `/menu/[rid]/my-orders` | `MyOrdersPage` | the order record | session id (bearer) |
| 6 | `/menu/[rid]/order-confirmation/[orderId]` | `OrderConfirmationPage` | one order + **the editor** | `guestCanAccessOrder` (restaurant + table **or** session id) |
| 7 | `/order-confirmation?orderId=…` / `?tn=…` | root page | gateway return + receipt | `guestCanAccessOrder`, or payment-ref |
| 8 | `/menu/[rid]/tab` | `TabPage` | tab review + ready-to-pay | none for the read; session token for ready-to-pay |
| 9 | `/menu/[rid]/receipt` | `ReceiptPage` | tab receipt view | session id (bearer) |
| 10 | `/menu/[rid]/order-secure` | `OrderSecurePage` | hosted-checkout launcher | none |
| 11 | `/menu/[rid]/session-ended` | `SessionEndedPage` | terminal state | none |
| 12 | `/menu/[rid]/kiosk` | kiosk entry | kiosk name capture | none |
| 13 | `/menu/[rid]/kiosk-success` | kiosk confirmation | kiosk order label | none |
| 14 | `/flashtap-pay/checkout` | hosted checkout shim | provider hand-off | none |
| 15 | `/session-ended` | non-flashtap.app host variant | terminal state | none |

## 3.1 Per-screen detail (the six that matter)

### `/menu/[rid]/v2` — the landing

- **Displays** logo, name, table number, and a branch: view-only notice · *Create Tab* ·
  *Join the tab at Table N* (PIN entry) · a rejoin card when a stored tab exists ·
  `TAB_ELSEWHERE_COPY` when the stored tab is at a different table (#211) · a
  *Payment in progress* card · a *Get My New PIN* card when `?pinReset=` is present (#265) ·
  `ActiveOrderBanner` · `OrderStatusBanner`.
- **Data** `getRestaurant` (cached), `getSupabaseTableByNumber`, `POST /api/session/validate`,
  `GET /api/tabs/active`, `fetchTabById` → `/api/tabs/[tabId]/view`,
  `fetchGuestActiveTableOrders(countOnly)`.
- **Realtime** three channels (stored tab, table row, all restaurant tabs) plus a `focus` listener.
- **Refresh** full re-sync; idempotent.
- **Back** ordinary.
- **Stale session** validated on every sync; a `410` hard-redirects to `/session-ended`.
- **Closed tab** `isTabSessionEndedStatus` → `endTabSession(true)` → notice + clear.
- **`// @ts-nocheck`** (QRA-10).

### `/menu/[rid]/browse` — the menu

- **Displays** header with **Receipt**, **My Orders**, **Cart** (badge); the **tab strip** with
  running total, person count, PIN and *Tap to settle*; `OrderStatusBanner`;
  `MenuOrderStatusTracker`; search; categories; item grid.
- **Refresh** re-fetches everything.
- **Back** from cart returns here with the tab strip re-derived from context.
- **Data sources for the same facts**: the tab total comes from `tabs.total` here and from a client
  sum on `/tab` — different numbers (QRA-12).

### `/menu/[rid]/cart`

- Two mutually exclusive submit buttons keyed on `inTabFlow`. Tab flow → back to browse with a
  toast. Non-tab flow → the per-order confirmation page. Card-online → `/order-secure`.
- **Idempotency** per `(restaurant, table)` in `sessionStorage`, cleared only on success.

### `/menu/[rid]/my-orders`

- **Displays** "My Orders", `Table {sessionInfo.table} • Session active since {…}`, Total Orders,
  **Total Spent**, one card per order (number, time-ago, total, status badge, up to 3 items,
  *Change this order* when editable, payment badge), and *Order More Items*.
- **Data** `fetchGuestOrdersBySession({sessionIds:[A,B], includeDeclined:true})`, polled every 5 s.
  Filters out `is_closed === true`.
- **Two defects visible in this file alone**, both VERIFIED:
  - `:159-162` renders `sessionInfo.created`, and `getSessionInfo()` (`lib/session.ts:66-80`)
    returns only `{sessionId, restaurant, table}`. **The field does not exist**, so this always
    reads *"Session active since N/A"*. **QRA-13, P3.**
  - `:49-54` if `getCurrentSession()` (identity **A**) is null it `alert()`s *"No active session"*
    and bounces to the landing — where `createFreshSession` **refuses to mint** while a
    `flashtap_session_token` exists (`lib/session.ts:22-30`). Pressing *End Session* on this very
    screen calls `clearSession()`, which removes A but leaves the token. **QRA-11, P2** — a
    customer who taps End Session mid-meal can be locked out of My Orders until the token expires
    or the tab closes.
- **`// @ts-nocheck`.**

### `/menu/[rid]/order-confirmation/[orderId]`

- The **only** place the order editor lives (`OrderEditPanel` in the `editSlot`).
- Polls every 5 s until `payment_status === 'paid'`.
- On a `null` row it `router.push('/menu/{rid}')` — i.e. a refused read is indistinguishable from a
  missing order and silently bounces the customer to the landing.

### `/menu/[rid]/tab`

- **Displays** *"Table N Tab"*, the creator's PIN if this device created the tab, **"Full tab
  running total"**, per-member groups with *Member subtotal*, a repeated *"Tab total"*,
  *+ Order More*, and the ready-to-pay payment-preference selector.
- **The two totals are the same client-side sum of THIS DEVICE'S ORDERS** —
  `fullTabRunningTotal = ordersForDisplay.reduce(...)` (`:205-208`) over `fetchOrdersForTab`, which
  is `fetchGuestOrdersBySession` with the tab id as a *refinement* on top of a mandatory session
  scope (`lib/tab-session.ts:149-174`, `lib/guest-orders/queries.ts:168-170`). **QRA-12** — this is
  #119, confirmed still live.
- Member groups are built from `tabMembers` (all members) but populated only from this device's
  orders, and then filtered by `g.items.length > 0` (`:202`) — so **other diners vanish from the
  tab screen entirely**.

## 3.2 DUPLICATION — named explicitly

This is the part of section 3 the brief singles out. Every item below is VERIFIED at `4861492`.

**D1 — the tab total appears on three screens from two different sources, and they disagree.**
Browse's strip renders `tabs.total` (whole tab). `/tab` renders a client sum of this device's orders
— **twice**, at `:348` and `:393`, labelled *"Full tab running total"* and *"Tab total"*.
`/receipt` renders a third instance of the same session-scoped sum (`tabGrandTotal`, `:297-299`).
My Orders renders a fourth, labelled *"Total Spent"*. Four figures, three of them client-computed
from a session-scoped query, one of them a server cache — and none of them labelled with its scope.

**D2 — two screens both behave like "the place orders live".**
`/menu/[rid]/my-orders` lists the session's orders; `/menu/[rid]/tab` lists the same orders grouped
by member; `/menu/[rid]/receipt` lists them again with payment status. All three poll
`fetchGuestOrdersBySession` on a 5-second interval. Three screens, one query, three layouts.

**D3 — there are TWO order-confirmation screens and the same list links to both.**
`my-orders:212` navigates a card tap to `/order-confirmation?orderId=…` (the **root** route,
805 lines, built for the gateway return path), while `my-orders:265` navigates the *Change this
order* button to `/menu/[rid]/order-confirmation/[orderId]` (the per-order route, 291 lines, the
only one carrying the editor). **Tapping the card and tapping the button on the same card land on
two different screens with different capabilities.**

**D4 — editing is attached to a screen whose conceptual purpose is confirmation.**
`OrderEditPanel` is mounted in the `editSlot` of `OrderConfirmationView`
(`order-confirmation/[orderId]/page.tsx:259-281`). The list screen's own comment acknowledges it:
*"Routes to the per-order confirmation screen, which is where the editor lives — one place a
customer can change an order from, rather than a second editor embedded in a list card."*
The brief's redesign proposal targets exactly this.

**D5 — order status is rendered by at least five independent vocabularies.**
`my-orders:94-105` has its own `configs` map; `components/receipt/receipt-types.ts`
`mapOrderStatusToBadge` has another; `lib/orders/receipt-status.ts` a third;
`components/menu/menu-order-status-tracker.tsx` a fourth (which carried its own private copy of
the ownership check until 2026-08-14); `OrderStatusBanner` a fifth.
`normalizeOrderStatusForDisplay` is meant to be the single vocabulary and is applied at the
*query* layer, not at these render sites.

**D6 — the PIN has three render sites and two sources.**
`browse` tab strip (`:865`, from `fetchedTabPin ?? creatorTabPin`), `/tab` (`:337-342`, from
`creatorTabPin` **only**), and the create-tab success card on the landing. The commit at the tip of
staging (`4861492`, *"the PIN rendered twice; keep the strip's, drop the header line"*) removed a
fourth. `/tab`'s copy still shows nothing to a joiner even on staging, because it never reads the
session-token-guarded value.

**D7 — "Order More" exists on three screens** — `/tab:408` (*+ Order More*),
`/my-orders:312` (*Order More Items*), and implicitly the browse header — all three of which
navigate to the same `browse` URL.

**D8 — two "notify the waiter" affordances that write to different tables.**
`/tab` writes `tabs.status = 'ready_to_pay'`; `/order-confirmation/[orderId]` offers
`ReadyToPayTerminalButton` / `ReadyToPayCashButton`, which write
`orders.customer_ready_to_pay` / `orders.status = 'ready_for_terminal'`. A customer can trigger
both, and nothing reconciles them.

---

## QRA-11 — End Session locks the customer out of My Orders

**Severity P2. VERIFIED at both refs.**

`app/menu/[restaurantId]/my-orders/page.tsx:83-89` — *End Session* calls `clearSession()`
(`lib/session.ts:87-95`), which removes `flashtap_session_v1`, `flashtap_session_table_v1` and
`flashtap_session_restaurant_v1`. It does **not** remove `flashtap_session_token`,
`flashtap_tab_id`, `tab_session_id` or the mirror.

The customer is then pushed to `/menu/{rid}/v2`. There, `createFreshSession`
(`lib/session.ts:22-30`) refuses to mint a replacement:

```ts
const existingToken = localStorage.getItem('flashtap_session_token') ||
                      sessionStorage.getItem('flashtap_session_token')
if (existingToken) {
  console.log('[SESSION] blocked createFreshSession — session token exists, …')
  return null
}
```

So identity **A** stays absent while the token lives. Returning to My Orders now hits `:49-54`:

```ts
if (!sessionId) { alert('No active session. Please scan the QR code to start ordering.'); router.push(...) }
```

which pushes back to the landing, which cannot mint. **A loop.** It resolves only when the token
expires (24 h), the tab closes, or the customer lands on `/session-ended` (which *does* clear the
token). The customer's orders are still visible on `/tab` and `/receipt` because those screens use
identity **B**, so the failure is partial and screen-specific, which makes it harder to recognise.

---

## QRA-12 — "Full tab running total" is one device's own orders

**Severity P1. VERIFIED at `4861492`.** Invariant falsified: **INV-8**.
Tracked as **#119**, OPEN, described there as a launch-blocker. Confirmed still live.

`app/menu/[restaurantId]/tab/page.tsx`:

```ts
:109  const rows = await fetchOrdersForTab(storedTabId, restaurantId, getCurrentSession())
:129  ordersForDisplay = orders.filter(o => !o.tab_settlement_for_tab_id)
:205  const fullTabRunningTotal = useMemo(
        () => ordersForDisplay.reduce((sum, order) => sum + (Number(order.total) || 0), 0), …)
:345  <p>Full tab running total</p>
:348  {fullTabRunningTotal.toFixed(2)}
:393  Tab total {currency}{fullTabRunningTotal.toFixed(2)}
```

`fetchOrdersForTab` (`lib/tab-session.ts:149-174`) calls `fetchGuestOrdersBySession` with the tab
id as an **optional refinement** on top of a **mandatory session scope**. The server-side function
fails closed without session ids (`lib/guest-orders/queries.ts:168-170`) and filters
`.in('session_id' | 'member_session_id', sessionIds)` (`:187`, `:245`). It cannot return another
diner's orders, by construction.

So the figure under the words *"Full tab running total"* is the sum of **this device's own
orders**, rendered twice on the same screen. On a two-person tab it is roughly half the truth.

The same screen is the one that offers *Ready to pay* and the payment-preference selector, so the
customer chooses how to pay against a number that is not what is owed. The **charge** is unaffected
— `app/api/terminal/tabs/[tabId]/settle/route.ts:378-417` re-derives the payable amount from the
tab's orders with `owesMoney()` — so this is a disclosure/expectation defect, not a mischarge.

**Second-order effect on the same screen.** `groupedOrders` (`:133-203`) iterates `tabMembers`
(every member of the tab) but populates each group only from this device's orders, then drops
empty groups at `:202` (`.filter(g => g.items.length > 0)`). **Other diners are therefore absent
from the tab screen entirely**, so nothing on the page hints that the total is partial.

The browse tab strip, by contrast, renders `useTab().tabTotal` from `/api/tabs/[tabId]/view` from
`tabs.total`, which *is* the whole tab. **Two screens, two numbers, one label.**

---

## QRA-13 — "Session active since N/A", always

**Severity P3. VERIFIED at both refs.**

`app/menu/[restaurantId]/my-orders/page.tsx:159-162` renders
`sessionInfo.created ? new Date(sessionInfo.created).toLocaleTimeString() : 'N/A'`.
`getSessionInfo()` (`lib/session.ts:66-80`) returns exactly
`{ sessionId, restaurant, table }` — there is no `created` key and nothing ever writes one. The
ternary is therefore constant. Cosmetic, and included only because it is the kind of thing a
redesign carries forward as if it worked.

---

## QRA-14 — `close_table_session` is EXECUTE-able by `anon`, and only table grants stop it

**Severity P2 (defence-in-depth). VERIFIED on staging by direct catalogue read. Production state
UNPROVEN — see below.** This is the invariant-attack result for **INV-6**, and **the attack
failed** — recorded per the brief's instruction to write up an invariant that held.

The function is the whole of table-session eviction
(`supabase/migrations/00000000000000_baseline.sql:64-124`): in one plpgsql body it settles every
active tab for the table (`settled_type='manual_close'`), sets every linked `customer_sessions` row
to `active=false, expires_at=now()`, and increments
`restaurant_tables.current_session_version`. One transaction, `RAISE` on any error. **This is also
the answer to "what stops an old party from reaching a new one's data" — see section 11.**

It is granted to `anon`:

```
baseline.sql:3279  GRANT ALL ON FUNCTION "public"."close_table_session"(uuid, uuid) TO "anon";
```

and **no migration in the committed set revokes it** — grepped across every `REVOKE` statement in
`supabase/migrations/`; `20260727140000` and `20260727150000` are the two sweeps of stray
`SECURITY DEFINER` grants and neither names this function.

### Why it is not exploitable, measured rather than assumed

Read-only catalogue queries against the linked **staging** project:

```sql
select routine_name, security_type from information_schema.routines
  where routine_schema='public' and routine_name in ('close_table_session','add_tab_member');
--  close_table_session | INVOKER
--  add_tab_member      | DEFINER

select grantee, privilege_type from information_schema.role_table_grants
  where table_schema='public' and table_name='tabs' and grantee in ('anon','authenticated');
--  authenticated | INSERT / SELECT / UPDATE      (anon: no rows at all)
```

`close_table_session` is **SECURITY INVOKER**, so it runs with the caller's privileges. `anon` holds
no table-level privilege on `public.tabs` — migration `20260726200000` did
`REVOKE ALL ON TABLE public.tabs FROM anon` and re-granted only column-level `SELECT`. The first
statement in the function is `UPDATE tabs …`, so an anon call raises `42501` and the function's
`EXCEPTION WHEN OTHERS THEN RAISE` propagates it. Nothing is written.

**So the invariant holds — but by one layer, and not the one that looks like the control.** The
EXECUTE grant says "anon may run this"; what actually stops it is a table grant in a different
migration. Anything that ever gives `anon` an `UPDATE` on `tabs` — for instance to let a client
write `payment_preference` directly — turns this into an unauthenticated close-any-table primitive
that settles tabs and evicts every diner.

### The negative result on the rest of the RPC surface

The same query, generalised: exactly **five** `SECURITY DEFINER` functions are EXECUTE-able by
`anon` on staging — `notify_kitchen_on_new_order`, `user_has_permission`, `user_organization_ids`,
`user_owner_organization_ids`, `user_restaurant_ids`. The first is a trigger function (invoking it
directly outside a trigger context errors); the other four are the RLS helper predicates, which
return the *caller's* scope and are therefore empty for `anon`. **No anon-executable
`SECURITY DEFINER` function performs a privileged write.** `add_tab_member` — the one DEFINER
function that does write, and the atomic member append — is **not** granted to `anon`.

That is a clean negative and it is worth stating as one: I looked for an RPC-level privilege
escalation on the customer surface and there is not one.

### Production

**#263** is open precisely because *"Production RLS state cannot be established from the ledger —
20260726200000 is live with no committed production apply path."* The mitigation measured above
**is that migration's grants**. So on production the mitigation is exactly as established as #263
says it is: not. Settling it means the same two catalogue `SELECT`s against the production
database — read-only and safe — and was not done here because this checkout is linked to staging
and re-linking is a state change to a checkout other agents share.

---

## QRA-15 — cancelling an order does not re-sum the tab

**Severity P1. VERIFIED at both refs.** Invariants: **INV-8**, **INV-10**.

`tabs.total` is a denormalised cache, and it is what every customer surface that claims to show the
tab renders (the browse strip, via `useTab().tabTotal` from `/api/tabs/[tabId]/view`). Its complete
writer set at `4861492`, enumerated by grep over `app/` and `lib/`:

| # | Site | Trigger |
|---|---|---|
| 1 | `app/api/orders/route.ts:519-526` | a direct (non-request) tab order lands |
| 2 | `app/api/order-requests/[requestId]/accept/route.ts:235-244` | staff Accept |
| 3 | `app/api/guest/orders/[orderId]/edit/route.ts:511-531` | a total-changing customer edit (staging only) |
| 4 | `lib/payments/mark-order-paid-confirmed.ts:131` | a confirmed payment |
| 5 | `app/api/terminal/tabs/[tabId]/settle/route.ts:410-417` | settlement — recalculates with `owesMoney()` |

**Cancellation is not in that list.** `PATCH /api/orders/[orderId]/status` with
`status: 'cancelled'` writes `status`, `payment_status='cancelled'`, `is_closed=true`,
`cancellation_reason` and an audit row (`route.ts:99-103`, `:179-199`) and touches no tab.

So from the moment staff cancel a line item's order until the terminal settles the tab, every diner
at that table is shown a running total that includes money nobody owes. On a table that cancels an
order and then keeps ordering for another hour, the figure is wrong for that hour.

**The charge is not affected.** `settle/route.ts:378-417` partitions in JS with `owesMoney()` rather
than `.neq('payment_status','paid')` in SQL, and the comment there records exactly why:

> *"`.neq('payment_status','paid')` in SQL is deliberate\[ly avoided]: 'not paid' is true of a
> CANCELLED order, so a cancelled order's money kept being reported as owed."*

That lesson was learned and applied at the settle site and at the table-closeability check
(`:508-519`) — and not at the point where the cached total is maintained. So the system charges
correctly and *displays* incorrectly, which is the harder failure to notice.

**Writers 1, 2 and 3 also discard their own errors.** Site 2 is
`await supabase.from('tabs').update({ total: nextTotal, members }).eq('id', request.tab_id)` with
no destructuring of `error` at all; sites 1 and 3 log and continue by explicit design. A failed
re-sum is therefore indistinguishable from a successful one from anywhere in the system.

---

# STAGE 2

---

# 4. MULTI-CUSTOMER TABLE BEHAVIOUR

## Event 4A — Customer A arrives and orders Burger N$80 + Coke N$20

Traced at `4861492`. The **prices shown are not the prices stored**: `calculateOrderPricing` reads
the live menu and overwrites both (`app/api/orders/route.ts:306`, `:323-326`).

Resulting server state:

| Row | Values |
|---|---|
| `restaurant_tables` | `status` → `'occupied'`; `current_session_version` unchanged |
| `tabs` | one row, `status='open'`, `total=0`, `tab_pin='NNNN'`, `pin_required=true`, `members=[{session_id: B_A, joined_at, display_name}]` |
| `customer_sessions` | one row, `token=<uuid>`, `tab_id`, `table_id`, `restaurant_id`, `session_version=<table's>`, `active=true`, `expires_at=+24h` |
| `order_requests` | one row, `status='waiting_review'`, `tab_id`, `session_id=B_A`, `member_session_id=B_A`, `items=[…]`, `subtotal/tax/total` from the server |
| `orders` | **none** |

**Kitchen state:** the request appears in the staff *Waiting for Review* list
(`lib/supabase/order-requests.ts:14-23`). There is no kitchen ticket and no `route_to` enrichment
yet — both are deferred to Accept.

**Ownership:** the only ownership fact recorded anywhere is `session_id`/`member_session_id` on the
request row. `tabs.members` records that B_A is *at the table*; nothing links a member entry to an
order.

**`tabs.total` is still 0** until staff Accept. So A's own tab strip reads *"Tab open • N$0.00"*
while A's order sits in the queue. VERIFIED — the only writer that would move it on this path is
the Accept route.

## Event 4B — Customer B scans the same QR on another phone

`/menu/{rid}/v2?table=12` loads. `TabProvider` mints B's own `tab_session_id` (B_B) on construction.
`createFreshSession` mints B's `flashtap_session_v1` (A_B). `syncTabLandingState` finds no stored
tab, so `GET /api/tabs/active?restaurantId&tableNumber=12` returns
`{tab:{id, status:'open', total, pin_required:true, member_count:1}}` — **unauthenticated**.

**B sees** *"A tab is already open at this table"* with the running total, the person count, and a
**Join** action that opens PIN entry.

Answering the brief's questions, each with what the server actually does:

| Question | Answer | Evidence |
|---|---|---|
| Does B join the same table session? | Yes, once B passes the PIN — `POST /api/tabs/join` issues a `customer_sessions` row for the **same** `tab_id`. | `app/api/tabs/join/route.ts:74-80` |
| …or without the PIN? | **Yes, unconditionally, via `POST /api/tabs`** — QRA-02. | `app/api/tabs/route.ts:150-227` |
| Does B join the same tab? | Yes; there is only one open tab per table. | `idx_tabs_one_open_per_table` |
| Can B **see** A's order? | **Not through any screen.** Every list B's screens use is session-scoped (`fetchGuestOrdersBySession`, `fetchGuestActiveTableOrders`) and B holds none of A's ids. But `GET /api/guest/orders/{A's order id}?restaurantId&table_number=12` **does** return it, on the table-number branch alone — B just has no way to learn the id from the product. | `lib/guest-orders/validation.ts:43-45`; #279 |
| Can B see A's **identity**? | Display name only. `tabs.members` is redacted to an opaque per-tab `member_key` on both reads (`/api/tabs/[tabId]/view` and `/api/tabs/[tabId]`). B sees `display_name`, never A's `session_id`. | `lib/tab-member-key.ts`; `/view` route |
| …except | `GET /api/orders?tabId=` returns **raw `session_id` per order** to any token holder. QRA-05. | `app/api/orders/route.ts:689` |
| Can B **edit** A's order? | **No** — `sessionOwnsRow` matches only ids B supplies against the row's two placer columns; B gets `404`. Unless B has harvested A's session id (QRA-05). | `edit/route.ts:139-146`, `:250-252` |
| Can B **cancel** A's order? | **No customer cancel exists at all.** `grep -rn cancel app/api/guest/` returns nothing. The edit route refuses an empty order with *"An order needs at least one item. Ask staff to cancel it instead."* | measured; `EDIT_COPY.cannotEmpty` |
| Can B **pay** A's order? | Not directly. B can mark the whole tab `ready_to_pay`, which is what summons the terminal. | `ready-to-pay/route.ts` |
| Can B settle the whole tab? | B can *request* it. The charge is taken by staff on the terminal. | `app/api/terminal/tabs/[tabId]/settle/route.ts` |
| What identifies A separately from B? | `orders.session_id` / `member_session_id`, and a `members[]` entry. Nothing else. | — |
| What identifies them as one table session? | Two `customer_sessions` rows with the same `tab_id`, both stamped with the table's `current_session_version`. | `lib/session-token.ts:37-71` |

## Event 4C — B orders Steak N$150

The result is **one tab containing two order requests**, which become **two orders** at Accept.
There is no merging and no per-member sub-tab.

What each party sees, at `4861492`:

| Viewer | Sees |
|---|---|
| **A** | browse strip: `tabs.total` (both orders, after Accept). `/tab`: **only A's own N$100**, labelled *"Full tab running total"* — QRA-12. `/my-orders`: only A's order. |
| **B** | symmetric: `/tab` shows only B's N$150 under the same label. |
| **Kitchen** | two separate *Waiting for Review* cards, then two orders. |
| **Live Orders / KDS** | two orders, each with its own `order_number`. |
| **Terminal** | one tab, with the settle route summing all non-settlement orders with `owesMoney()`. |
| **Reporting** | two orders. |

**The authoritative tab total is `tabs.total`**, maintained by the five writers listed in QRA-15 and
authoritatively recomputed only at settlement (`settle/route.ts:410-417`). The customer-visible
figures on `/tab` and `/receipt` are **not** it.

---

# OWNERSHIP SEMANTICS — what an order is owned by, from what the server enforces

The brief asks this to be answered from enforcement, not naming. Enumerated, the server enforces
**three different owners depending on the operation**, and they are not nested:

| Operation | Enforced owner | Where |
|---|---|---|
| **Read one order** | the RESTAURANT plus *either* the TABLE *or* the SESSION. A closed/paid/completed/cancelled order needs only the restaurant. | `guestCanAccessOrder`, `lib/guest-orders/validation.ts:24-61` |
| **List orders** | the SESSION, always. Fails closed with no session ids. | `fetchGuestOrdersBySession:168-170`; `fetchGuestActiveTableOrders:347-349` |
| **Write (edit)** | the SESSION only. Table number is deliberately excluded. | `sessionOwnsRow`, `edit/route.ts:139-146` and its docblock |
| **Add to the tab** | the TAB, via a `customer_sessions` token bound to it. Any member may add. | `orders/route.ts:96-107` |
| **Mark ready to pay** | the TAB, same token. Any member may do it for everyone. | `ready-to-pay/route.ts:23` |
| **Settle** | STAFF only, on the terminal. | `terminal/tabs/[tabId]/settle` |

**So: an order is owned by the creating session for mutation, by the table for readability, and by
the tab collectively for payment.** That is three different answers and the product language does
not distinguish them.

The consequence the brief anticipates is real and load-bearing for the redesign: a "My Orders"
screen that showed *the table's* orders would be showing rows the viewer can read but cannot edit,
and the customer would discover that only when a button 404s. The current My Orders avoids this by
being session-scoped — it shows less than the customer can see, not more.

## THE PERMISSIONS MATRIX

Each cell states what the **server or database** actually checks. "nothing" means there is no check
— UI absence is not recorded as a control.

Read `A` = the creating session. `B` = another customer on the same table session. `S` = staff.
`X` = a stale customer whose table session has been closed (`close_table_session` ran) but whose
browser still holds its ids.

### VIEW (one order, by id)

| | Check | Result |
|---|---|---|
| **A** | `guestCanAccessOrder`: restaurant match **and** `ownsOrder(row, held ids)` | ✅ allowed |
| **B** | restaurant match **and** `Number(order.table_number) === table` — **the table number alone**, which is printed on the table and carried in the QR URL | ✅ **allowed** — #279 |
| **S** | RLS staff policy on `orders`/`order_requests` via `user_restaurant_ids()`, plus `requireStaffPermission` on the routes | ✅ allowed |
| **X** | **nothing revokes it.** `guestCanAccessOrder` never consults `customer_sessions`, `session_version`, `tabs.status` or `is_closed` (except to *widen*: `is_closed === true` returns `true` immediately, `:30-32`) | ✅ **allowed**, indefinitely |

### EDIT *(staging only — the route does not exist on production)*

| | Check | Result |
|---|---|---|
| **A** | `sessionOwnsRow` (held ids × both placer columns) → `editRefusalReason` (status ∈ {pending, accepted}; payment_status ∈ {pending, cash_pending}; no `payment_checkout_url`; lock not held by another) → conditional UPDATE CAS'd on `edit_lock_token` + the same allowlists | ✅ intended — **but see QRA-01: the commit is refused unconditionally today** |
| **B** | `sessionOwnsRow` fails → `404 Order not found` (deliberately not `403`, so the response cannot confirm the order exists) | ⛔ refused |
| **B holding A's session id** | `sessionOwnsRow` **passes** — the id is a bearer value | ✅ **allowed** — QRA-05 |
| **S** | no staff edit route for `orders` items. Pre-Accept, `PATCH /api/order-requests/[id]/review` rewrites `items_reviewed` with `requireStaffPermission` | ✅ pre-Accept only |
| **X** | **nothing.** The route consults no token, no `session_version` and no `is_closed`; and the table-close route leaves an unpaid order at `status='pending'`, `payment_status='pending'` | ✅ **allowed** — QRA-16 |

### CANCEL

| | Check | Result |
|---|---|---|
| **A** | — | ⛔ **no customer cancel exists.** `grep -rn "cancel" app/api/guest/` → no matches. The edit route explicitly refuses to empty an order. |
| **B** | — | ⛔ same |
| **S** | `requireStaffPermission(ORDERS_UPDATE)` + `isValidStaffStatusTransition(*→cancelled)` + status CAS + audit row | ✅ allowed |
| **X** | — | ⛔ same as A |

### PAY / SETTLE

| | Check | Result |
|---|---|---|
| **A** | `requireSessionToken` bound to the tab → `POST /api/tabs/[tabId]/ready-to-pay`. This is a *request*, not a charge. | ✅ allowed |
| **B** | identical — **any member may mark the whole tab ready to pay, for everyone**, and it blocks further ordering and further joining | ✅ allowed |
| **anyone with no credential** | QRA-02 mints the token | ✅ **allowed** |
| **S** | terminal auth on `/api/terminal/tabs/[tabId]/settle`, which re-derives the amount | ✅ allowed |
| **X** | `validateSessionToken` fails on `tabs.status !== 'open'` **and** on the session-version mismatch | ⛔ **refused** — this is the one row where the token guard does its job |

**Read the matrix down the X column.** The session token is the only thing that expires, and it
guards six routes. Everything else a stale customer might do — reading an order, listing their own
orders, and (on staging) editing an unpaid one — is gated on bearer session ids that nothing
revokes.

---

# 5. CUSTOMER EDITING AN ORDER

**PRODUCTION (`9dcf401`): none of this exists.** No `edit` route, no `edit-lock.ts`, no
`edit_lock_*` columns in main's migration set. On production the answer to all five sub-questions
is *"impossible; there is no editing"*. Everything below is `4861492`.

Order A: 2 Burgers + 2 Cokes, not yet preparing.

## The flow

1. **Entry.** `/menu/{rid}/my-orders` renders *"Change this order"* when `isEditableHere` says so
   (`my-orders/page.tsx:25-33`, `:257-272`) and navigates to
   `/menu/{rid}/order-confirmation/{orderId}`. That page mounts `OrderEditPanel` in
   `OrderConfirmationView`'s `editSlot`.
2. **Eligibility (client affordance).** `editRefusalReason` / `requestEditRefusalReason` run in the
   browser on the guest row. **The client can never see a live lock**: `redactGuestOrderRow` strips
   `edit_lock_token`, and `isEditLockActive` requires that token
   (`lib/orders/edit-lock.ts:99-106`) — so `isEditLockHeldByOther` is always `false` client-side.
   The button therefore shows even while another diner holds the lock. Harmless (the server
   refuses), but it means the *"Someone else at your table is changing this order"* copy can only
   ever be reached as a surprise.
3. **Acquire.** `POST /api/guest/orders/{id}/edit` `{restaurantId, sessionIds}`.
   `prepare()` resolves the restaurant, loads the row from `orders` then `order_requests`, and
   checks `sessionOwnsRow`. Then `refusalFor`. Then a **CAS'd UPDATE**: set token/holder/expiry
   `WHERE id AND restaurant_id AND edit_lock_token = <observed>` (or `IS NULL`)
   `AND status IN (…) AND payment_status IN (…)`. Zero rows → `explainLostWrite` re-reads and
   returns the *real* reason.
4. **Lock owner / expiry.** `edit_lock_session_id` (QRA-01), `edit_lock_expires_at = now + 3 min`
   (`EDIT_LOCK_TTL_MS`). **Nothing sweeps expired locks** — the migration says so explicitly:
   *"Expiry is evaluated in the application against the row's own timestamp; nothing sweeps this
   table."*
5. **Session validation.** Only `sessionOwnsRow`. **No `x-session-token`, no `session_version`, no
   tab-status check.**
6. **Commit.** `PATCH` with `{lockToken, keep[], orderInstructions?}`. Re-checks the refusal gate,
   requires the token to be live and equal, re-prices with `repriceKeptLines`, then a **second
   CAS'd UPDATE** on `edit_lock_token = <caller's>` plus the same status/payment allowlists.
7. **Price recalculation.** `repriceKeptLines` (`lib/orders/reprice-priced-lines.ts`) — re-sums from
   the order's **own stored priced lines**, never the live menu. The reason is written down: a
   survivor whose menu price moved must keep the quoted price, and a survivor that has since gone
   `out_of_stock` must not cause `UnmatchedMenuItemError` to refuse an unrelated removal.
8. **VAT recalculation.** `applyTaxToAmount` — the same primitive `calculateOrderPricing` uses, fed
   `unitPrice × newQuantity`, so inclusive/exclusive handling cannot drift.
9. **Inventory.** **Nothing.** No stock is returned when a line is removed or reduced.
   `checkStockSufficiency` runs only at `POST /api/orders`; deduction happens on order completion
   via `trg_order_completion_deducts_stock`. So for a QR order the *deduction* has not happened yet
   at edit time and the edit correctly changes what will be deducted — **but only because the
   deduction is late**, not because the edit accounts for it. For a `preparing` order it would be
   wrong, and that case is closed by the status allowlist.
10. **Realtime.** None from this write. The customer's own page refetches via `onEdited`; other
    devices learn about it on their next 5-second poll. The staff dashboard's `orders` /
    `order_requests` realtime subscriptions carry it.
11. **Kitchen.** For `orders`, a total-changing edit sets `status = 'pending'` and
    `requires_reacceptance = true`, pushing the order back to the dashboard's *New* tab. For
    `order_requests`, it nulls any saved staff review and sets `requires_reacceptance`.

## The five operations, answered individually

### 5A — Reduce quantity (2 Burgers → 1) — **POSSIBLE**

`decrement` (`order-edit-panel.tsx:178-188`) lowers the working quantity; at 1 a further press marks
the line removed. `keep: [{index, quantity}]` is sent. Server:
`repriceKeptLines:123-141` re-prices from `unitPriceOf(stored) × nextQuantity` through
`applyTaxToAmount`. Total falls → `editRequiresReacceptance` true (integer-cent comparison) →
`status: 'pending'`, `requires_reacceptance: true`, `total_before_edit` recorded.

### 5B — Remove a line (drop the Cokes) — **POSSIBLE**

Omit that index from `keep`. Refused only if `keep` would be empty
(`repriceKeptLines:90-92` → `EDIT_COPY.cannotEmpty`, *"An order needs at least one item. Ask staff
to cancel it instead."*).

### 5C — Increase quantity (1 Burger → 2) — **IMPOSSIBLE**

The exact restriction, `lib/orders/reprice-priced-lines.ts:117-121`:

```ts
if (nextQuantity > originalQuantity) {
  throw new InvalidEditError(
    `Quantity for line ${index} cannot be increased from ${originalQuantity} to ${nextQuantity}`)
}
```

and the reason on `:114-116`: raising a quantity *"is how an edit would become a way to order more
without the stock check, the quantity cap and the payment-method allowlist that POST /api/orders
runs."* The UI has no increment control at all — `OrderEditPanel` exposes `decrement`, `remove` and
`restore` only.

### 5D — Add a new item (order has Burger, customer wants Fries) — **IMPOSSIBLE**

Two independent restrictions:

- The wire format cannot express it. `keep` is `{index, quantity}[]` addressing **stored line
  indexes**, and `repriceKeptLines:99-101` throws for any index `< 0` or `>= lines.length`
  (*"Line N is not part of this order"*). There is no menu-item id, no price, and no path by which
  a new line could be introduced.
- The pricing function is a strict reduction by construction — it iterates `keep` and pushes only
  `lines[index]`, so its output is always a subset of its input.

The docblock states the intent: *"an edit may never introduce a line, raise a quantity, or empty
the order."*

### 5E — Swap (Burger → Steak) — **IMPOSSIBLE**

It decomposes into 5B (possible) and 5D (impossible). What a customer can actually do today is
remove the Burger — which sends the order back for re-acceptance — and then place a **separate new
order** for the Steak via *Order More*. That produces two kitchen tickets and two order numbers for
one intended substitution. This is the single most important input to section 17's Model A / Model B
question.

### Notes-only edit — **POSSIBLE, and the only re-acceptance-exempt edit**

`orderInstructions` is normalised (`normalizeOrderInstructions`) and written directly.
`editRequiresReacceptance` compares totals in integer cents, so a notes-only change leaves the total
untouched and the order stays where it is. This exemption is a **recorded human ruling**
(`lib/orders/edit-lock.ts:209-230`) and the tempting simplification `return nextTotal > previousTotal`
is explicitly rejected with a named test guarding it.

---

# 6. EDITING WITH MULTIPLE CUSTOMERS

## Event 6A — competing editors

A opens Order A. `POST …/edit` sets `edit_lock_token = T_A`, `edit_lock_expires_at = +3min`.

B attempts the same. **B does not get as far as the lock**: `prepare()` runs `sessionOwnsRow` first
(`edit/route.ts:250-252`) and B holds none of A's ids → `404 Order not found`. B's UI never offered
the button either, because `isEditableHere` is computed from `heldSessionIds()`.

**So on the same table, "competing editors" is not reachable through the product.** The
`locked_by_other` path exists for a genuinely different case: **the same customer on two devices or
two browser tabs**, which is now one identity for `tab_session_id` (the localStorage mirror, see
`TAB_SESSION_ID_MIRROR_KEY`) but two for `flashtap_session_v1` only if storage was cleared.

The two ways `locked_by_other` *is* reachable:

1. **B has harvested A's session id** (QRA-05). Then `sessionOwnsRow` passes and the lock is the
   only remaining control — and it is a real one: `isEditLockHeldByOther` refuses, and the commit
   CAS on `edit_lock_token` refuses even if the read raced.
2. **QRA-01** — the holder is refused their own lock. Today this is the *only* way an ordinary
   customer sees that message, and it is wrong when they do.

**Is the lock UX or real protection?** **Real.** Two independent mechanisms, both in the database:

- acquire is `UPDATE … WHERE edit_lock_token = <observed>` (or `IS NULL`), so two acquires racing on
  a free lock cannot both match;
- commit is `UPDATE … WHERE edit_lock_token = <caller's own>`, so a stale holder matches zero rows.

The route's own docblock states the principle correctly: *"nothing is decided by comparing values
in this process, because two Workers isolates comparing the same stale read would both conclude they
had won."* That is the right design and it is implemented.

## Event 6B — B places a new order while A has unsaved changes open

- **A's editor** is entirely local until Save. `OrderEditPanel` holds `WorkingLine[]` in React
  state. Nothing polls it, nothing invalidates it. B's order changes nothing A is looking at.
- **B's order** becomes a new `order_requests` row on the same tab.
- **The tab total** does not move until staff Accept B's request; then `accept/route.ts:235-244`
  re-sums **all** the tab's non-settlement orders.
- **Kitchen** gets a second card.
- **Realtime**: the staff dashboard sees it; A's screens do not subscribe to `orders`, so A learns
  nothing until the 5-second poll on whichever screen A is on — and A is on the confirmation page,
  which polls only its own order.

**A presses Save.** `repriceKeptLines` operates on **A's order's own lines**, so B's order cannot
affect the result. The authoritative total after Save is: A's order re-summed from its own priced
lines, plus a `tabs.total` re-sum that includes B's order **only if B's request has been Accepted by
then** (`edit/route.ts:511-531` sums `orders` on the tab; an un-Accepted request is not in `orders`).

**So the tab total immediately after A's Save is correct with respect to `orders` and silently
excludes every still-pending request.** That is consistent with the rest of the system — `tabs.total`
only ever counts accepted orders — but it means the number is not "what the table will owe".

## Event 6C — B settles while A has an unsaved edit

**Can B begin payment?** B can `POST /api/tabs/[tabId]/ready-to-pay`. Nothing consults the edit
lock. The tab moves to `ready_to_pay`.

**What amount is committed?** *None, at this point.* `ready-to-pay` writes a status and a
`payment_preference`; it does not compute or commit an amount. The amount is derived later, on the
terminal, by `settle/route.ts:378-417`, from the tab's orders at that moment.

**What happens when A presses Save afterward?** Two independent answers:

- If A's order was still `pending`/`accepted` and `payment_status` still in
  `{pending, cash_pending}`, **the edit is accepted.** The tab being `ready_to_pay` is not in the
  edit gate. `EDITABLE_ORDER_STATUSES` and `EDITABLE_PAYMENT_STATUSES` are properties of the
  **order**, and `tabs.status` is a property of the **tab**; nothing joins them.
- The edit then re-sums `tabs.total` — but the terminal will re-derive from the orders anyway, so
  the charge follows A's edit if the settle happens after it, and does not if it happens before.

**This is a genuine INV-4 exposure and it is worth stating precisely.** The invariant says *once a
payment amount is committed to a provider, the payable state that produced it must not silently
change.* For the **tab** path the amount is committed at the terminal, in the same request that
claims the orders (`settle/route.ts:286`–`:316` claims with `.in('payment_status', settleable)`), so
the window is short and the claim is conditional. For the **hosted-checkout** path the amount is
committed much earlier — at Accept — and *that* is closed, by `payment_in_flight`:
`editRefusalReason:173-175` refuses any edit while `payment_checkout_url` is set, because *"that
Finatic session was created for the OLD total, and the webhook is the sole confirmation QR payments
have."*

So INV-4 holds for hosted checkout by an explicit gate, and holds for the terminal by the
conditional claim. **What is not covered is the interval between `ready_to_pay` and the terminal
claim**: during it, the tab is frozen against new orders (`orders/route.ts:138-143`) and against new
joins (`join/route.ts:62-71`) but **not against edits**. A customer can reduce their order while the
waiter is walking over with the terminal, and the terminal will charge the reduced figure — correct
in outcome, surprising in sequence, and undetectable to the staff member who read the total off the
tab a moment earlier.

**What B sees:** nothing about A's edit. The `/tab` screen B is on shows only B's own orders
(QRA-12), so A's order was never on it.

---

# 7. KITCHEN RACE CONDITIONS

## Event 7A — staff start the order while A is editing

**Kitchen write.** `PATCH /api/orders/[orderId]/status {status:'preparing'}`:

1. loads `id, restaurant_id, status, payment_status`;
2. `requireStaffPermission(ORDERS_UPDATE)`;
3. `isValidStaffStatusTransition('accepted','preparing')` → true;
4. builds the patch, and — because `isEditableOrderStatus('preparing')` is false — adds
   `edit_lock_token: null, edit_lock_session_id: null, edit_lock_expires_at: null`
   (`status/route.ts:120-124`);
5. `UPDATE … WHERE id AND restaurant_id AND status = 'accepted'` — a CAS on the status that was
   read;
6. zero rows → `409 "Order status changed; refresh and try again"`.

**Realtime event.** The staff dashboard subscribes to `orders`. **The customer does not.** A's
confirmation page learns about it on its next 5-second poll — but note the poll re-renders the page,
and `OrderEditPanel` keeps its own `grant` and `lines` state across that re-render, so **A's editor
stays open and looks live for up to three minutes after the kitchen took the order**.

**Edit lock.** Nulled by step 4.

**Save behaviour.** A's `PATCH` re-reads the row in `prepare()`, `refusalFor` now returns
`preparation_started` (because `'preparing' ∈ KITCHEN_HAS_IT`), and the customer is told
*"The kitchen has started this order, so it can't be changed now."* If the read raced and returned
the stale row, the conditional UPDATE still matches zero rows — `edit_lock_token` is NULL and
`status` is not in the allowlist — and `explainLostWrite` re-reads to produce the same message.

**Can stale client state overwrite the kitchen transition?** **No.** VERIFIED, and by two
independent conditions in the same `WHERE` clause: the token and the status allowlist. Removing
either one alone still leaves the other. The staging probe
`scripts/probe-order-edit-lock-race-staging.ts` scenario A asserts exactly this and was recorded
green at `d3eba56`.

## Event 7B — simultaneous fire

The actual writes, side by side:

| | Customer commit | Staff status |
|---|---|---|
| Table | `orders` | `orders` |
| `WHERE` | `id`, `restaurant_id`, `edit_lock_token = T_A`, `status IN ('pending','accepted')`, `payment_status IN ('pending','cash_pending')` | `id`, `restaurant_id`, `status = <the value staff read>` |
| Sets | items, subtotal, tax, total, `status:'pending'` if total moved, `requires_reacceptance`, `edit_lock_* = NULL`, `edit_history` | `status`, a timestamp, and `edit_lock_* = NULL` when leaving the editable set |
| Transaction | none — a single statement | none — a single statement |
| Row locking | none explicit; PostgreSQL's per-statement row lock only | same |
| Conditional | **yes, two conditions** | **yes, one condition** |
| Atomic | **each write is atomic in itself** | **same** |

**Can both succeed?** No, in either order, and for different reasons:

- **staff first** — the staff UPDATE nulls the token; the customer's `WHERE edit_lock_token = T_A`
  matches zero rows. Refused.
- **customer first** — the customer UPDATE sets `status = 'pending'` (whenever the total moved);
  the staff `WHERE status = 'accepted'` then matches zero rows → `409`. If the total did **not**
  move (notes only) the status is untouched and the staff transition succeeds — which is correct:
  a note is not a re-acceptable change.

**Does ordering matter?** Yes, and asymmetrically: staff-first refuses the customer *permanently*
(preparing is terminal for editing); customer-first refuses staff *recoverably* (they re-Accept the
new figure and then start it). That asymmetry is the ruling, and it is enforced by the transition
table rather than by anything the edit feature added — `pending → preparing` was never a legal
staff transition (`isValidStaffStatusTransition`), so after a total-changing edit staff get
`400 "Invalid transition: pending → preparing"` and must Accept first. (That raw string is #275.)

**Is the outcome atomic?** **Each individual write is; the sequence is not, and it does not need to
be.** Both writers are single conditional statements, and every interleaving lands on exactly one of
the two outcomes above. There is no third state — no partially-applied edit, and no order that is
both edited and preparing. Scenario C of the staging probe asserts that forbidden pair impossible.

**Where atomicity is genuinely absent, and it is not here.** Three places in the same flow have no
transaction and no compensation, and they are the honest answer to the brief's *"if nothing makes
the outcome atomic, say so"*:

1. **Accept** — claim / `createOrder` / finalize are three round-trips. A worker death between them
   strands the request in `accepting`, where it is invisible to staff, refused by every route, swept
   by nothing, and still reads *"Waiting for confirmation"* to the customer. The route documents
   this itself (`accept/route.ts:29-34`).
2. **The `tabs.total` re-sum** after a customer edit (`edit/route.ts:511-531`) and after Accept
   (`accept/route.ts:235-244`) runs **after** the authoritative write and discards its own error.
3. **`tabs.members`** — three of four writers are read-modify-write (QRA-09).

---

# 8. ORDER MORE VS CHANGE ORDER

## Today, with Order #1 already preparing

A wants a Coke. Every path leads to the same place: *+ Order More* (`/tab:402-409`),
*Order More Items* (`/my-orders:308-314`), or the Cart button on browse — all navigate to
`/menu/{rid}/browse?table=N&tabId=…`. A adds the Coke and taps **Add to Tab**.

**FlashTap creates a second, wholly independent submission.** Concretely:

| Consumer | What it gets |
|---|---|
| **Customer** | a second row in My Orders; a second card on `/tab` under the same member group; a second toast |
| **Other table members** | nothing directly — their `/tab` never showed A's orders anyway (QRA-12); the browse strip total moves once staff Accept |
| **Kitchen** | a second *Waiting for Review* card, then a second order after Accept |
| **KDS / Live Orders** | a second ticket, with its own `route_to` enrichment |
| **Receipt** | a second line group; `/menu/{rid}/receipt` lists both |
| **Tab** | one more row summed into `tabs.total` at Accept |
| **VAT** | computed per order by `calculateOrderPricing`; two orders, two tax computations, summed only at settlement |
| **Inventory** | a second `checkStockSufficiency` at submission and a second deduction at completion |
| **Reporting** | two orders |
| **Payment** | both settle together on the tab; no second payment |
| **Order numbering** | **a second `order_number`**, allocated by `createOrder` per restaurant |

So a customer who wanted "one more Coke with my burger" produces two order numbers, two tickets and
two acceptance decisions. That is the current reality and it is what the redesign's *"+ Add
something"* would change.

## Repeat while Order #1 is still editable

**Can the Coke be added to Order #1 today? No.**

The exact technical restriction is **5D**: the edit wire format is
`keep: {index, quantity}[]` over the order's own stored lines, and
`repriceKeptLines:99-101` rejects any index outside `[0, lines.length)`. There is no field for a
menu item id and no path from the edit route to `calculateOrderPricing`.

The **domain** restriction sitting behind it is stated at `reprice-priced-lines.ts:114-116`: an
addition must run the stock check, the per-line quantity cap and the payment-method allowlist that
`POST /api/orders` performs, and the edit route performs none of them. Routing an addition through
the edit path would bypass all three.

So today: **"Change order" can only ever subtract. "Order more" can only ever create a new ticket.
There is no operation in the system that adds an item to an existing order.**

---

## QRA-16 — closing the table does not close editing, and does not touch pending requests

**Severity P1. VERIFIED at `4861492`** (the edit half is staging-only; the `order_requests` half is
both refs). Invariants falsified: **INV-2**, **INV-6**.

`POST /api/tables/[tableNumber]/close` (`requireStaffPermission(TABLES_MANAGE)`) does three things:

1. `close_table_session(table_id, restaurant_id)` — settles the tabs, deactivates every linked
   `customer_sessions` row, increments `current_session_version`. **One transaction.**
2. Paid orders → `is_closed`, `table_closed`, `status='completed'`, `completed_at` stamped only
   where null.
3. **Unpaid orders → `is_closed`, `table_closed`, and nothing else.** The route says why, and it is
   the right call: *"payment_status, paid_at, status and completed_at are deliberately left
   untouched: an unpaid or cancelled order must not become revenue just because someone closed a
   table."*

So after a table close, an unpaid QR order sits at `status = 'pending'` (or `'accepted'`),
`payment_status = 'pending'`, `is_closed = true`.

**Every gate on the edit route is satisfied by that row:**

- `loadTarget` (`edit/route.ts:109-127`) selects by `id` + `restaurant_id` and **never filters
  `is_closed`** — grepped: the string does not appear in the file.
- `editRefusalReason`: `status ∈ {pending, accepted}` ✅, `payment_status ∈ {pending, cash_pending}` ✅,
  no `payment_checkout_url` ✅, lock free ✅ → **null, i.e. editable.**
- `sessionOwnsRow` passes, because the customer's browser still holds the ids. **Nothing clears
  them.** `/session-ended` removes `flashtap_session_token`, `flashtap_tab_id` and
  `flashtap_table` — and leaves `flashtap_session_v1`, `tab_session_id` and
  `flashtap_tab_session_id_mirror` in place.

**So a customer whose table was closed can still edit an unpaid order, indefinitely.** The
`customer_sessions` revocation and the `session_version` bump — the two mechanisms that exist
precisely for this — are consulted by exactly six routes, and the edit route is not one of them.

### And nothing closes `order_requests` at all

`grep -c order_requests app/api/tables/[tableNumber]/close/route.ts` → **0**. Neither the terminal's
table-close route, nor the settle route, nor either cron sweeper
(`expire-hosted-pending-orders`, `auto-cancel-stale-pos-orders` — both operate on `orders`) touches
`order_requests`.

Consequences, both VERIFIED at both refs:

- A `waiting_review` request survives table closure and **stays in the staff queue**
  (`getWaitingOrderRequests` filters on `restaurant_id` + `status='waiting_review'` only). A new
  party sits down and staff still see the previous party's un-actioned submission for that table.
- Its placer can still edit it (staging), because `requestEditRefusalReason` looks only at
  `status`.
- Accepting it later creates a real order at that table, after the table was closed and the version
  bumped.

`guestCanAccessOrder` compounds it from the read side: `is_closed === true` **short-circuits to
`true`** (`validation.ts:30-32`), so a closed order is readable by anyone holding the restaurant id
and the order UUID — no table, no session. That is the deliberate "shareable receipt link" pattern,
but it means table closure *widens* read access rather than narrowing it.

---

## QRA-17 — every customer realtime subscription in the QR app is dead

**Severity P1. VERIFIED on staging by direct catalogue read; the code half is VERIFIED at both
refs. Production publication state UNPROVEN — the exact query is given below.**
Invariant: **INV-8** in its "authoritative state reaches the customer" sense.

Read-only against the linked staging project:

```sql
select schemaname, tablename from pg_publication_tables where pubname='supabase_realtime';
--  public | order_requests
--  public | orders
```

**`public.tabs` and `public.restaurant_tables` are not in the publication.** The only migration that
ever touches it, `20260726110000_enable_realtime_orders_order_requests.sql`, adds exactly `orders`
and `order_requests`; `scripts/enable-orders-realtime.ts` adds `orders`. Grepped across every
migration and script: **nothing has ever published `tabs`.**

Now the subscriptions. Every `supabase.channel(...)` reachable from a QR customer, at `4861492`:

| Site | Table subscribed | In publication? |
|---|---|---|
| `contexts/tab-context.tsx:255-263` | `tabs` (`id=eq`) | **no** |
| `app/menu/[restaurantId]/v2/page.tsx:589-596` | `tabs` (`id=eq`) | **no** |
| `app/menu/[restaurantId]/v2/page.tsx:602-609` | `restaurant_tables` (`id=eq`) | **no** |
| `app/menu/[restaurantId]/v2/page.tsx:614-629` | `tabs` (`restaurant_id=eq`) | **no** |
| `app/menu/[restaurantId]/receipt/page.tsx:271-287` | `tabs` (`id=eq`) | **no** |
| `hooks/useTabSessionEndedRedirect.ts:66-80` | `tabs` (`id=eq`) | **no** |
| `hooks/useSessionTokenGuard.ts:110-125` | `tabs` (`restaurant_id=eq`) | **no** (and the hook has no importer) |
| `components/orders-dashboard.tsx:633` (staff) | `tabs` | **no** |

**Seven customer subscriptions, zero of them can ever fire.** And the customer subscribes to
neither of the two tables that *are* published: there is no `postgres_changes` subscription on
`orders` or `order_requests` anywhere under `app/menu/`.

A `postgres_changes` subscription to an unpublished table does not error. The channel reaches
`SUBSCRIBED` and no event is ever delivered — which is why this has survived: every one of these
call sites looks correct, has a cleanup, and does nothing.

### What actually keeps the customer's screens current

Polling and focus, exclusively:

| Screen | Mechanism | Interval |
|---|---|---|
| `/v2` landing | `window` `focus` listener → `syncTabLandingState()` (`v2:631-636`), plus remount | on focus only |
| `/browse` | nothing periodic for tab state; `MenuOrderStatusTracker` polls its own orders | — |
| `/cart` | `useTabSessionEndedRedirect`'s mount-time `load()` | on mount |
| `/my-orders` | `setInterval(loadOrders, GUEST_ORDER_POLL_MS)` | 5 s |
| `/order-confirmation/[id]` | `setInterval(pollPaymentStatus, …)`, stops once `paid` | 5 s |
| `/receipt` | `setInterval(validateAndLoad, …)` | 5 s |
| `/tab` | **nothing.** One `load()` on mount and no interval | never |

**`/tab` is the screen with the money on it and it never refreshes.** A customer sitting on it
watches a total that was correct when the page loaded.

### Production

Publications are database state, not migration state, so `origin/main`'s code being identical does
not settle it. The query is read-only and takes one round trip:

```sql
select tablename from pg_publication_tables where pubname='supabase_realtime';
```

Not run here because this checkout is linked to staging and re-linking mutates a checkout other
agents share. Given that no migration or script has ever published `tabs` in any environment, the
expectation is that production matches — but it is expectation, not measurement, and is labelled
UNPROVEN accordingly.

---

## QRA-18 — `PATCH /api/tabs/[tabId]/member` is an unauthenticated, cross-tenant write

**Severity P1. VERIFIED at BOTH refs, including production.** Invariants falsified: **INV-9**,
**INV-1**.

The entire route, `app/api/tabs/[tabId]/member/route.ts` (43 lines, quoted in full because its
brevity is the finding):

```ts
export async function PATCH(req, { params }) {
  const { tabId } = await params
  const { sessionId, displayName } = await req.json()
  if (!sessionId || !displayName?.trim()) return 400
  const supabase = createServerSupabaseClient()          // service_role — RLS bypassed
  const { data: tab } = await supabase.from('tabs').select('id, members').eq('id', tabId).single()
  if (!tab) return 404
  const updatedMembers = (tab.members || []).map((m) =>
    m.session_id === sessionId ? { ...m, display_name: displayName.trim() } : m)
  const { error } = await supabase.from('tabs').update({ members: updatedMembers }).eq('id', tabId)
  …
}
```

- **No `requireSessionToken`.** The client calls it through `fetchWithSession`
  (`tab/page.tsx:210-220`), so a token is *sent* — and the route never looks at it.
- **No restaurant scope.** Both statements filter on `id` alone. There is no
  `.eq('restaurant_id', …)` anywhere in the file, and no restaurant is even accepted as input. It
  is the only customer write in the system with no tenant boundary at all.
- **Service-role client**, so RLS does not backstop the missing filter.
- **Full-array overwrite** of `tabs.members` — a fifth read-modify-write site, and the only one
  reachable with no credential.

### Reachability

The tab UUID is the only thing needed, and it is handed out unauthenticated:
`GET /api/tabs/active?restaurantId=<public>&tableNumber=<printed>` returns `{tab:{id, …}}`
(`app/api/tabs/active/route.ts:100-108`). So:

```
GET  /api/tabs/active?restaurantId=…&tableNumber=7      -> tab.id
PATCH /api/tabs/{tab.id}/member   {"sessionId":"x","displayName":"…"}   -> 200
```

Two effects, both without any credential:

1. **The members array is rewritten on every call**, even when no entry matches. Any concurrent
   `add_tab_member` append (the atomic RPC on `/api/tabs/join`) is silently lost, because this
   route writes the array it read. Repeated calls are a way to keep evicting joiners from the
   member list.
2. With a **harvested** `session_id` (QRA-05), the attacker sets that diner's `display_name` to an
   arbitrary string, which renders on `/tab` (`groupedOrders`, `:353-388`) and on the customer
   receipt view (`getOrderCustomerLabel`, `receipt/page.tsx:143-183`) for everyone at the table.

React escapes the string, so this is defacement and attribution corruption rather than script
injection. The absence of a restaurant scope is the part that makes it a tenancy defect rather than
a nuisance: the same request works against any tab UUID in any restaurant on the platform.

---

# STAGE 3

---

# 9. PAYMENT SCENARIOS

## The shape of QR payment, stated first because it changes every answer

**A QR tab customer never pays through FlashTap.** There is no customer-initiated charge on the tab
path. The customer's entire payment capability is `POST /api/tabs/[tabId]/ready-to-pay`, which sets
`tabs.status = 'ready_to_pay'` and records a `payment_preference` of `cash | card | other`. The
money is taken by staff on the terminal
(`app/api/terminal/tabs/[tabId]/settle/route.ts`), or per-order at
`app/api/terminal/orders/[orderId]/payment`.

Hosted online checkout (Finatic) exists only on the **non-tab** path: `/order-secure` posts
`paymentChannel: 'hosted'`, and the checkout session is created **at Accept**, never at submission
(`accept/route.ts:254-282`). QR memory's standing note applies — *the webhook is the sole
confirmation for hosted checkout*.

## 9A — A settles everything

**Customer UI** `/tab` → payment-preference selector → *Ready to pay*.
**API** `POST /api/tabs/[tabId]/ready-to-pay` — `requireSessionToken` +
`assertSessionMatchesResource(token → restaurant, tab)`, `payment_preference ∈ {cash,card,other}`
validated against `restaurant_settings.payment_methods`, then
`UPDATE tabs SET status='ready_to_pay', payment_preference, ready_to_pay_at
 WHERE id AND restaurant_id AND status <> 'ready_to_pay'`.
**Authoritative payable calculation** happens later and elsewhere:
`settle/route.ts:225-238` sums `orders.total` for the requested ids and compares against the
terminal's `amount` with `amountsMatch` (integer cents, #180).
**Provider** the terminal talks to Finatic directly.
**Database** the claim at `:283-316` flips `payment_status='paid'`, `status='completed'`,
`payment_reference`, `paid_at`, `completed_at` — conditioned on the settleable status set.
**Tab** `:410-417` recomputes `tabs.total` with `owesMoney()`; `:508-519` decides closeability the
same way.
**A's UI** `/tab` does not poll (QRA-17), so A sees nothing until navigation.
**B's UI** the browse strip reads `tabs.total`, which after settlement is the *remaining* owed
amount — so B's strip goes to `N$0.00` on B's next page load. B is never told a payment happened;
B infers it from a zero.

## 9B — A and B both tap Pay within a second

Neither taps a charge. Both hit `ready-to-pay`, and the second one loses the CAS
(`.neq('status','ready_to_pay')`) and receives
`409 {alreadyReady: true, message: 'This tab has already been marked ready to pay.'}`. **No double
liability is possible here because no liability is created here.**

The real double-settle question is at the terminal, and the protection is the conditional claim:
two settle requests for the same orders → the second's
`.in('payment_status', settleableStatuses)` matches zero rows →
`claimedIds.length !== orderIds.length` → `409 ALREADY_PAID` / `SETTLE_CONFLICT`, **before** any
`payments` row is written (the claim is the first write). **INV-5 attacked and held.**

## 9C — payment fails

For a tab, "fails" happens on the terminal and is handled by
`lib/payments/handle-terminal-payment-failed.ts`; the orders stay unpaid and the tab stays
`ready_to_pay`. The customer sees nothing — `/tab` renders *"waiter notified"* and does not poll.
**A cannot retry** (there is nothing to retry), and **nor can B**; only staff can. Note
`ready-to-pay` is one-way for customers: no route sets a tab back to `open`, so a tab marked ready
by mistake blocks all further ordering until staff act.

## 9D — the browser disappears mid-payment

Irrelevant on the tab path: the browser is not in the payment. On the hosted path the webhook
reconciles (`app/api/webhooks/paycloud/route.ts`), and `markOrderPaidConfirmed` is idempotent.

## 9E — provider succeeds, redirect fails

Hosted path. The webhook is authoritative and the customer's return is decorative — the root
`/order-confirmation` page reconstructs from `?tn=` via
`GET /api/guest/orders/by-payment-ref`, and falls back to the latest order for the browser session
within a 30-minute window (`RECEIPT_FALLBACK_WINDOW_MS`). **The webhook path never ACKs a payment it
could not apply** (`unappliedClaims`, `webhooks/paycloud/route.ts:167-174`) precisely so Finatic
keeps retrying.

## 9F — redirect returns before the webhook

**The database is authoritative and the redirect renders whatever it finds.** The confirmation page
polls every 5 s until `payment_status === 'paid'`, so a redirect that lands first shows *pending*
and converges. There is no client-side "assume paid".

## 9G — payment versus a mutable order

Covered in 6C. Summary: hosted checkout is protected by an explicit gate
(`payment_in_flight` on `payment_checkout_url`); the terminal is protected by the conditional
claim; **the `ready_to_pay` → terminal-claim window is not protected against a customer edit**, and
the edit gate has no knowledge of `tabs.status`.

## 9H — split and partial payment: **NONE OF IT EXISTS**

Stated plainly, as the brief asks. Grepped at `4861492` across `app/`, `lib/`, `components/` for
`splitPayment`, `split_payment`, `partialPayment`, `partial_amount`, `payEvenly`, `pay_only` and
their variants: **no matches**.

- **Paying only your own orders** — no. The settle route takes an `order_ids` array, so the
  *terminal* can settle a subset; no customer surface can express one.
- **Custom partial amount** — no. `amountsMatch(amount, expectedAmount)` refuses any amount that is
  not the exact sum in integer cents.
- **Split by item** — no.
- **Equal split** — no.
- **Split between payment methods** — no. One `payment_method` per settle call; a second call for
  the remaining orders is possible from the terminal but is not a split, it is two settlements.

`tab_settlement_for_tab_id` exists on `orders` and is threaded through `createOrder`, the Accept
route and the reconcile route — but **no customer screen ever sends it**. Grepped: the only writers
are server-side pass-throughs of a value the client never sets. It is a legacy of an earlier
settlement model and is inert on the QR path.

---

# 10. CUSTOMER SESSION EVENTS

| Event | Customer sees | Browser believes | Server believes | Validation performed | Consequence |
|---|---|---|---|---|---|
| **Refresh Menu** | full reload | ids + tab id + token | unchanged | view-only re-check; `fetchTabById`; PIN read | none |
| **Refresh Cart** | cart survives (`localStorage`) | same | unchanged | `useTabSessionEndedRedirect` `load()` | none |
| **Refresh My Orders** | list refetched | same | unchanged | none beyond session scope | none |
| **Refresh confirmation** | order refetched | same | unchanged | `guestCanAccessOrder` | none |
| **Refresh during edit** | **the editor is gone; the lock is not** | `grant` was React state | lock still held for up to 3 min | — | the customer must wait out their own lock, or press *Change this order* again and get `locked_by_other` |
| **Browser Back** | ordinary; most navigations are `router.replace`, so Back from the confirmation page skips the cart | — | — | — | `/session-ended` actively defeats Back with `onpopstate` + `pushState` |
| **Browser Forward** | ordinary | — | — | — | none |
| **Duplicate tab** | works | **one identity** — `tab_session_id` is mirrored to `localStorage` and rehydrated (`readTabSessionId:29-36`) | one member | — | deliberate: *"two browser tabs on one device now share one member identity"* |
| **Open the QR link in another tab** | same as above | same | same | — | none |
| **Copy the QR URL to another person** | they get the landing for that table | their own fresh ids | a second member once they join | the PIN — **or QRA-02** | this is the intended sharing path and the PIN is its only control |
| **Copy a `?tabId=` URL to another person** | `tab-context:129-136` **persists the URL's `tabId` unconditionally** | they now hold your tab id | nothing — no token is issued | none | they can read the tab via `/view` (total, member display names) with no credential |
| **Close browser, return 10 min later** | rejoin card on the landing | ids + tab id survive `localStorage` | tab still `open` | `POST /api/session/validate` | resumes |
| **Return an hour later** | same | same | same, unless staff closed the table | same | resumes, or `410` → `/session-ended` |
| **Return after settlement** | `isTabSessionEndedStatus` → `endTabSession(true)` → notice + clear | cleared | tab `settled` | `fetchTabById` | correct |
| **Scan tomorrow** | fresh landing | old ids **still present** unless `/session-ended` was reached | new tab | version mismatch on the token only | see section 11 |
| **Stale `localStorage`** | rejoin card for a tab that no longer exists → `endTabSession(true)` | — | — | `fetchTabById` returns null | correct |
| **Stale `session_id`** | **nothing detects it.** No route compares a session id against `customer_sessions` or a version | still "valid" | still matches the old rows | none | QRA-16 |
| **Stale `session_version`** | only `validateSessionToken` sees it | — | mismatch | on the six guarded routes | correct where checked |
| **Changed browser/device** | must rejoin with the PIN | nothing | nothing | PIN | correct |
| **Storage unavailable** | `mintTabSessionId` still works (it is CSPRNG-based), but `sessionStorage.setItem` throws in some privacy modes | — | — | — | **UNPROVEN** — no try/catch around the storage writes in `ensureTabSessionId`; a throwing `setItem` would propagate out of `TabProvider`'s `useState` initialiser and blank the whole `/menu` tree. Needs a Safari private-mode device test. |

---

# 11. COMPLETE TABLE SESSION LIFECYCLE

Walking the brief's sequence, then attacking the boundary.

`Empty Table 12` → `A scans` (ids A_A/B_A minted; no server row) → `B scans` (ids A_B/B_B) →
`A orders` (request #1, `session_id = B_A`) → `B orders` (request #2, `session_id = B_B`) →
`kitchen Accepts both` (two `orders` rows; `tabs.total` re-summed twice) →
`A orders another round` (request #3) → `tab paid` (terminal settle: orders → `paid`/`completed`,
`tabs.total` → remaining owed) → `staff close the table`.

**Close** runs `close_table_session(table_id, restaurant_id)` in one transaction:

```
UPDATE tabs SET status='settled', settled_at, settled_type='manual_close'
  WHERE table_id AND restaurant_id AND status IN ('open','ready_to_pay','active');
UPDATE customer_sessions SET active=false, expires_at=now()
  WHERE tab_id IN (SELECT id FROM tabs WHERE table_id AND restaurant_id);
UPDATE restaurant_tables SET current_session_version = current_session_version + 1,
                             status='available' WHERE id;
```

then the route closes the orders (paid → completed; unpaid → `is_closed` only).

**A still has My Orders open.** Nothing pushes anything: `/my-orders` has no realtime and its
5-second poll is `fetchGuestOrdersBySession`, which filters `is_closed !== true` **client-side**
(`my-orders:68`). So on the next tick A's list empties. A is not told why.

**A refreshes.** Same. Empty list, no explanation.

**A presses Back.** Ordinary history navigation. If A lands on `/browse` or `/cart`,
`useTabSessionEndedRedirect`'s mount `load()` finds the tab `settled` and hard-redirects to
`/session-ended`, which clears the token, `flashtap_tab_id` and `flashtap_table`. **It does not
clear `flashtap_session_v1`, `tab_session_id` or the mirror.**

**C and D sit down. C scans the same permanent QR.**

`/v2?table=12` → no stored tab id (cleared) → `GET /api/tabs/active` → none within the 12-hour
window → *Create Tab* → a **new** `tabs` row, a **new** `customer_sessions` row stamped with the
**incremented** version.

## How FlashTap separates A/B from C/D — and where it does not

| Mechanism | Separates? | Why |
|---|---|---|
| **new `tabs` row** | ✅ | a new UUID; A's stored id points at a `settled` row and every screen that reads it ends the session |
| **`customer_sessions.active=false`** | ✅ | A's token fails `validateSessionToken` |
| **`current_session_version + 1`** | ✅ | even a resurrected token fails the version comparison |
| **`orders.is_closed = true`** | ⚠️ | it stops the orders appearing in A's live lists — but it makes them **more** readable, because `guestCanAccessOrder` returns `true` on `is_closed` alone |
| **the customer's session ids** | ❌ | **nothing clears or invalidates them.** They are not registered anywhere, so there is nothing to revoke |

### Attacking the boundary with stale client state — what actually crosses

Attempted, and reported honestly:

- **Read C/D's orders with A's stale ids** — ❌ blocked. Every list is session-scoped and A's ids
  match none of C/D's rows.
- **Read C/D's orders by table number** — ✅ **crosses**, if A knows an order UUID.
  `guestCanAccessOrder`'s table branch has no session, version or tab check
  (`validation.ts:43-45`). A does not learn new UUIDs from any screen, so this is bounded by UUID
  possession, not by the table session. **#279.**
- **Read the new tab's total and member names** — ✅ **crosses, with no credential at all.**
  `GET /api/tabs/active?restaurantId&tableNumber=12` → the new tab's id, total, status and member
  count; then `GET /api/tabs/{id}/view` → member display names. Neither route authenticates.
- **Order onto C/D's tab** — ✅ **crosses**, via QRA-02: `POST /api/tabs` on the now-occupied table
  returns a fresh, valid session token for C/D's tab, stamped with the *current* version.
- **Rename a member of C/D's tab** — ✅ **crosses**, via QRA-18, with only the tab UUID.
- **Edit A's own unpaid order from before the close** — ✅ **crosses in time** rather than across
  parties (QRA-16): the order is still `pending`/`pending` and the edit route consults nothing
  that changed.

**So the separation holds for everything the token guards, and holds for nothing else.**
`current_session_version` is a good mechanism attached to six routes out of roughly twenty the
customer can reach.

---

# 12. REALTIME EVENT MATRIX

Given QRA-17, the honest matrix is short. **"Realtime" in the customer app means nothing today:**
`tabs` and `restaurant_tables` are not published, and the customer subscribes to nothing else.

| Event | Authoritative change | Published? | Subscribed by customer? | How the customer actually finds out |
|---|---|---|---|---|
| customer joins table | `tabs.members` append | ❌ | ❌ (7 dead channels) | **refresh / focus** |
| order created | `order_requests` INSERT | ✅ | ❌ | own screen's 5 s poll |
| second customer creates an order | `order_requests` INSERT | ✅ | ❌ | **never** — no screen shows another diner's orders |
| order edited | `orders` / `order_requests` UPDATE | ✅ | ❌ | own screen's poll |
| edit lock acquired | `edit_lock_token` UPDATE | ✅ | ❌ | **never** — the token is redacted out of every guest read, so the client cannot even compute "someone is editing" |
| edit lock expires | *no row changes* | — | — | **nothing at all**: expiry is a timestamp comparison, so there is no event to publish. The holder's own countdown is the only signal |
| edit lock released | `edit_lock_token → NULL` | ✅ | ❌ | never |
| order accepted | `orders` INSERT + `order_requests` UPDATE | ✅ | ❌ | poll (5 s) on my-orders / confirmation |
| preparation begins | `orders.status` UPDATE | ✅ | ❌ | poll |
| order ready | `orders.status` UPDATE | ✅ | ❌ | poll |
| order rejected / declined | `order_requests.status='declined'` | ✅ | ❌ | poll; my-orders opts in with `includeDeclined` |
| new round added | as "order created" | ✅ | ❌ | own screen only |
| payment initiated (`ready_to_pay`) | `tabs.status` UPDATE | ❌ | ❌ | **refresh only** |
| payment succeeds | `orders` UPDATE + `tabs.total` UPDATE | orders ✅ / tabs ❌ | ❌ | poll for the order; **refresh** for the tab total |
| payment fails | `orders` UPDATE | ✅ | ❌ | not surfaced to the customer at all |
| tab settles | `tabs.status='settled'` | ❌ | ❌ | **refresh** — and then a hard redirect |
| table session closes | `tabs` + `customer_sessions` + `restaurant_tables` | ❌ | ❌ | **refresh**, or a `410` on the next guarded call |

### Everything that is stale until refresh — the explicit list the brief asks for

1. **The tab total on `/browse`'s strip** — `tabs` unpublished; the strip is `useTab().tabTotal`,
   loaded once per `(restaurantId, tabId)` because the subscribe effect is gated
   `if (tabId && tabStatus) return` (`tab-context.tsx:245`).
2. **Everything on `/tab`** — no poll, no working subscription. The screen with the money.
3. **`/receipt`'s tab record** — the `tabs` channel is dead; the 5-second `validateAndLoad` covers
   it because it re-fetches the tab as well.
4. **The landing's "a tab is open here" card** — focus listener only.
5. **The person count and member names** — same.
6. **Tab settlement and table closure** — the customer keeps browsing a dead tab until they
   navigate.
7. **Another diner's order appearing** — never visible on any customer screen, by design.
8. **An edit lock held by someone else** — structurally invisible to the client (the token is
   redacted and `isEditLockActive` needs it).
9. **Staff-side: the tab dashboard's own `tabs` channel is equally dead** — so staff do not see
   `ready_to_pay` arrive in real time either.

---

# 13. SECURITY AND AUTHORIZATION

The rule for this section: **UI absence is not authorization.** Where nothing on the server or in
the database checks, the cell reads *NOTHING*.

## 13.1 The capability table

`RID` = restaurant UUID (public — in every menu URL, and a repo constant for Riviera).
`TBL` = table number (public — printed on the table, in the QR URL).
`TAB` = tab UUID. `OID` = order UUID. `SID` = a customer session id (bearer).
`TOK` = a `customer_sessions` token.

| Capability | Route | Server/DB enforcement | Sufficient to hold |
|---|---|---|---|
| read restaurant / menu | `GET /api/menu/[rid]/*` | none (public by design) | RID |
| **join a table session** | `POST /api/tabs` | **NOTHING** on the `23505` branch — QRA-02 | **RID + TBL** |
| join a table session (intended) | `POST /api/tabs/join` | plaintext compare against `tabs.tab_pin`; no attempt counter, no lockout, no rate limit | RID + TBL + a 4-digit PIN |
| join by tab id | `POST /api/tabs/[tabId]/join` | PIN required unless `tab_pin IS NULL` (QRA-08); table number must match the tab; `status='open'` | TAB + TBL + PIN |
| **read the tab (total, status, member count)** | `GET /api/tabs/active` | **NOTHING** | **RID + TBL** |
| **read the tab detail + member display names** | `GET /api/tabs/[tabId]/view` | **NOTHING** — documented as deliberate | **TAB** |
| read the tab detail (+ PIN on staging) | `GET /api/tabs/[tabId]` | `requireSessionToken` + token.tabId === tabId; PIN disclosed only on staging (QRA-04) | TOK |
| **rename a tab member** | `PATCH /api/tabs/[tabId]/member` | **NOTHING. No token, no restaurant scope, service-role client** — QRA-18 | **TAB** |
| read table members (identities) | — | `redactTabMembers` substitutes an opaque per-tab `member_key` on both read routes | — |
| **read every member's raw `session_id`** | `GET /api/orders?tabId=` | `requireSessionToken` + tab binding — but the payload includes `session_id` (QRA-05) | TOK |
| read own orders | `GET /api/guest/orders/by-session` | non-empty session-id list; `.in()` on both placer columns; fails closed | SID |
| read table orders | `GET /api/guest/orders/active-table` | same, plus table + restaurant; **`countOnly=1` bypasses the session requirement** and counts every open order at the table | RID + TBL (count only) |
| **read one specific order** | `GET /api/guest/orders/[orderId]` | `guestCanAccessOrder`: restaurant **and** (`table_number` match **or** `ownsOrder`) | **OID + RID + TBL** — #279 |
| read a paid/closed order | same | restaurant scope **alone** (`is_closed`/`paid`/`completed`/`cancelled` short-circuit to `true`) | **OID + RID** |
| read orders by payment reference | `GET /api/guest/orders/by-payment-ref` | three doors: `paymentRefOrFilter` charset validation, mandatory restaurant scope, per-row `guestCanAccessOrder` | ref + RID |
| **email a paid order's receipt anywhere** | `POST /api/guest/orders/[orderId]/receipt/email` | `guestCanAccessOrder` — which for a paid order is restaurant scope alone. No rate limit, no dedup, no date bound (#244) | **OID + RID** — QRA-19 |
| read a paid order's receipt | `GET /api/guest/orders/[orderId]/receipt` | same | OID + RID |
| **create an order on an occupied table** | `POST /api/orders` **without** `tabId` | view-only check, quantity cap, stock check, payment allowlist, and *"an open tab must exist at this table"* — **but no credential** (QRA-07) | **RID + TBL** |
| create an order **on a tab** | `POST /api/orders` with `tabId` | `requireSessionToken` + `assertSessionMatchesResource` + `tabs.status='open'` | TOK |
| **edit an order** | `POST/PATCH/DELETE /api/guest/orders/[orderId]/edit` | `sessionOwnsRow` (bearer SID × both columns) → refusal gate → **two conditional UPDATEs**. No token, no version, no `is_closed` | **OID + RID + SID** |
| acquire / release the edit lock | same | as above; CAS on the observed token | same |
| cancel an order | — | **no customer route exists** | — |
| read payment state | `GET /api/guest/orders/[orderId]` | as "read one order" | — |
| **begin payment (mark ready to pay)** | `POST /api/tabs/[tabId]/ready-to-pay` | `requireSessionToken` + resource binding + preference allowlist + status CAS | TOK (and QRA-02 mints one) |
| settle a tab | `POST /api/terminal/tabs/[tabId]/settle` | terminal auth, cash-authorization token, pre-write status validation, integer-cent amount match, atomic claim | staff terminal |
| access an old order URL | `GET /api/guest/orders/[orderId]` | nothing time-bounded; `is_closed` **widens** access | OID + RID |
| access an old table/session | — | `validateSessionToken` (version + tab status + `active` + expiry) — **on six routes only** | — |
| access the PIN | `GET /api/tabs/[tabId]` (staging) | `requireSessionToken` bound to the tab — and QRA-02 mints one without the PIN | TOK |
| reset the PIN | `POST /api/tabs/[tabId]/reset-pin` | terminal auth (staff) | staff |

## 13.2 The two suspects, re-verified independently at `4861492`

**Suspect 1 — "`guestCanAccessOrder` admits an open order on `table_number` alone." CONFIRMED.**

```ts
// lib/guest-orders/validation.ts:40-45
const table = params.tableNumber
…
if (table != null && Number.isFinite(table) && Number(order.table_number) === table) {
  return true
}
```

The restaurant binding above it is mandatory (`:24-28`), so it is not cross-tenant. But
`table_number` is a small integer printed on furniture. This is **#279**, and the issue records the
reason it survives: the confirmation screen's live traffic depended on it until the `sessionIds`
consolidation landed, and a canary measurement on the deployed worker confirmed the session branch
now carries traffic on its own. **A named test pins the current behaviour** —
`__tests__/owns-order-both-columns.test.ts`, *"STILL admits an open order on table_number alone —
recorded, not endorsed"*. That is a recorded decision, so narrowing it is an escalation, not an
implementation choice.

**Suspect 2 — "`ownsOrder` makes knowing a session id the whole authorisation for editing."
CONFIRMED, and the code says so itself.**

```ts
// lib/guest-orders/validation.ts:84-87 (docblock)
// NOT a credential check. A session id is a bearer value the client supplies, so this answers
// "does the caller know an id this row was placed under", nothing stronger.
```

The edit route uses its own copy of the predicate (`sessionOwnsRow`, `edit/route.ts:139-146`),
deliberately excluding the table branch — the right call, and it is the *only* customer write with a
per-order owner check at all. What makes it load-bearing rather than adequate is that the id is
**disclosed to other tab members** by `GET /api/orders?tabId=` (QRA-05) and is not revoked by
anything (QRA-16). #277 hardened the *generation* of these ids to a CSPRNG; nothing has hardened
their *handling*.

## 13.3 The rest of the class — every place possession of an identifier is sufficient

The brief asks for the class, not the two examples. Ten sites, each VERIFIED:

1. **`POST /api/tabs` → a session token.** RID + TBL. **QRA-02.** The most serious, because the
   token is the system's only real credential.
2. **`GET /api/tabs/active` → the tab UUID, total, status, member count.** RID + TBL. Unauthenticated
   by design; the design note says it exposes nothing the landing does not already render to a
   scanner. True — and it also converts "physically at the table" into "anywhere on the internet",
   and it is what makes (3) and (4) reachable.
3. **`GET /api/tabs/[tabId]/view` → the tab row and member display names.** TAB. Unauthenticated
   deliberately, with a written rationale (`loadTab` runs before a token may exist).
4. **`PATCH /api/tabs/[tabId]/member` → a write.** TAB. **QRA-18.** No rationale, no scope, no check.
5. **`POST /api/orders` without `tabId` → an order at an occupied table.** RID + TBL. **QRA-07.**
6. **`GET /api/guest/orders/[orderId]` → a full open order row.** OID + RID + TBL. **#279.**
7. **`GET /api/guest/orders/[orderId]/receipt` and `…/receipt/email` → a paid order's receipt,
   emailed anywhere.** OID + RID. **QRA-19.**
8. **`GET /api/guest/orders/by-payment-ref` → a paid order row.** ref + RID. Bounded by three
   deliberate doors and a CSPRNG reference; listed for completeness, not as a defect.
9. **The edit surface → a write.** SID. Bearer, unrevoked.
10. **`?tabId=` in any `/menu/*` URL → the browser adopts that tab id unconditionally**
    (`tab-context.tsx:129-136` persists it to `localStorage` in a `useLayoutEffect` before any
    validation). A pasted link re-points a stranger's device at your tab. It grants no write — no
    token is issued — but it is client state accepted from a URL with no check.

## 13.4 What authorization actually rests on, summarised

| Mechanism | Used by | Revocable? |
|---|---|---|
| **server-created binding** (`customer_sessions` token) | 6 routes | ✅ — `active`, `expires_at`, tab status, session version |
| **bearer session id** (`ownsOrder` / `sessionOwnsRow`) | every guest read, and the entire edit surface | ❌ — not stored anywhere as a credential, so nothing can revoke it |
| **table number** | `guestCanAccessOrder`'s open-order branch | ❌ — it is printed on the table |
| **restaurant id** | every guest route's tenant scope, and *alone* for paid/closed orders | ❌ — public |
| **opaque UUID possession** | tab id, order id | ❌ |
| **RLS** | staff paths on `orders`, `order_requests`, `tabs`, `restaurants`, `users`, `customer_sessions` | n/a — **every customer route uses the service-role client, so RLS protects the customer surface not at all** |
| **service-role validation** | the API routes themselves; this is the real boundary | n/a |
| **RPC validation** | `add_tab_member` (DEFINER, not granted to anon) | n/a |
| **signed token** | **none.** Nothing in the customer path is signed or MAC'd | — |
| **cookies** | **none.** Every customer identifier travels in a query string, a JSON body, or `x-session-token` | — |

**The single structural observation of this section:** every customer route builds a
`createServerSupabaseClient()` (service role). Row-level security therefore contributes **nothing**
to customer authorization — it is entirely a staff-side control. Every guarantee on the QR surface
is a hand-written `if` in a route handler, and section 13.1 is the complete list of those `if`s.

---

# 14. FAILURE AND ABUSE SCENARIOS

| Scenario | Expected invariant | Actual behaviour | Existing protection | Failure mode | Evidence |
|---|---|---|---|---|---|
| double-click Place Order | INV-7 | second POST carries the same `x-idempotency-key`; `23505` on the partial-unique index → the existing id is returned | `flashtap_cart_idem_{rid}_{tbl}` in `sessionStorage`; `order_requests_idempotency_key_idx`, `orders_idempotency_key_unique` | none | VERIFIED |
| two Place Order requests simultaneously | INV-7 | one insert wins, the other 23505s and re-fetches | same | the re-fetch on `order_requests` is `.eq('idempotency_key', k).single()` **with no restaurant scope** — harmless with UUID keys, but the scope is missing | VERIFIED |
| slow request | INV-7 | no timeout on the client fetch | idempotency key retained on failure | none | VERIFIED |
| request succeeds, browser times out | INV-7 | key not cleared (`clearCartIdempotencyKey` runs only on success) → retry returns the same order | idempotency | none | VERIFIED |
| **browser retries after a success, with a CHANGED cart** | INV-7 | the same key is reused, so the server returns the FIRST order and the new items are silently dropped | idempotency key is scoped to `(restaurant, table)`, **not to cart contents** | **customer believes they ordered something they did not.** Requires the first response to have been lost | INFERRED from `lib/idempotency.ts` + `orders/route.ts:337-352` |
| duplicate browser tabs | INV-1 | one identity — `tab_session_id` is mirrored to `localStorage` and rehydrated | `TAB_SESSION_ID_MIRROR_KEY` | none; deliberate | VERIFIED |
| duplicate edit Save | INV-2 | the first commit spends the lock (`edit_lock_token → NULL`); the second matches zero rows → `explainLostWrite` → `lock_lost` | CAS on the token | none | VERIFIED |
| edit succeeds but the browser thinks it failed and retries | INV-2 | as above — refused, and the panel closes with *"That took too long…"*, which is the wrong sentence for a successful edit | CAS | **a successful edit can be reported to the customer as a failure** | INFERRED |
| two editors | INV-2 | unreachable through the product (`sessionOwnsRow` 404s a non-owner); reachable with a harvested SID, and then the lock holds | ownership + lock CAS | — | VERIFIED |
| stale order status | INV-8 | every screen polls at 5 s except `/tab`, which never refreshes | polling | `/tab` is indefinitely stale | VERIFIED (QRA-17) |
| stale tab total | INV-8 | `tabs.total` is a cache; no cancellation re-sums it; `/tab` computes a different, session-scoped number | none | QRA-12, QRA-15 | VERIFIED |
| manipulated request payload | INV-8/INV-10 | prices, tax and totals are recomputed server-side by `calculateOrderPricing`; client `subtotal`/`total` are not even read on the request path | server repricing | `customer_name`, `displayName`, `session_id`, `member_session_id` are accepted verbatim | VERIFIED |
| old `session_id` reused | INV-6 | works forever — nothing registers or revokes a session id | none | QRA-16 | VERIFIED |
| old `session_version` reused | INV-6 | `validateSessionToken` rejects it — on six routes | version comparison | everything else ignores it | VERIFIED |
| old order URL reused | INV-6 | a closed order becomes **more** readable (`is_closed` short-circuits `guestCanAccessOrder`) | none | deliberate receipt-link pattern | VERIFIED |
| table closed during checkout | INV-4 | the tab moves to `settled`; `validateSessionToken` fails; the customer is redirected on their next guarded call or navigation | token invalidation | an unpaid order survives and stays editable (QRA-16) | VERIFIED |
| kitchen transition during edit | INV-3 | staff win; both the token null and the status allowlist refuse the customer | two conditions in one `WHERE` | none | VERIFIED (probe scenario A) |
| order cancelled while viewed | INV-8 | the customer's poll picks up `status='cancelled'`; `my-orders` filters `is_closed !== true` so the card vanishes | polling | no explanation is shown; `tabs.total` is not re-summed | VERIFIED |
| payment initiated twice | INV-5 | second `ready-to-pay` loses the CAS → 409 `alreadyReady` | `.neq('status','ready_to_pay')` | none | VERIFIED |
| provider callback delivered twice | INV-5 | terminal settle: second claim matches zero rows → 409 before any `payments` write | conditional claim + pre-write validation | none | VERIFIED |
| **webhook delivered twice** | INV-5 | explicit duplicate check (`every(r => payment_status==='paid')` → ACK), then `markOrderPaidConfirmed`'s conditional claim returns `already_paid` | two independent layers | none | VERIFIED |
| payment succeeds after the table state changed | INV-5 | `markOrderPaidConfirmed` claims on `payment_status IN CLAIMABLE` regardless of tab or table state, then re-sums `tabs.total` with `owesMoney()` | conditional claim | a payment can land on an order whose table was closed; correct, and the money is recorded | VERIFIED |
| restaurant loses connectivity | — | staff dashboard reconnects; `orders`/`order_requests` are published so its subscriptions do resume | realtime on the published tables | — | VERIFIED |
| customer loses connectivity | INV-7 | polls fail silently (`my-orders`' `loadOrders` has no catch — an exception leaves `loading` true forever) | none | if the FIRST load throws, `setLoading(false)` never runs and `my-orders` shows a **permanent spinner** — `loadOrders` has no `try/catch` and is invoked as `void loadOrders()` | VERIFIED |
| **unauthenticated tab takeover** | INV-9 | `POST /api/tabs` on any occupied table returns a session token | none | QRA-02 / QRA-03 | VERIFIED (code) |
| **unauthenticated member rewrite** | INV-1 | `PATCH /api/tabs/[tabId]/member` succeeds with the tab UUID alone, cross-tenant | none | QRA-18 | VERIFIED |
| **receipt exfiltration** | INV-9 | a paid order's receipt is issued and emailed to an arbitrary address on restaurant scope alone | `guestCanAccessOrder`, which does not gate a paid order | QRA-19 | VERIFIED |
| PIN brute force | INV-9 | 9000 candidates, unthrottled | none — `CacheKeys.rateLimit` has no consumer | #283; and QRA-02 makes it unnecessary | VERIFIED |
| `ready_to_pay` denial of service | INV-9 | any token holder freezes the table: no new orders, no new joins, no customer undo | status CAS (prevents repeats, not the first) | QRA-03 | VERIFIED |
| **stranded `accepting` request** | INV-3 | a worker death between claim and finalize leaves a row invisible to staff, refused by every route, swept by nothing, and reading *"Waiting for confirmation"* to the customer | the route detects and reports the release failure loudly | no recovery path exists | VERIFIED — documented in `accept/route.ts:29-34` |

## 14.1 The two places a customer is told something false

Worth separating out, because both are copy consequences of a mechanism rather than mechanism
failures:

1. **QRA-01** — *"Someone else at your table is changing this order"* when nobody is, followed by
   the editor closing and the edit being discarded, followed by a three-minute lock the customer
   cannot clear.
2. **A successful edit reported as a failure** — if the commit's response is lost, the retry gets
   `lock_lost` and the panel renders *"That took too long, so nothing was saved."* The edit **was**
   saved. The panel has no way to distinguish a lost response from a lost lock, because the server
   cannot either: the token is gone in both cases.

---

## QRA-19 — a paid order's receipt can be issued and emailed anywhere, on restaurant scope alone

**Severity P2. VERIFIED at BOTH refs, including production.** Invariant: **INV-9**.

`app/api/guest/orders/[orderId]/receipt/email/route.ts` — the whole gate is:

```ts
:45-50  .from('orders').select('id, restaurant_id, table_number, session_id, is_closed, status, payment_status')
        .eq('id', orderId).eq('restaurant_id', restaurantId).maybeSingle()
:60     if (!guestCanAccessOrder(guestOrder, { restaurantId, tableNumber, sessionId })) return 404
:64-66  if (payment_status !== 'paid') return 400
:70     receipt = await issueReceiptForOrder(orderId)
:76     const result = await sendReceiptEmail(receipt, email)
```

`guestCanAccessOrder` returns `true` for a `paid` order **before it ever looks at `tableNumber` or
`sessionId`** (`validation.ts:34-38`). So the effective requirement is:

- the order UUID,
- the restaurant UUID (matched **raw**, not through `resolveRestaurantUuid`, so it must be the UUID
  and not a slug — which is what every menu URL carries anyway),
- any syntactically valid email address.

Nothing else. No table number, no session id, no token, and — per **#244** — *"no date bound, no
rate limit and no dedup."*

Three consequences, in order:

1. **Exfiltration.** The restaurant emails a customer's itemised receipt — items, quantities,
   prices, VAT, table, order number — to an address the caller chose.
2. **A write side effect on an unauthenticated route.** `issueReceiptForOrder` is not a read: for an
   order with no receipt yet it **allocates a document number** via the
   `generate_document_number` RPC and inserts a `receipt_documents` row. It short-circuits on an
   existing row (`issueReceipt.ts:207-216`), so it cannot be made to burn numbers repeatedly — but
   it can force the *first* issuance of a receipt for an arbitrary paid order, at a moment of the
   caller's choosing. Receipt snapshots are built at issuance, so that stamps the current outlet,
   VAT and numbering context onto an older sale.
3. **Deliverability abuse.** Unthrottled outbound mail from the restaurant's sending identity, to
   arbitrary recipients.

The sibling `GET …/receipt` has the identical gate and returns the receipt body directly.

The bound on all of this is the order UUID, which the product does not disclose to anyone who does
not already hold it — so this is not mass-exploitable. It is listed as a member of the class in
13.3 rather than as an independent break.

---

## QRA-20 — a FAILED payment tells the customer their order "has been paid for"

**Severity P2. VERIFIED at `4861492`** (staging only — the copy lives in the edit feature).

`EDITABLE_PAYMENT_STATUSES = ['pending', 'cash_pending']` (`lib/orders/edit-lock.ts:41`) is an
allowlist, which is the right shape. But the refusal it produces is a single bucket:

```ts
// lib/orders/edit-lock.ts:170-172
if (!isEditablePaymentStatus(row.payment_status)) {
  return 'payment_settled'
}
```

and `payment_settled` renders as *"This order has been paid for, so it can't be changed."*
(`EDIT_COPY.paymentSettled`).

The payment statuses that reach that branch are everything outside the allowlist. From
`lib/payments/payment-integrity.ts:201-208`, the ones that still **owe money** are
`unpaid`, `failed` and `terminal_pending`. So:

- an order whose card payment **failed** → *"This order has been paid for"*;
- an order with a **live card attempt on the terminal** (`terminal_pending`) → the same sentence.

Both are false, and both are said to a customer about money. Refusing the edit is correct in both
cases — a live attempt must not be repriced, and a failed one is about to be retried — but
`payment_settled` is the wrong reason code for either. `EDIT_COPY` already distinguishes
`paymentInFlight` for the hosted-checkout case; the terminal case has no equivalent.

This is the same family as #209 (*"tab/page.tsx tells the customer cash was withdrawn regardless of
which method actually was"*) and is a **policy escalation, not an implementation choice** — the
operating contract reserves anything changing what a customer is told about money to the human.

---

# STAGE 4

---

# 16. ACTUAL STATE MACHINES

Reconstructed from the implementation. Where a state exists only because a writer produces it, it
is listed even if no one intended it.

## 16.1 Customer / table session

There is no session state column. The state is a **conjunction**, and it is computed fresh on every
call to `validateSessionToken`.

```
        (no ids)
            │  TabProvider constructs → ensureTabSessionId()          [identity B exists]
            ▼
     IDENTIFIED-ONLY ─────────────────────────────────────────┐
            │  landing table fetch → createFreshSession()      │  (blocked if a token exists)
            ▼                                                  │
     IDENTIFIED (A+B), NO TOKEN                                 │
            │  POST /api/tabs | /api/tabs/join | /[tabId]/join  │
            ▼                                                  │
        TOKEN-BOUND  { tab_id, table_id, restaurant_id, session_version, active, expires_at }
            │                                                  │
   ┌────────┼───────────────┬──────────────────┬───────────────┤
   │ 24h    │ tab leaves    │ close_table_     │ active=false  │
   │ expiry │ status='open' │ session bumps    │ (by RPC)      │
   ▼        ▼               ▼ current_session_version          │
        INVALID ────────────────────────────────────────────────┘
            │  the NEXT call to one of the six guarded routes returns 410
            ▼
   client: handleSessionExpired → /session-ended → clears token, tab id, table
            │  (does NOT clear flashtap_session_v1, tab_session_id, or the mirror)
            ▼
     IDENTIFIED-ONLY, again — with the SAME ids as before
```

**Transitions that do NOT exist:** there is no path from INVALID back to TOKEN-BOUND for the same
token, and no way for a customer to revoke their own identity (`clearSession()` removes A only, and
`clearTabSessionId()` is called from exactly two places — the view-only branch and kiosk start).

**The state nobody designed:** *IDENTIFIED-ONLY with stale ids*. It is the terminal state of every
session, it is indistinguishable from a fresh browser to every unguarded route, and it is what
QRA-16 exploits.

## 16.2 Tab

```
                    POST /api/tabs (INSERT status='open')
                              │
                              ▼
   ┌──────────────────────► OPEN ──────────────────────┐
   │                     │    │                        │
   │  (no route exists)  │    │ POST …/ready-to-pay    │ close_table_session
   │                     │    ▼   (CAS: status<>rtp)   │  (status IN open|ready_to_pay|active)
   │                READY_TO_PAY ──────────────────────┤
   │                          │                        ▼
   │                          │ terminal settle    SETTLED  (settled_at, settled_type)
   │                          ▼
   └───────────────────── (settled)
```

- **`READY_TO_PAY` is one-way for customers.** No route returns a tab to `open`. It blocks new
  orders (`orders/route.ts:138-143`) and new joins (`[tabId]/join:62-71`).
- **`'active'` appears in `close_table_session`'s `WHERE` and nowhere else** — a legacy value no
  writer produces.
- **`'closed'`** is handled by `tab-context.tsx:211-216` (zeroes the total and members) but is
  written by nothing in this repo; `lib/tab-status.ts` and `shouldClearTabAfterSettlement` are the
  vocabulary.
- **`settled_type`**: `'manual_close'` from the RPC, and the terminal settle route's own values.

## 16.3 Order

**There is no separate kitchen state.** One `status` column, written by three vocabularies:

| Writer | Vocabulary |
|---|---|
| dashboard (`PATCH /api/orders/[orderId]/status`) | `pending → accepted → preparing → ready → completed`, `* → cancelled` |
| terminal (`/api/terminal/orders/[orderId]/status`) | `pending → confirmed → preparing …` |
| customer edit (staging) | `accepted → pending` (only when the total moves) |
| payment confirmation | `* → completed` (`markOrderPaidConfirmed` sets `status='completed'` directly, bypassing the transition table) |
| table close | `* → completed` for **paid** orders only |

```
  order_requests:   waiting_review ──claim──► accepting ──finalize──► accepted ──► (orders row)
                          │  ▲                    │
                          │  └── release on error ┘        (a worker death here strands it)
                          └── declined
```

```
  orders:  pending ──► accepted ──► preparing ──► ready ──► completed
             ▲            │                                     ▲
             └── customer edit (total changed)                   │
           ready_for_terminal ──► accepted                       │
           any non-terminal ──► cancelled          markOrderPaidConfirmed ──┘  (from ANY status)
```

**`isValidStaffStatusTransition` has no `pending → preparing` edge**, which is what enforces
re-acceptance after a total-changing customer edit — and produces the raw
`400 "Invalid transition: pending → preparing"` string that is #275.

**`markOrderPaidConfirmed` writes `status='completed'` from any status**, conditioned only on
`payment_status IN {unpaid, pending}`. So `accepted → completed` and even
`preparing → completed` are reachable, bypassing the transition table entirely. That is
intentional (payment completes an order) but it means the transition table is not the whole
grammar.

**No CHECK constraint on `orders.status` or `orders.payment_status`** — both are free text.

## 16.4 Payment

```
  order created (tab)      → 'pending'
  order created (cash, no channel) → 'cash_pending'
  pushed to terminal       → 'terminal_pending'   (+ terminal_pushed_at)
  terminal/webhook success → 'paid'  (+ paid_at, payment_reference, status='completed')
  terminal failure         → 'failed'
  staff cancel             → 'cancelled'
```

Three overlapping sets govern it, and the distinctions are load-bearing:

| Set | Members | Used for |
|---|---|---|
| `CLAIMABLE_PAYMENT_STATUSES` | `unpaid`, `pending` | what `markOrderPaidConfirmed` may claim |
| `OWES_MONEY_PAYMENT_STATUSES` | `unpaid`, `pending`, `cash_pending`, `failed`, `terminal_pending` | how much is owed / may the table close |
| `EDITABLE_PAYMENT_STATUSES` | `pending`, `cash_pending` | may the customer edit |

`failed` and `terminal_pending` owe money but are neither claimable by the webhook nor editable by
the customer — QRA-20.

## 16.5 Edit lock

```
   FREE  (edit_lock_token IS NULL)
     │  POST …/edit   UPDATE … WHERE edit_lock_token IS NULL AND status IN … AND payment_status IN …
     ▼
   HELD  (token, edit_lock_session_id, edit_lock_expires_at = now+3min)
     ├── DELETE …/edit  WHERE edit_lock_token = mine        → FREE
     ├── PATCH  …/edit  (commit)                            → FREE (the commit spends it)
     ├── staff leave {pending,accepted}                     → FREE (nulled by the status route)
     └── wall clock passes edit_lock_expires_at             → EXPIRED-BUT-PRESENT
   EXPIRED-BUT-PRESENT  (token still set, expiry in the past)
     └── POST …/edit by ANYONE who owns the row: CAS on the OBSERVED token re-claims it
```

- **Nothing sweeps expired locks** — stated in the migration. `EXPIRED-BUT-PRESENT` is a real,
  persistent state: `isEditLockActive` is false, so it does not block, but the columns keep their
  values until the next acquire or a staff status change.
- **A commit is refused on an expired-but-present token** by an explicit check
  (`edit/route.ts:381-389`) *and* would be refused by the CAS anyway if someone re-acquired.
- **QRA-01 collapses HELD into an unusable state**: acquire writes a holder the reader cannot
  match, so `HELD` behaves as `HELD-BY-OTHER` for its own holder.

---

## 16.6 THE CROSS-PRODUCT — reachable, money/security/workflow-sensitive combinations

Labels, used strictly:
**OBSERVED** — seen in real data or produced during this audit ·
**PROVABLY REACHABLE** — a specific sequence gets there and every step was traced in code ·
**THEORETICALLY REACHABLE** — the code permits it but at least one step is unverified ·
**UNPROVEN**.

### X-1 · Order editable **+** kitchen preparing — **NOT REACHABLE.** (attacked; held)

The brief lists this first. It is the one combination the feature was built to make impossible, and
it is impossible by two independent conditions in the same `WHERE` clause. Staff-first nulls the
token; customer-first flips the status to `pending`, which has no `→ preparing` edge. The staging
probe's scenario C asserts the pair forbidden. **PROVABLY UNREACHABLE**, and worth recording as an
invariant that held.

### X-2 · Tab `ready_to_pay` **+** order still editable — **PROVABLY REACHABLE**

Sequence: A places an order (tab, `pending`/`pending`) → B (or A) taps *Ready to pay* →
`tabs.status='ready_to_pay'` → A opens the editor.
Every gate in `editRefusalReason` reads the **order**; none reads the **tab**. Grepped:
`edit-lock.ts` contains no reference to `tabs`, `tab_id` or any tab status.
**What breaks:** the waiter is walking to the table with a figure read off the tab, and the payable
amount can change underneath them. The terminal re-derives, so nobody is *mischarged* — but the
staff member's screen and the charge disagree, with no signal that an edit happened. Section 6C.

### X-3 · Tab settled / table closed **+** unpaid order still editable — **PROVABLY REACHABLE**

Sequence: A places an order → staff Accept → the party leaves without paying → staff close the
table → A, on the bus, opens `/menu/{rid}/order-confirmation/{orderId}`.
The close route leaves unpaid orders at `pending`/`pending` deliberately; the edit route filters
neither `is_closed` nor anything session-related. **QRA-16.**
**What breaks:** an order that is no longer at a table, on a tab that is `settled`, can be
rewritten — and the write sets `requires_reacceptance` and pushes it back into the dashboard's
*New* tab, resurfacing a dead order to staff.

### X-4 · Expired customer session **+** accessible order — **PROVABLY REACHABLE**

Same sequence, read side. `guestCanAccessOrder` consults no session state; and once
`is_closed = true` it returns `true` on restaurant scope alone. **Access widens on closure.**

### X-5 · Payment processing **+** mutable payable amount — **PROVABLY REACHABLE for the tab path,
NOT REACHABLE for hosted checkout**

Hosted checkout is closed by `payment_in_flight` (`payment_checkout_url` non-empty). The tab path
has no equivalent: `terminal_pending` on an *order* does close editing (it is outside
`EDITABLE_PAYMENT_STATUSES`), but `ready_to_pay` on the *tab* does not, and the terminal's own
`terminal_pushed_at` is per-order. So during the interval between *Ready to pay* and the terminal
claim, a customer may reduce an order.
**What breaks:** as X-2. The *charge* is safe (integer-cent match against a re-derived sum); the
*expectation* is not.

### X-6 · Cancelled order **+** included in the customer-visible payable amount —
**PROVABLY REACHABLE**

`tabs.total` is not re-summed on cancellation (QRA-15), and the browse strip renders it.
**What breaks:** the customer is shown money they do not owe until settlement corrects the cache.
The terminal's own figures are correct — `owesMoney()` is applied at settle and at the closeability
check.

### X-7 · Successful payment **+** unresolved order mutation — **THEORETICALLY REACHABLE**

Sequence: A holds the edit lock; staff settle on the terminal; A commits.
The settle claim writes `payment_status='paid'` and `status='completed'`. A's commit then fails
both allowlists (`completed` ∉ editable statuses, `paid` ∉ editable payment statuses) **and** the
token CAS (the settle route does not null the lock, but the status/payment conditions already
refuse). So the mutation is refused.
**Unverified step:** whether any interleaving lets the commit's `SELECT` and `UPDATE` straddle the
settle claim in a way that matters. It cannot — the `UPDATE` re-asserts both allowlists — but this
has not been probed the way the staff/customer race was, so it is labelled THEORETICALLY rather than
PROVABLY. The staging probe covers staff-status-vs-edit, not settle-vs-edit.

### X-8 · Active edit lock **+** tab settlement — **PROVABLY REACHABLE, and it strands the lock**

The settle route never nulls `edit_lock_*`. After settlement the order is `completed`/`paid`, so
the lock can never be re-acquired or released by the customer (`DELETE` still works — it is
conditioned on the token alone and does not run `refusalFor`). If the customer's browser is gone,
`edit_lock_token` stays populated forever on a completed order. Harmless — every consumer checks
the status first — but it is a permanently dirty column and the dashboard's *"Customer editing
now"* indicator keys on it.

### X-9 · Closed table **+** live customer session token — **NOT REACHABLE**

`close_table_session` sets `active=false` **and** bumps the version, in the same transaction as the
tab settle. `validateSessionToken` fails on three independent grounds. **Attacked; held.**

### X-10 · Stale session **+** new table occupants — **PARTIALLY REACHABLE**, and the split matters

| Action by the old party | Reachable? |
|---|---|
| read the new tab's total, status, member count | ✅ **no credential** (`/api/tabs/active`) |
| read the new tab's member display names | ✅ **tab UUID only** (`/view`) |
| rename a new member | ✅ **tab UUID only** (QRA-18) |
| add an order to the new tab | ✅ **QRA-02** mints a valid token for it |
| read a new occupant's order | ⚠️ only with that order's UUID (#279) |
| edit a new occupant's order | ⛔ needs their session id |
| use the OLD token | ⛔ version mismatch |

So the boundary holds exactly where the token is checked and nowhere else.

### X-11 · `order_requests` stuck in `accepting` **+** customer polling — **PROVABLY REACHABLE**

Any worker death between the claim and the finalize. The row is then absent from the staff list,
refused with 409 by accept/decline/review, swept by no cron, and `normalizeOrderStatusForDisplay`
maps it to `waiting_review` — so **the customer is shown "Waiting for confirmation" forever** for an
order that no staff member can see or act on. Documented in the route itself.

### X-12 · Two tabs at one table — **NOT REACHABLE for `open`**, reachable for the pair
(`settled` + `open`)

`idx_tabs_one_open_per_table` is partial on `status='open'`, so exactly one open tab exists. A
settled tab and a new open tab coexist by design. The failure mode that *was* reachable —
a tab with `status='open'` **and** `settled_at` set, which permanently 409s every new scan — is
guarded at `app/api/tabs/route.ts:161` (`.is('settled_at', null)`) and explicitly detected and
reported with `TABLE_BLOCKED_BY_CLOSED_TAB`.

### X-13 · Tab `open` **+** `restaurant_tables.status = 'available'` — **PROVABLY REACHABLE**

`POST /api/tabs` sets `occupied`; only `close_table_session` sets `available`. Any path that settles
a tab **without** the RPC (the terminal settle route) leaves the table `occupied`; conversely a
`23505` recovery does not re-set `occupied` if it had drifted. This is #216/#177 territory and
matters here only because the payment terminal's table list gates on that column.

### X-14 · An order on a tab **+** `tab_id = NULL` at the same table — **PROVABLY REACHABLE**

QRA-07: an order submitted without `tabId` lands with `tab_id = null` at a table that has an open
tab. It appears in the kitchen and in Live Orders, is never summed into `tabs.total`, and is never
claimed by `settle` (which filters `.eq('tab_id', tabId)`). **It is an unbillable order at a real
table.** The table-close route will mark it `is_closed` and leave it unpaid.

### X-15 · Edit committed **+** staff review saved — **NOT REACHABLE (resolved deliberately)**

Accept reads `items_reviewed` first, so a stale review would silently discard the customer's edit.
The edit route nulls all four `*_reviewed` columns and preserves the discarded review in
`edit_history`, setting `requires_reacceptance`. **Attacked; held** — and the ruling behind it is
recorded (money-facing: a re-review is recoverable, a wrong charge is not).

### X-16 · Staff Accept **+** a customer edit in the same window — **NOT REACHABLE**

The Accept claim (`WHERE status='waiting_review'`) and the edit commit
(`WHERE status IN ('waiting_review')`) contend on the same column. Whichever lands first excludes
the other: after the claim the status is `accepting`, so the edit matches zero rows and
`explainLostWrite` reports `payment_in_flight` (which `requestEditRefusalReason` maps `accepting`
to). **Attacked; held.**

**But the adjacent combination IS reachable and is not covered:** staff open the review screen,
read a total, the customer edits, staff press Accept. Accept re-reads via the claim's
`.select('*')` and charges the **new** figure. Nothing tells the staff member the number changed
between reading and pressing. `requires_reacceptance` is set on the row but the Accept route does
not consult it. **PROVABLY REACHABLE**, and it is the one place a staff member can authorise an
amount they never saw.

---

# 15. USER EVENT STORIES

Run after section 16, per the brief, so these are collision discovery rather than seventeen
retellings. Where a persona adds nothing, it says so in one line.

All personas are on **staging** (`4861492`) unless marked; on production, every persona involving
*Change this order* collapses to "the customer cannot, and there is no button".

## Persona 1 — Solo diner

Nothing new. The happy path in section 2 is exactly this. **One line worth keeping:** a solo diner
on a tab never sees a confirmation page — `handleAddToTab` returns them to `/browse` with a toast
(`cart/page.tsx:329-334`), which is already the redesign's proposed destination.

## Persona 2 — Indecisive customer

*Orders, immediately reduces quantity, removes something, and wants another item.*

- **T0** A places 2 Burgers + 2 Cokes. `order_requests` row, `waiting_review`.
- **T1** A opens *Change this order* → `POST …/edit` → lock acquired, editor shows both lines.
- **T2** A decrements a Burger to 1 and removes the Cokes. Purely local state.
- **T3** A presses Save → `PATCH` with `keep:[{index:0,quantity:1}]`.
  **QRA-01 fires: 409 `locked_by_other`.** A is told *"Someone else at your table is changing this
  order"*, the editor closes, the changes are discarded, and the order stays locked for the
  remainder of the 3 minutes because the panel nulls its ref without releasing.
  *(Absent QRA-01: the edit lands, `items_customer` is written, the total falls, and
  `requires_reacceptance` is set.)*
- **T4** A wants Fries. **There is no path.** *+ Add something* does not exist; the only route is
  *Order More Items* → browse → cart → a second submission → a second kitchen card and a second
  order number.

**Potential flaw:** this persona is the whole product question. The customer's mental model is one
order being adjusted; the system's model is one order that can only shrink, plus a second order.

## Persona 3 — Multiple rounds

Drinks, then food, then another drink, then settles. Three `order_requests` → three `orders` →
three `order_number`s → one tab. Nothing new beyond section 8, **except one thing worth stating:**
`tabs.total` is re-summed at each Accept, so a customer watching the browse strip sees it move on
the restaurant's clock, not their own — and if the third round is still `waiting_review` at
settlement time it is **not in `tabs.total` and not claimed by the settle route**, which filters
`orders` by `tab_id`. An un-Accepted round is invisible to the bill.

## Persona 4 — Couple, one pays

- **T0/T1** A creates the tab, gets the PIN. B joins with the PIN.
- **T2** both order. Two requests, two orders.
- **T3** A opens `/tab` to pay. **A sees only A's own orders and only A's own total**, under the
  words *"Full tab running total"* (QRA-12). B does not appear at all — B's member group is
  filtered out because it has no items from A's session.
- **T4** A taps *Ready to pay*, chooses card. `tabs.status='ready_to_pay'`.
- **T5** staff settle both orders on the terminal for the true sum.

**Potential flaw, and it is the most likely real-world complaint in this document:** A chose a
payment method and expected to pay N$100, and is charged N$250. Nothing in the app ever showed A
the correct figure. The browse strip did — but A navigated away from it to reach the pay button.

## Persona 5 — Group of four

As persona 4, ×4. **New collision:** `tabs.members` is appended by four different code paths, three
of which are read-modify-write (QRA-09). Four phones joining within the same second through
`POST /api/tabs/[tabId]/join` (the rejoin/by-id path, which is the one the landing uses when a tab
id is already stored) lose members. The `add_tab_member` RPC that fixes this is wired only to
`POST /api/tabs/join` (join by table number + PIN). **Which path a phone takes depends on whether
its browser already holds a tab id**, so a group where some phones have stale state and some do not
will silently use both.

## Persona 6 — One person orders for everyone

Only A scans; A places several rounds. Nothing new — this is persona 3. **One line:** because
`tabs.members` has one entry, `/tab` renders one member group, and for this persona alone
*"Full tab running total"* is actually correct.

## Persona 7 — Late arrival

A/B/C have an active tab; D arrives 30 minutes later and scans.

- `GET /api/tabs/active` returns the tab (30 min < the 12-hour cutoff), so D sees *"a tab is already
  open"* and a Join action.
- D needs the PIN. **A/B/C cannot show it to D on production** — `creatorTabPin` lives in the
  creator's `sessionStorage` only, and production's `GET /api/tabs/[tabId]` does not return
  `tab_pin`. So on production the PIN must be read aloud by whoever created the tab, and if that
  person has closed their browser tab it is unrecoverable except through #265's staff reset.
  **On staging** the PIN is fetched by every member (`browse:300-324`), which is QRA-04.
- **New collision:** if D's browser is carrying a stale `flashtap_tab_id` from another restaurant
  or another table, `syncTabLandingState` takes the `storedTabIsElsewhere` branch (#211) and offers
  *"Your tab is open at Table N"* — correct behaviour, and the reason `linkedUnpaidTabId` exists.

## Persona 8 — Refresh-heavy customer

Refreshes at every stage. **Nothing breaks, and one thing is revealed:** because there are no
working realtime subscriptions (QRA-17), this customer has a *strictly better* experience than a
patient one. Refreshing is the only way to see the tab total move, the person count change, or a
settlement land. **The product's liveness is entirely the customer's own refreshing.**

The one place refreshing costs: mid-edit. The lock survives the reload, the editor does not, and
re-opening returns `locked_by_other`.

## Persona 9 — Browser-Back customer

Most navigations are `router.replace` (cart → confirmation, cart → browse), so Back from a
confirmation skips the cart and lands on browse. `/session-ended` actively defeats Back with
`pushState` + `onpopstate`. **New finding, small:** `tab-context.tsx:129-136` persists any `?tabId=`
from the URL in a `useLayoutEffect` with no validation, so navigating Back to an older URL carrying
a *previous* tab id silently re-points `localStorage.flashtap_tab_id` at it. The next
`syncTabLandingState` then finds a settled tab and ends the session.

## Persona 10 — Slow editor

Opens an order and exceeds the 3-minute hold. The client countdown hits zero, clears `grant`, and
shows *"That took too long, so nothing was saved."* — correct copy for once. The server would refuse
anyway (`isEditLockActive` false). **The lock row is not cleaned up**: `edit_lock_token` stays
populated until someone re-acquires or staff move the status. Nothing sweeps it. The staff
dashboard's *"Customer editing now"* indicator keys on the token, so it keeps saying that.

## Persona 11 — Competing editors

**Not reachable through the product**, per section 6A: B is 404'd by `sessionOwnsRow` before the
lock is consulted. Reachable only with a harvested session id (QRA-05), and then the lock holds.

## Persona 12 — Kitchen beats customer

Section 7A in full. **Nothing new; the mechanism works.** One line worth keeping: A's editor stays
open and looks live for up to three minutes after the kitchen took the order, because the 5-second
poll re-renders the parent without touching `OrderEditPanel`'s local `grant` state.

## Persona 13 — Customer pays while someone edits

Section 6C / X-2 / X-5. **New in persona form:** B's *Ready to pay* does not notify A, does not
close A's editor, and does not appear on any screen A is looking at. A finds out when Save either
works (nothing changed) or is refused with `payment_settled` (the settle already landed) — and that
second message is the one QRA-20 gets wrong when the payment merely failed.

## Persona 14 — Failed payment

**Nothing customer-facing exists.** A failed terminal payment leaves the order at
`payment_status='failed'`, which is outside `EDITABLE_PAYMENT_STATUSES`, so the customer's own
screens now refuse an edit with *"This order has been paid for"* (QRA-20). There is no retry
affordance for the customer, no failure banner, and `/tab` still says *"waiter notified"*. Retry is
entirely a staff action on the terminal.

## Persona 15 — Payment succeeds, browser disappears

Tab path: irrelevant, the browser is not in the loop. Hosted path: the webhook is authoritative,
`markOrderPaidConfirmed` is idempotent, and the route deliberately does not ACK a payment it could
not apply so Finatic keeps retrying. **Attacked; held.**

## Persona 16 — Old customer returns to a re-occupied table

Section 11's boundary attack, in narrative form. A opens an old page:

- `/menu/{rid}/browse` → `useTabSessionEndedRedirect` loads the stored tab, finds it `settled`,
  hard-redirects to `/session-ended`, which clears the token and the tab id. **Correct.**
- `/menu/{rid}/order-confirmation/{oldOrderId}` → **still renders**. `guestCanAccessOrder` returns
  `true` because `is_closed === true`. A sees their own old order. Arguably correct as a receipt.
- `/menu/{rid}/my-orders` → the list filters `is_closed !== true`, so it is empty with no
  explanation.
- A rescans the QR → a fresh landing for C/D's tab, and A is offered *Join* with a PIN they do not
  have — or, via the API, QRA-02.

**Potential flaw:** three screens give three different answers about whether A's session is over,
and only one of them says so.

## Persona 17 — Curious / malicious customer

The productive one. Everything below was established by reading the implementation; nothing was
executed against a live system.

- **T0** A reads `restaurantId` out of the URL and `table` out of the QR.
- **T1** `GET /api/tabs/active?restaurantId&tableNumber=N` → the tab UUID, its total, its status,
  its member count, for **any** table, unauthenticated. Enumerating N=1..50 maps the whole venue's
  occupancy and takings.
- **T2** `GET /api/tabs/{tabId}/view?restaurantId=…` → member display names.
- **T3** `PATCH /api/tabs/{tabId}/member {sessionId, displayName}` → **writes** to that tab, with
  no credential and **no restaurant scope** (QRA-18).
- **T4** `POST /api/tabs {restaurantId, tableNumber}` → `409`? No: `23505` → **a valid session
  token** (QRA-02).
- **T5** with that token: `GET /api/orders?tabId=…` → every order on the tab **including each
  one's raw `session_id`** (QRA-05).
- **T6** with a harvested `session_id`: `GET /api/guest/orders/by-session?session_id=…` → that
  diner's full order history for the restaurant; and `POST /api/guest/orders/{id}/edit` → the edit
  lock on their order.
- **T7** with the token: `POST /api/orders {tabId, items}` → **items on someone else's bill**
  (QRA-03); or `POST /api/tabs/{tabId}/ready-to-pay` → the table is frozen.
- **T8** with any paid order's UUID: `POST /api/guest/orders/{id}/receipt/email {email}` → the
  receipt is issued and mailed anywhere (QRA-19).

**What stops them, and it is short:** the order UUID (unguessable), the tab PIN where it is
actually required, and — for T5–T7 — nothing, because T4 supplies the credential T5–T7 need.

**Two things they cannot do**, both worth recording as attacks that failed:
`close_table_session` (QRA-14 — SECURITY INVOKER, and `anon` has no `UPDATE` on `tabs`), and any
double-settle (the conditional claim at `settle/route.ts:283-334`).

## Persona 18 (added) — the customer whose first poll fails

Not in the brief; added because the implementation revealed it. `my-orders`' `loadOrders` has no
`try/catch` and is invoked as `void loadOrders()`. A transient failure on the **first** call leaves
`loading` permanently `true` and the customer looking at a spinner with no retry, no error, and a
5-second interval that can never clear it because `setLoading(false)` is unreachable after the
throw.

---
