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
