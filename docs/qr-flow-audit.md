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
