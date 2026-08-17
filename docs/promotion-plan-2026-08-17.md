# Promotion plan — 2026-08-17

`origin/main` = `3c6eec9` · `origin/cloudflare-staging` = `4ca5992` · merge-base `13a35b8` (2026-08-05)

**Read section 0 before anything else. The band list in the brief does not survive measurement,
and the reason matters more than the plan.**

> ## CORRECTION — 2026-08-17, after the reconciliation was attempted
>
> **Sections 1 and 4 below overstate what staging is missing, and the error is mine.** I measured
> the 23 main-only commits by **patch-id** and reported them as absent. Patch-id difference is not
> absence: a fix PORTED to the other branch under a different patch-id looks identical to one that
> was never applied.
>
> Re-measured by **content** — reverse-applying each patch against staging's tree, then reading the
> decisive line:
>
> | claimed missing | actually |
> | --- | --- |
> | `56f70b8` the `?ref=` disclosure fix | **PRESENT.** `paymentRefOrFilter` / `isWellFormedPaymentRef` are **byte-identical** on both branches. Ported by `6167f5d`. |
> | `f7ee138` #122 cross-tenant union | **PRESENT.** `by-payment-ref/route.ts` differs **only in comment text**; both require `restaurantId`. |
> | `d57c659` #135 instruction-limits | **PRESENT.** `MAX_INSTRUCTIONS_LENGTH` is on staging. |
> | `9fcb147` #262 member key | **PRESENT.** `deriveTabMemberKey` is on staging via `a64a422`. |
>
> **13 of the 23 were already there.** The genuinely absent set is small, and one of it is real:
> **#242's webhook resolver** (`ea80e72` — staging really did still carry the vulnerable
> PostgREST `.or()`), **#223's amount gates** (`3e98059`, `07b4737`, `c0bee8b`), and the **#266 CI
> key pin** (`97e4fe1`).
>
> What section 4 gets right is the conclusion, not the premise: 206 files changed on both sides, so
> the promotion is surgical ports and not a merge. That still holds.
>
> Left visible rather than edited away. `scripts/check-branch-drift.mjs` now performs this content
> pass automatically, for exactly this reason.

---

## 0. THE HEADLINE, MEASURED

**The entire order-editing feature does not exist on `main`.**

```
app/api/guest/orders/[orderId]/edit/route.ts   ABSENT from main
lib/orders/edit-lock.ts                        ABSENT
components/order-edit-panel.tsx                ABSENT
lib/orders/apply-edit-additions.ts             ABSENT
lib/orders/reprice-priced-lines.ts             ABSENT
```

Three consequences, each of which changes the brief:

1. **#306 cannot be promoted at all.** Every file it touches is absent from `main`. There is no
   double-charge on production because there is no editor on production. It is not a live money
   defect *there* — it is a live money defect the moment the editor ships, which is Band C.
2. **#302 splits in two, and only one half is portable.** Its token requirement is a change to the
   edit route (absent). Its `session_id` leak fix is in `lib/tab-member-key.ts` and
   `lib/guest-orders/queries.ts`, both present on main. The leak half ships; the auth half cannot.
3. **#173 is not Band A.** `components/OrderStatusBanner.tsx` is on main, but the staging version
   imports `lib/orders/customer-status`, which is absent from main and carries **8 PENDING COPY
   strings**. Promoting the file as it stands ships eight unsigned strings to customers.

**And the exploit severity is lower on production than measured.** `main` leaks *both*
`session_id` (never scrubbed) and raw `member_session_id`, so the disclosure is live. But the
escalation that made #302 a takeover — leaked id → edit lock → rewrite the order — needs the edit
route, which is absent. On production a leaked id reaches `guest/orders/by-session` (list another
diner's orders), `tabs/[tabId]/view`, and `guest/orders/[orderId]/receipt/email` (#304). Order
disclosure and an unwanted receipt email, not order rewriting.

---

## 1. THE INVENTORY

Established by **patch-id** (`git cherry`), not reachability. The graph overstates by 2.4×:

```
rev-list  origin/main..origin/cloudflare-staging   250 commits
git cherry (patch-id)                              106 commits with no equivalent on main
                                                    91 already on main by patch
rev-list  origin/cloudflare-staging..origin/main   119 commits
git cherry (patch-id)                               23 main-only commits
```

None of the 106 is a merge commit. Full per-commit table with flags in **Appendix A**.

### Portability, measured per commit

| class | count | meaning |
| --- | --- | --- |
| `PORTABLE` | 20 | every file it touches already exists on main |
| `MIXED` | 57 | touches both existing and absent files — needs a surgical port, not a cherry-pick |
| `ALL-NEW` | 29 | every file absent from main |

**`PORTABLE` is necessary but not sufficient.** A file can exist on main and still import something
that does not. Measured on the Band A candidates:

```
components/OrderStatusBanner.tsx     -> lib/orders/customer-status          ABSENT (8 PENDING COPY)
app/menu/[restaurantId]/browse/page.tsx -> qr-redesign-copy, customer-nav-copy,
                                        item-sheet-availability, variant-groups,
                                        edit-pending-additions, browse-tab-strip   ALL ABSENT
lib/guest-orders/queries.ts          -> lib/orders/order-request-pricing     ABSENT (0 PENDING COPY, 0 imports)
lib/tab-member-key.ts                -> (no @/ imports)                      CLOSES
app/menu/[restaurantId]/v2/page.tsx  -> (none absent)                        CLOSES
```

`order-request-pricing.ts` is the only blocker that opens cheaply: no imports of its own, no
PENDING COPY. Bringing it as a new file closes `queries.ts`.

### Five of the 20 `PORTABLE` commits are already on main by content

`git diff origin/main origin/cloudflare-staging` over their files is **empty** — these are ports of
work main already has under a different patch-id. Promoting them is a no-op or a conflict:

```
e8dec48  #174 unique (restaurant_id, table_number)      twin on main: 7ff7e68
c86f892  #66 redirected-to admin page                   twin: 1708997
3ebac9a  payments: no configured merchant               twin: ce02bf8
e74d09c  batch A lint gate                              twin: b77da91
2417411  #262 anon-grant migration                      twin: e326a55
```

### PENDING COPY surface

**42 occurrences, 34 of them renderable string literals**, in six files — all six absent from main:

```
19  lib/customer-copy/qr-redesign-copy.ts
11  lib/orders/edit-lock.ts
 8  lib/orders/customer-status.ts
 2  lib/tabs/tab-flag-copy.ts
 1  lib/customer-nav-copy.ts
 1  lib/customer-copy/payment-method-withdrawn.ts
```

15 commits touch one of them (listed in Appendix A with the `PENDING-COPY` flag).

### Migrations absent from main

Eight. These apply **separately, before** any deploy that needs them:

```
20260705210000_post_payment_order_lifecycle.sql
20260705220000_refund_events.sql
20260717120000_seed_whatsapp_account_staging.sql   <- staging seed; DO NOT apply to production
20260809120000_orders_unique_order_number.sql
20260812130000_tabs_pin_reset_token.sql
20260813120000_order_editing_lock.sql              <- the editor; Band C
20260814090000_tabs_linked_unpaid_tab.sql
20260816090000_orders_source_request_id.sql
```

### The 23 main-only commits

~~Several are security and payments fixes that staging does **not** have: the `?ref=` order
disclosure (`56f70b8`), the cross-tenant union (`f7ee138`), the #242 webhook resolver
(`ea80e72`), the #223 amount gates (`3e98059`, `07b4737`), the #269 deploy gate, the #266 CI key
pin.~~

**WRONG — see the CORRECTION at the top.** Measured by content, 13 of the 23 are already on
staging. Genuinely absent: **#242's webhook resolver** (`ea80e72`), **#223's amount gates**
(`3e98059`, `07b4737`, `c0bee8b`), the **#266 CI key pin** (`97e4fe1`). Full list in Appendix B.

---

## 2. THE BANDS

### BAND A — shippable now, no copy and no editor dependency

| # | commits | why it qualifies |
| --- | --- | --- |
| **#305** | `b431bf0` (+ `f6fee44`, `c2f9dfc` tests) | touches only `lib/tab-member-key.ts`, which has no `@/` imports. Chain closes. No PENDING COPY. |
| **#302 leak half** | the `lib/tab-member-key.ts` + `lib/guest-orders/queries.ts` hunks of `ffd8d11` | portable once `lib/orders/order-request-pricing.ts` comes with it. **Surgical port, not a cherry-pick** — `ffd8d11` also edits the absent edit route. |
| **#220** | `e937278` | `app/menu/[restaurantId]/v2/page.tsx`, no absent imports, no copy change. |
| **#257** | `origin/promote/257-guest-orders-validation-test` (`7dc71d0`) | already cut from main, one test file, no product code. |
| **#209** | `6a6bb06` | *conditional* — its copy file carries 1 PENDING COPY marker, but the #209 strings are a mechanical parameterisation and the file's own docblock records they are **not** marked. Verify the marker is on an unrelated string before shipping. |

**Session-token console logging (`090f508`) does NOT qualify as a commit.** Two of its three files
(`v2/page.tsx`, `session-ended/page.tsx`) are portable; `browse/page.tsx` imports six absent
files. The fix is the deletion of `console.log` lines, so it ports surgically to main's own browse
page — but that is a hand-written patch, not this commit.

**#173 does not qualify.** See §0.

### BAND B — shippable, own deploy

| # | commits | why alone |
| --- | --- | --- |
| **#302 leak half + #305** | as above | auth/disclosure. Ships alone by standing rule. They are one file and must go together — see §3. |
| **payments** | `f3e2295` (absent PayCloud result), `02653f7` (#238 audit-trail naming) | `f3e2295` already has a promote branch: `origin/promote/d3-payments-alone`. `02653f7` is `MIXED` and needs checking before it can join. |

### BAND C — blocked on the copy

The redesign. **Blocked by the 34 renderable PENDING COPY literals**, and by nothing else:

- **19 strings in `qr-redesign-copy.ts`** block: `c1839f4` (Place Order → My Orders banner),
  `80e475b` (menu simplification), `c025371` (shared tab), `c203a4a` (+ Add something),
  `340c3b6` (#294 session eviction).
- **11 strings in `edit-lock.ts`** block the whole editor: `ae9c65e`, `f063bc3`, `913ba71`,
  `6f2284c`, `f26ff25` (#291), and **all of #306** (`e69d7a9`, `81f1719`, `df7fc46`) and the
  **#302 token half**.
- **8 strings in `customer-status.ts`** block `c025371` and **#173** (`ee6005a`).
- **2 strings in `tab-flag-copy.ts`** block `b3d5c6d` (unpaid-tab flag) and `9921888` (#286).
- **1 string in `customer-nav-copy.ts`** blocks `d8d73b2` (My Orders nav).

Writing the 19 in `qr-redesign-copy.ts` and the 11 in `edit-lock.ts` unblocks the largest share —
the editor and the redesign shell — and is what makes #306 and the #302 token half shippable.

### BAND D — blocked on a ruling

#300 (swap skips re-acceptance), #301 (ready_to_pay bypass), #303 (unreachable guard), #304
(receipt email), **#307** (per-line vs per-item quantity cap), and the editor rewrite. None is
promoted by this plan. #307 is explicitly deferred to the stepper design.

### Does not fit cleanly — say so rather than force it

- **`090f508`** — half portable, half not. Band A *as a hand-written patch*, Band C *as a commit*.
- **`02653f7` (#238)** — payments, but `MIXED`; its absent file needs identifying before it can be
  put in the payments deploy.
- **The five no-op ports** (`e8dec48`, `c86f892`, `3ebac9a`, `e74d09c`, `2417411`) — no band.
  Drop them from the promotion entirely.
- **The 29 `ALL-NEW` test/probe/doc commits** — harmless but pointless without the code they
  exercise. They follow their feature; they are not a band.

---

## 3. THE SEQUENCE

Two deploys for Band A and B. Fewest that respect the constraints.

### DEPLOY 1 — the guest-order disclosure (auth, alone)

**Contents, in order:**
1. `lib/orders/order-request-pricing.ts` — new file, no imports, no copy. Carried only so the next
   file compiles.
2. `lib/tab-member-key.ts` — the #302 `session_id` scrub **and** #305's `member_session_id`
   withhold. **One file, both fixes, one commit.**
3. `lib/guest-orders/queries.ts` — the four call sites pass caller ids.
4. Tests: `__tests__/tab-member-key.test.ts` (the three tab-less cases),
   `__tests__/guest-routes-do-not-leak-foreign-order-ids.test.ts`.

**Split and ordering hazards:**
- **#302 must precede #305 in the file, and here they are the same commit** — #305's `ownsRow`
  reads the `callerSessionIds` parameter #302 adds. Splitting them across deploys means either a
  parameter with no caller or a caller with no parameter.
- **The #302 split hazard in `docs/promotion-constraints.md` does NOT apply here.** That hazard is
  the *token* half needing the *client* half. Neither is in this deploy — the token half cannot
  ship. **Do not promote `origin/fix/302-edit-auth-session-token`.** It edits a route that does not
  exist on main.
- `queries.ts` is one of the 206 both-sides files. Port the four call-site hunks by hand onto
  main's version; do **not** copy staging's file over it.

**Migrations: none.** Nothing in this deploy touches `supabase/migrations/`.

**Verify after it lands:**
- `npx jest __tests__/tab-member-key.test.ts __tests__/guest-routes-do-not-leak-foreign-order-ids.test.ts` — expect 21 + 20 green.
- Read a guest order as a **foreign** session against production and confirm `session_id` and
  `member_session_id` are absent. The chain probe cannot be pointed at production as written — it
  seeds fixtures and calls `close_table_session`. **Use a read-only check on an existing order, by
  eye.**
- Click: two phones on one tab, confirm each still sees the other's line **with a name**. That is
  the positive control — the #262 pairing must survive, and blanket redaction would break it.

**Rollback:** revert the single commit. `3c6eec9` is a safe state to sit at — it is what production
runs today, and the disclosure it carries has been live for months.

### DEPLOY 2 — the small app fixes (no auth, no payments)

**Contents, in order:** `#220` (`e937278`) → `#257` (`7dc71d0`) → the hand-written session-token
console-log deletion for `v2/page.tsx` and `session-ended/page.tsx` → `#209` (`6a6bb06`) **if and
only if** its PENDING COPY marker is confirmed to be on an unrelated string.

**Hazards:** none of these is a pair. `#220` and the console-log patch both touch `v2/page.tsx` —
order them as listed so the second applies cleanly.

**Migrations: none.**

**Verify after it lands:**
- `npx jest __tests__/view-menu-keeps-the-tab.test.ts __tests__/customer-screens-do-not-log-credentials.test.ts __tests__/guest-orders-validation.test.ts`
- Click, on production: open a tab, tap **View Menu**, confirm the tab survives (#220). This is the
  one that must be clicked — see §4.
- Open the customer app with the console visible and confirm no `flashtap_session_token`.

**Rollback:** revert individually; they are independent. Deploy 1 is a safe state to sit at.

**Payments (`origin/promote/d3-payments-alone`) is deliberately NOT sequenced here.** It is Band B
and ships alone, but it is not part of this promotion — it predates this work and needs its own
decision.

---

## 4. WHAT COULD GO WRONG, MEASURED

### Band A commits that depend on Band C

| commit | depends on | consequence if shipped whole |
| --- | --- | --- |
| `ee6005a` (#173) | `lib/orders/customer-status.ts` | ships **8 unsigned strings** |
| `090f508` (browse half) | `qr-redesign-copy` + 5 more | ships **19 unsigned strings** and the redesign shell |
| `ffd8d11` (#302, whole) | the absent edit route | **build failure**, not a silent one |
| all of #306 | `edit-lock.ts` (11 strings) + absent route | **build failure** |

The first two are the dangerous ones: they compile.

### Customer-facing strings that are NOT PENDING COPY

**None in the Band A set.** Diffed `b431bf0`, `e937278`, `090f508` and `ffd8d11` for changed string
literals: the only hits are a removed debug condition naming three drinks (`'Tea'`, `'Americano'`)
in `090f508`, and a header object in `ffd8d11`. No customer-visible copy changes.

### Does main contain anything staging does not, that a merge would revert?

**Yes — 23 commits, and 206 files were changed on both sides since the merge-base.** Measured by
file content, not graph.

~~Staging lacks: the `?ref=` order-disclosure fix, the cross-tenant union fix, the #242 webhook
resolver, the #223 amount gates, the #269 production deploy gate, the #266 CI key pin.~~

**WRONG — see the CORRECTION at the top.** The `?ref=` guard is byte-identical on both branches and
#122's route differs only in comments. Staging genuinely lacked **#242's webhook resolver** (the
vulnerable `.or()` was still live there), **#223's amount gates**, and the **#266 CI key pin**.

**This is why the plan is surgical ports, not a merge.** A merge of `cloudflare-staging` into
`main` puts 206 files in play and every conflict is a chance to resolve in staging's favour and
silently revert a production security fix. **Do not merge the branches in either direction.** The
two deploys above touch four product files between them.

### Band A commits exercised only by a unit test — click these first

| commit | what has actually exercised it |
| --- | --- |
| `e937278` (#220) | **unit test only.** Never in the A–Q simulation, never in Playwright, never clicked. |
| `7dc71d0` (#257) | **unit test only** — it *is* a test; no product code. |
| `090f508` console logs | **source-scan test only.** A grep. Nothing has observed a real console. |
| `6a6bb06` (#209) | **unit test only.** The withdrawn-method path has never been triggered live. |
| #305 / #302 leak half | staging probe **and** unit tests — but the probe exercises the *edit* escalation, which does not exist on production. On production only the **disclosure** half has meaning, and that has been measured on staging only. |

**Click-test #220 first.** It is a tab-destroying bug fix with no live coverage of any kind.

---

## 5. THE HONEST GAP

**What this plan cannot tell you.**

1. **Everything was verified on staging, against staging data.** The A–Q simulation, the
   Playwright suite, the #302/#305 chain and the #306 probe all run against
   `flashtap-staging.llosperofficial.workers.dev` and the `mdqjpxwczrhkxkbqatqa` project. None has
   ever run against production. Riviera's URL points at the staging worker, so a "Riviera pass"
   is not a production check either.

2. **Production behaviour differs in a way that changes severity, not just confidence.** The
   #302/#305 chain measures a takeover that **cannot occur on production** because the edit route
   is absent. What is live there is disclosure only. I have not measured what a leaked id can do
   against main's own routes — I read the code and named three consumers. That is a code read, not
   a probe.

3. **Deploy 1 has no runnable production verification.** The chain probe seeds fixtures and calls
   `close_table_session`; pointing it at production is not acceptable. The verification offered is
   a read-only eyeball and a two-phone click. That is weaker than everything else in this session
   and it should be treated as such.

4. **Surgical ports are not yet written, so they are not yet verified.** Deploy 1 and 2 describe
   hunks to be hand-applied to main's versions of four files. Until they exist and `tsc` runs
   against a tree at `3c6eec9`, "portable" is a claim from import analysis. **The import scan is
   static and one level deep — it checks what a file imports, not what those files import.** A
   second-level absence would surface as a build failure, not a silent defect, but it would
   surface after the branch is cut.

5. **What I inferred rather than measured:**
   - That the 15 `PENDING-COPY`-flagged commits are blocked *by those strings specifically*. I
     measured that they touch a file containing unsigned strings; I did not verify each commit's
     own diff introduces or depends on one.
   - `#209`'s eligibility. Its file carries a marker; its docblock says the #209 strings are
     deliberately unmarked. **Confirm by reading the file before shipping it.**
   - `02653f7` (#238) is `MIXED`; I did not identify which file is absent.
   - That the five no-op ports are complete no-ops. Their *files* are identical between the
     branches today; I did not verify each commit's own hunks are all present.

6. **The 91 "already on main by patch" commits were not individually inspected.** `git cherry`
   says an equivalent patch exists. It does not say the result is byte-identical, and #278 in this
   repo is a recorded case of a commit message being *partly* true.

7. **Nothing here has been tested as a promotion.** No promote branch was cut, nothing was
   cherry-picked, nothing was merged, nothing was deployed. This document is analysis only.

---

## Appendix A — the 106 staging-only commits

Oldest first. `port` = does every file it touches exist on main (`PORTABLE` / `MIXED` / `ALL-NEW`). `on-main` = files present / files touched. Flags are mechanical: `pay` = payments, PayCloud or webhook path; `auth` = session-guard, tab-member-key, guest-orders validation, middleware, lib/auth or the edit route; `MIGRATION` = touches supabase/migrations; `PENDING-COPY` = touches a file that still carries an unsigned string.

| # | sha | date | port | on-main | flags | subject |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `76153d8` | 2026-08-05 | MIXED | 5/8 | MIGRATION | fix(#143): reconcile staging migration ledger; teach drift check environme |
| 2 | `44480b2` | 2026-08-06 | MIXED | 5/6 | - | fix(#129): cap instruction text in the UI and stop long notes breaking the |
| 3 | `e8dec48` | 2026-08-06 | PORTABLE | 6/6 | MIGRATION | fix(#174): enforce unique (restaurant_id, table_number) in the database |
| 4 | `9b529be` | 2026-08-08 | MIXED | 5/6 | - | fix(#122): authenticate the by-payment-ref lookup (order enumeration) |
| 5 | `22bd729` | 2026-08-08 | MIXED | 1/2 | - | fix(#122): generate payment references with CSPRNG entropy, not Math.rando |
| 6 | `c86f892` | 2026-08-08 | PORTABLE | 3/3 | auth | fix(#66): honour the redirected-to admin page, not just the console root |
| 7 | `dd3d9eb` | 2026-08-10 | PORTABLE | 2/2 | - | docs(test): record why settle-tab-state needs no mock after a 2f76f9e reba |
| 8 | `f3e2295` | 2026-08-10 | PORTABLE | 2/2 | pay | fix(payments): reject an absent PayCloud result instead of reading through |
| 9 | `3ebac9a` | 2026-08-08 | PORTABLE | 3/3 | pay | fix(payments): refuse a payment for a restaurant with no configured mercha |
| 10 | `fb9583c` | 2026-08-11 | ALL-NEW | 0/2 | - | test(#125): non-mocked staging probe for the order_requests -> Accept mone |
| 11 | `a230d67` | 2026-08-11 | ALL-NEW | 0/2 | - | test(#125): extend the accept-seam probe to hosted, kiosk and concurrent A |
| 12 | `90555f1` | 2026-08-11 | ALL-NEW | 0/1 | - | test(#125): cover size/add-on modifier pricing through the accept seam |
| 13 | `ce3f958` | 2026-08-09 | PORTABLE | 3/3 | - | fix(#133 residual): fold duplicate rows when a cart-row NOTE is edited too |
| 14 | `e74d09c` | 2026-08-11 | PORTABLE | 1/1 | - | chore(batch A): satisfy the production lint gate on two batched test files |
| 15 | `6167f5d` | 2026-08-11 | MIXED | 4/5 | auth | #254: port the ?ref= injection fix to cloudflare-staging (unauthenticated  |
| 16 | `ae9c65e` | 2026-08-13 | MIXED | 12/22 | auth,MIGRATION,PENDING-COPY | feat(order-editing): customer edits before preparation, locked in the data |
| 17 | `d3eba56` | 2026-08-13 | ALL-NEW | 0/1 | - | test(order-editing): make the staging probe prove BOTH directions, not whi |
| 18 | `1b273bd` | 2026-08-13 | ALL-NEW | 0/2 | PENDING-COPY | docs(order-editing): record the re-acceptance ruling — only NOTES are exem |
| 19 | `4f3d968` | 2026-08-12 | MIXED | 3/6 | MIGRATION | fix(#265): staff-triggered PIN recovery, PIN never staff-visible |
| 20 | `cce8819` | 2026-08-13 | MIXED | 6/8 | - | fix(#273): the order refusal names the item instead of its UUID, and says  |
| 21 | `ad4cced` | 2026-08-13 | MIXED | 2/3 | - | fix(my-orders): the id an order is submitted with died with the browser ta |
| 22 | `fd44e90` | 2026-08-13 | MIXED | 1/2 | - | feat(cart): "Add to Tab" becomes Place Order, with a line saying what that |
| 23 | `cfe7887` | 2026-08-13 | MIXED | 1/3 | - | copy(cart): Place Order strings signed off — drop the placeholder marker |
| 24 | `f063bc3` | 2026-08-13 | MIXED | 3/8 | auth,PENDING-COPY | fix(order-editing): the edit route rejected the customer's own order with  |
| 25 | `23bb150` | 2026-08-13 | MIXED | 3/4 | auth | fix(security): one ownership predicate, and a CSPRNG for the id it authori |
| 26 | `a684b76` | 2026-08-13 | PORTABLE | 1/1 | - | fix(guest-orders): the by-session lookup matches BOTH placer columns |
| 27 | `caf44f3` | 2026-08-13 | PORTABLE | 6/6 | - | fix(guest-orders): the by-id read carries every session id, starting with  |
| 28 | `a64a422` | 2026-08-12 | PORTABLE | 12/12 | auth | fix(tabs): a member session_id is not a name — hand clients an opaque per- |
| 29 | `2417411` | 2026-08-14 | PORTABLE | 1/1 | MIGRATION | #262: land the anon-grant migration on staging, applied and verified by be |
| 30 | `9d7d81e` | 2026-08-14 | ALL-NEW | 0/1 | MIGRATION | chore(#127): commit the order-number unique index to staging, scoped |
| 31 | `63d252d` | 2026-08-14 | PORTABLE | 6/6 | - | fix(guest-orders): the last six call sites carry every session id |
| 32 | `d8d73b2` | 2026-08-14 | MIXED | 2/3 | PENDING-COPY | fix(nav): the "My Orders" button went to the cart, and My Orders was unrea |
| 33 | `b3d5c6d` | 2026-08-14 | MIXED | 3/5 | MIGRATION,PENDING-COPY | feat(tabs): staff-only flag when a customer holds an unpaid tab at another |
| 34 | `16298ed` | 2026-08-14 | PORTABLE | 3/3 | - | fix(landing): rejoin dead-ended on "PIN required" with no PIN field on scr |
| 35 | `dd28812` | 2026-08-15 | MIXED | 1/2 | - | fix(nav): Receipt and My Orders were the same icon, and below `sm` that is |
| 36 | `f46ccaa` | 2026-08-15 | MIXED | 3/5 | - | feat(menu): open the item popup for every item, including one with no opti |
| 37 | `b512c1c` | 2026-08-15 | PORTABLE | 2/2 | - | feat(tabs): show the tab PIN to every member, from the token-guarded read |
| 38 | `d9e6046` | 2026-08-15 | PORTABLE | 1/1 | - | docs(tabs): the PIN readout is a header line, not a chip |
| 39 | `793fb52` | 2026-08-15 | ALL-NEW | 0/1 | - | test(tabs): pin the gate the PIN disclosure rests on, not the happy path |
| 40 | `4cfef53` | 2026-08-15 | MIXED | 5/11 | auth,PENDING-COPY | copy: ship the signed-off strings and drop every PENDING COPY marker |
| 41 | `4861492` | 2026-08-15 | MIXED | 1/2 | - | fix(tabs): the PIN rendered twice; keep the strip's, drop the header line |
| 42 | `940d1c9` | 2026-08-15 | ALL-NEW | 0/1 | - | test(qr): two-sided staging probe for the four QR customer-flow exposures |
| 43 | `720bd16` | 2026-08-15 | PORTABLE | 2/2 | auth | fix(receipts): guest receipt email was gated on restaurant scope alone (QR |
| 44 | `6f2284c` | 2026-08-15 | ALL-NEW | 0/1 | auth | fix(order-editing): the edit lock refused its own holder (QRA-01) |
| 45 | `5aff054` | 2026-08-15 | MIXED | 1/2 | - | test(qr): pin the two rules the live probe cannot pin in CI |
| 46 | `dffbd32` | 2026-08-15 | MIXED | 1/2 | - | copy(tabs): the three create-tab refusals, signed off by the human |
| 47 | `23cd23b` | 2026-08-15 | PORTABLE | 4/4 | - | fix(landing): open the PIN prompt on TAB_PIN_REQUIRED instead of a dead re |
| 48 | `5b254df` | 2026-08-15 | MIXED | 11/14 | - | fix(tabs): one authoritative tab total, and honest polling (QRA-12/#119, Q |
| 49 | `66c0118` | 2026-08-16 | MIXED | 3/6 | MIGRATION | feat(orders): source_request_id — the missing half of the request/order re |
| 50 | `7d669e0` | 2026-08-16 | MIXED | 7/10 | - | feat(tabs): two figures everywhere — payable and pending |
| 51 | `1d63b32` | 2026-08-16 | MIXED | 4/5 | - | copy(tabs): ship the pending-figure copy, drop the placeholders |
| 52 | `d2c39c0` | 2026-08-16 | MIXED | 1/3 | - | feat(menu): the whole item card opens the sheet, on one shared availabilit |
| 53 | `c1839f4` | 2026-08-16 | MIXED | 2/4 | PENDING-COPY | feat(orders): Place Order lands on My Orders, with a banner instead of a t |
| 54 | `61cafb4` | 2026-08-16 | PORTABLE | 1/1 | - | fix(my-orders): decide the placed banner in the initialiser, not in an eff |
| 55 | `80e475b` | 2026-08-16 | MIXED | 1/5 | PENDING-COPY | feat(menu): the menu does one job — trackers out, Tab in the header, strip |
| 56 | `c025371` | 2026-08-16 | MIXED | 1/9 | PENDING-COPY | feat(tab): the shared tab actually shows the table, and a status vocabular |
| 57 | `913ba71` | 2026-08-16 | MIXED | 1/8 | auth,PENDING-COPY | feat(edit): the full mutation set, and the re-acceptance ruling the human  |
| 58 | `04fdd1b` | 2026-08-16 | ALL-NEW | 0/1 | - | fix(tab): the shared-tab read asked for a column that does not exist, and  |
| 59 | `69aeea9` | 2026-08-16 | ALL-NEW | 0/1 | - | test(qr): simulate redesign events A-Q against the deployed staging worker |
| 60 | `cdde535` | 2026-08-16 | ALL-NEW | 0/1 | - | test(qr): events A-Q against staging — 24 checks, 0 fails, including a rea |
| 61 | `be461c7` | 2026-08-16 | ALL-NEW | 0/1 | - | test(qr): exercise the ADDITION path live — 26 checks, 0 fails |
| 62 | `f1070c1` | 2026-08-16 | PORTABLE | 1/1 | - | feat(my-orders): one status vocabulary, no dashboard, and the "🎉 New" fall |
| 63 | `d850557` | 2026-08-16 | MIXED | 1/3 | - | feat(tab): settlement consolidates on the Tab — one "call the waiter", not |
| 64 | `c203a4a` | 2026-08-16 | MIXED | 1/5 | PENDING-COPY | feat(edit): "+ Add something" opens the menu in picker mode and returns to |
| 65 | `9921888` | 2026-08-16 | MIXED | 1/2 | PENDING-COPY | fix(#286): the unpaid-tab badge showed the cache, and could not show pendi |
| 66 | `090f508` | 2026-08-16 | MIXED | 3/4 | - | fix(qr): the customer app printed the session token to the browser console |
| 67 | `ee6005a` | 2026-08-16 | MIXED | 1/2 | - | fix(#173): a READY order was told it was being prepared, and a terminal-co |
| 68 | `932aefa` | 2026-08-16 | MIXED | 2/4 | - | fix(#275): staff were shown "Invalid transition: pending → preparing" |
| 69 | `0fdc5aa` | 2026-08-16 | MIXED | 1/2 | - | fix(#283, first half): the tab PIN came from Math.random |
| 70 | `2dcaad8` | 2026-08-16 | MIXED | 1/3 | - | fix(#288): the terminal labelled every order "Guest" — and it needs no APK |
| 71 | `02653f7` | 2026-08-16 | MIXED | 3/4 | pay | fix(#238): the audit trail called every figure "clientAmount", and it was  |
| 72 | `bf34f26` | 2026-08-16 | MIXED | 1/2 | - | fix(#232): the staff report counted cancelled payments as money to chase |
| 73 | `f3c831a` | 2026-08-16 | MIXED | 2/3 | - | fix(#246): the partial-menu-failure banner vanished exactly when it matter |
| 74 | `2583ed1` | 2026-08-16 | MIXED | 1/2 | - | fix(#249, #248): the same function answered the same question two differen |
| 75 | `59e8167` | 2026-08-16 | ALL-NEW | 0/1 | - | test(qr): live coverage for #249 and #248, and the vacuous-pass they invit |
| 76 | `b81c9c6` | 2026-08-16 | MIXED | 2/3 | - | fix(#224): a TOTAL menu outage told a searching customer "No items found" |
| 77 | `e937278` | 2026-08-16 | MIXED | 1/2 | - | fix: #220 - View Menu no longer destroys the customer's tab |
| 78 | `de617f3` | 2026-08-16 | ALL-NEW | 0/3 | - | fix: #169 - a calibrated schema probe, so the existence check stops lying |
| 79 | `b11940f` | 2026-08-16 | ALL-NEW | 0/1 | - | fix(sim): survive table debris, and stop printing a clean tally after an a |
| 80 | `95aca60` | 2026-08-16 | MIXED | 3/6 | - | fix: #206 - customer toasts stop rendering raw server error text |
| 81 | `e75d935` | 2026-08-16 | ALL-NEW | 0/1 | - | test: #206 - close the census gap the first commit left |
| 82 | `6a6bb06` | 2026-08-16 | MIXED | 1/4 | PENDING-COPY | fix: #209 - name the payment method that was actually withdrawn |
| 83 | `925ddaf` | 2026-08-16 | MIXED | 1/2 | - | fix: #267 - a worktree teardown that does not eat the shared node_modules |
| 84 | `0addfba` | 2026-08-16 | ALL-NEW | 0/1 | - | probe: #196 - settle whether the guest API ever returns a non-string order |
| 85 | `b8755fb` | 2026-08-16 | ALL-NEW | 0/1 | - | fix(sim): clean up payments and payment_events, which cleanup never touche |
| 86 | `f26ff25` | 2026-08-16 | ALL-NEW | 0/8 | auth | fix: #291 - a swap is not an empty order |
| 87 | `7bbe06e` | 2026-08-16 | MIXED | 1/2 | - | fix: #292 - the Tab screen's poll refreshes in place instead of blanking |
| 88 | `559f8ee` | 2026-08-16 | MIXED | 1/3 | - | fix: #293 - shared-tab line prices are what the customer pays |
| 89 | `fab95b7` | 2026-08-16 | ALL-NEW | 0/1 | - | test(sim): B-money - the shared tab's line figures are what the customer p |
| 90 | `340c3b6` | 2026-08-16 | MIXED | 2/4 | PENDING-COPY | fix: #294 - sweep every session-eviction path; a failed request is not an  |
| 91 | `2cf5886` | 2026-08-16 | ALL-NEW | 0/2 | - | fix(test): source scans must normalise line endings |
| 92 | `d595367` | 2026-08-16 | MIXED | 4/5 | - | fix: #295 - every customer-facing line price is what the customer pays |
| 93 | `b95855e` | 2026-08-16 | ALL-NEW | 0/2 | - | test(e2e): STEP A - the browser instrument proved on four real defects |
| 94 | `53e8f3f` | 2026-08-16 | ALL-NEW | 0/1 | - | test(e2e): STEP B - the click-test script, restricted to what a browser ca |
| 95 | `58b3edb` | 2026-08-16 | MIXED | 2/4 | - | fix: #296 - the confirmation screen stops inventing "Order #0" |
| 96 | `f4d2c02` | 2026-08-16 | MIXED | 8/13 | - | fix: #298 - render what the customer configured, so two lines stop looking |
| 97 | `ffd8d11` | 2026-08-17 | MIXED | 2/4 | auth | fix: #302 - the edit route authenticates with a server-issued token, and t |
| 98 | `6509f77` | 2026-08-17 | MIXED | 1/3 | - | fix: #302 (client half) - send the session token the browser already holds |
| 99 | `feae081` | 2026-08-17 | ALL-NEW | 0/1 | - | docs: record the #302 split-promotion hazard, and #305 |
| 100 | `b431bf0` | 2026-08-17 | MIXED | 1/2 | auth | fix: #305 - withhold raw member_session_id on tab-less rows |
| 101 | `c2f9dfc` | 2026-08-17 | ALL-NEW | 0/1 | - | test: #305 - the property holding it shut is now enforced, not incidental |
| 102 | `f6fee44` | 2026-08-17 | PORTABLE | 1/1 | - | test: #305 - the tab-less redaction cases the old assertion could not expr |
| 103 | `fe34dc0` | 2026-08-17 | ALL-NEW | 0/1 | - | docs: record #305's promotion ORDER constraint |
| 104 | `e69d7a9` | 2026-08-17 | ALL-NEW | 0/4 | auth,PENDING-COPY | fix: #306 - a lost response is no longer reported as "nothing was saved" |
| 105 | `81f1719` | 2026-08-17 | ALL-NEW | 0/2 | auth | fix: #306 - select customer_edited_at, without which the fix was inert |
| 106 | `df7fc46` | 2026-08-17 | MIXED | 1/4 | - | fix: #306 - the panel shows "already saved" as saved, and the guard covers |

---

## Appendix B — the 23 main-only commits

Present on `main`, absent from `cloudflare-staging` by patch-id. A merge in either direction puts these at risk; the plan avoids merging for this reason.

| sha | subject |
| --- | --- |
| `ce02bf8` | fix(payments): refuse a payment for a restaurant with no configured merchant |
| `56f70b8` | fix(security): stop ?ref= widening the guest order query (order disclosure) |
| `2072fce` | chore(#174): commit the restaurant_tables unique index to main |
| `5385776` | fix(#133 residual): fold duplicate rows when a cart-row NOTE is edited too |
| `d57c659` | chore(#135): bring lib/orders/instruction-limits.ts as a test-only dependency |
| `b77da91` | chore(batch A): satisfy the production lint gate on two batched test files |
| `1708997` | fix(#66): honour the redirected-to admin page, not just the console root |
| `7ff7e68` | fix(#174): enforce unique (restaurant_id, table_number) in the database |
| `f7ee138` | fix(#122): close cross-tenant order disclosure — the union neither branch had |
| `97e4fe1` | ci(worker): pin SUPABASE_SERVICE_ROLE_KEY in both worker deploys (#266) |
| `9fcb147` | fix(tabs): a member session_id is not a name — hand clients an opaque per-tab member key (#262) |
| `25724cb` | chore: hold the #262 anon-grant migration out of the code deploy |
| `2ccea66` | test(tabs): move the migration's own assertions onto the migration commit |
| `e326a55` | #262: land the anon-grant migration file now that it is applied to production |
| `ea80e72` | fix(#242): resolve the webhook merchant_order_no without a parsed filter |
| `3f52149` | fix(#242): make the probe script typecheck, so the branch can pass the gate |
| `6867ecc` | fix(#269): give production's deploy gate the same drift check staging has |
| `07b4737` | fix(#223): the stale-POS cron quarantines an unagreed amount instead of paying it |
| `3e98059` | fix(#223): extend the amount gate to the webhook, reconcile cron, and the eighth gate |
| `c0bee8b` | test(#223): exploiter — the ORIGINAL reproduction, independently reconstructed |
| `8f96483` | copy(tabs): the three create-tab refusals, signed off by the human |
| `3a042bd` | fix(receipts): port QRA-19 to main, carrying the ownsOrder consolidation |
| `3c6eec9` | fix(landing): open the PIN prompt on TAB_PIN_REQUIRED instead of a dead refusal |
