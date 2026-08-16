# CLOSE-AUDIT — 2026-08-16, complete

**One question per issue: is its fix live at the current production SHA?**

Ground truth, re-measured at the time of writing, not inherited:

    production /api/version   3c6eec9605ab5b9ac1887d2d0cefbfbc20338fa0   (cache-busted)
    git rev-parse origin/main 3c6eec9605ab5b9ac1887d2d0cefbfbc20338fa0   IDENTICAL
    origin/cloudflare-staging 59e81672fb8932f90b51c333007c631f08fe28c1
    open issues                126

**Method.** The mechanical first pass greps every open issue number against commits reachable
from `origin/main`; that produced 28 candidates. `git log --grep` is where this audit *starts*
and never where it ends — commit messages cite issues they did not fix and fixes land citing
nothing — so every verdict below comes from **reading the file at the ref**, labelled CODE.

Every `git show` was run through PowerShell with `$LASTEXITCODE` inspected, because
`git show origin/main:.gitignore` under Git Bash on Windows mangles the colon, fails, and a
`|| echo "ABSENT"` fallback then prints a clean wrong answer. That mistake nearly put #188 in the
wrong bucket last night.

---

## A. SHIPPED AND LIVE — closed, evidence on each issue

Closed in the previous session, all CODE-verified at `3c6eec9`:

| | Evidence |
|---|---|
| **#242** | `.or()` gone; two `.eq()` unioned in JS at `resolve-order-by-merchant-order.ts:66,88` |
| **#240** | `__tests__/create-order-reprices-terminal-leg.test.ts`, 207 lines, present |
| **#188** | `.gitignore` has `.wrangler/`; `eslint.config.mjs:10` has `'.wrangler/**'` |
| **#211** | `v2/page.tsx` offers `Start a new tab at Table {n}` beside Rejoin |
| **#106** | `lib/recipes/actions.ts` updates `track_inventory` in both directions |
| **#218** | the 23505 branch refuses to mint and requires the PIN |
| **#128** | same commit, plus `.is('settled_at', null)` and the `add_tab_member` RPC |
| **#221** | `persistTabSession(storedId, storedTabTable ?? tableNum)` |
| **#235** | **premise false** — `close_table_session` settles every tab before bumping the version |

**Nothing was added to this bucket in this pass.** Every remaining candidate was verified and
none turned out to be live. That is the honest result, not a gap.

---

## B. FIXED ON A BRANCH, NOT LIVE — this is the promotion list

### Ready to promote right now

| | Where | Note |
|---|---|---|
| **#257** | `promote/257-guest-orders-validation-test`, cut from `3c6eec9` | **Settled empirically — see below. One file, no code change.** |

**#257 is answered.** In a detached worktree at `origin/main`:

    BASELINE  main's own test file            4 failed, 9 passed, 13 total   EXIT 1
    SWAPPED   staging's file (blob 546d50f)   15 passed, 15 total            EXIT 0
              ...against MAIN'S OWN validation.ts

`tsc` exit 0 with the file in place; main's other three guest-orders suites 45 passed. So main's
`guestCanAccessOrder` **already implements** the contract staging's test asserts — the test was
the stale half. Checked for the base-conditional trap: staging's file imports only
`guestCanAccessOrder`, `guestCanReceiveOrderDelivery`, `parseOptionalInt`, `paymentRefOrFilter`,
all exported by main, and does **not** touch `redactGuestOrderRow`, the one export staging has
and main lacks.

Promoting it takes main's known-failing baseline from **7 suites / 17 tests to 6 / 13** — the
same number as staging, so both branches would finally share one baseline.

### Fixed on `cloudflare-staging`, absent from `origin/main`

| | Evidence |
|---|---|
| **#278** | `heldSessionIds` is defined and used in **10 files** on staging; on main it appears in **two docblock comments only** and `lib/tab-storage.ts` does not define it |
| **#173** | staging's `OrderStatusBanner` uses `customerOrderState`; main's does not (grep exit 0 vs 1) |
| **#273** | staging's pricer selects `id, name, …`; main:161 still `id, base_price, …` and throws with a raw UUID |
| **#277** | staging `lib/tab-storage.ts` mints via `crypto.randomUUID()`; not on main |
| **#254** | staging `validation.ts` has `isWellFormedPaymentRef` + fail-closed filter |
| **#276** | order editing — staging only. **Partial**: its own 17 copy strings remain open |
| **#265** | tab-PIN recovery — staging only |
| **#119** | the authoritative tab total — staging only |

Plus everything shipped in this run and the last: **#286, #232, #238, #246, #248, #249, #283
(first half), #288**, and the session-token console logging that nobody had filed. All on
`cloudflare-staging`, none on `main`.

### Fixed on a branch that is on origin but on neither deployed ref

`feat/documents-edit-draft-invoice` (#61), `fix/186-type-gap` (#186), `fix/172-ts-nocheck`
(#172), `feat/156-settle-writes-sale-ledger` (#156) — all four confirmed present on `origin`.
MSG-level: I confirmed the branches exist and are not reachable from either deployed ref; I did
not audit fix quality.

---

## C. GENUINELY OPEN — CODE-verified defective at `origin/main`

Each of these I read at the ref this pass. The line is the decisive one.

| | The line at `origin/main` |
|---|---|
| **#234** | `app/api/payments/reconcile/route.ts:237` — `{ status, payment_status: 'paid', paycloud_transaction_id }`. **No `paid_at`, no receipt.** See the correction below. |
| **#236** | `app/api/tabs/[tabId]/join/route.ts:93` — `pin_required !== false && Boolean(tab_pin)`, so a NULL PIN disables the check |
| **#220** | `v2/page.tsx` — `handleViewMenu` calls `clearTab()` unconditionally |
| **#224** | `browse/page.tsx` — `{searchQuery ? 'No items found' : 'Menu coming soon!'}` with no outage distinction |
| **#279** | `validation.ts` — `Number(order.table_number) === table` still admits. **Also still on staging** |
| **#200 / #117** | `calculate-order-pricing.ts:161` — `.select('id, base_price, sizes, addons, tax_rate_id, status')`. `variant_groups` is **never selected**, so the pricer cannot read it |
| **#237** | `issueReceipt.ts:254` — the payment line is built from `payment_events.amount`, which is per-**settle**, not per-order |
| **#250 / #165** | `receipt-types.ts` — no `taxInclusive` / VAT-basis field exists at all (135 lines, no match) |
| **#139** | two inline `payment_status !== 'paid'` sites remain: `issueReceipt.ts:231` and `get-report-data.ts:167` (the latter fixed on staging as #232) |
| **#129 / #253** | `instruction-limits.ts` has exactly **one** importer at main — `__tests__/receipt-order-instructions.test.ts`. Zero app/lib/components consumers, so #199's premise also still holds |
| **#153 / #154** | `auto-cancel-stale-pos-orders.ts` splits on whether an attempt could have started; no retry bound, no escape hatch |

### A correction I have to record about #234

I first read `lib/payments/reconcile-orphan-payments.ts` — the **cron** — and concluded #234 was
fixed. That file *is* fine: `paid_at: paidAt` (L219), `safeIssueReceiptForOrder` (L234), and the
safety net at L245. Reading only it makes the issue look resolved.

The issue is about the **staff** route, `app/api/payments/reconcile/route.ts`, which hand-rolls
an `.update()` with no `paid_at` and no receipt. And the consequence is confirmed *by the other
file*: the cron's safety net selects `.gte('paid_at', since)`, so an order marked paid by the
staff route is invisible to the net that exists to catch exactly this.

**Not fixed here** — it writes the payment claim and would start issuing receipts. Off-limits for
this run. Recorded on the issue with the shape of the fix (`markOrderPaidConfirmed` already does
all of it correctly, and the cron already routes through it).

---

## D. CANNOT BE JUDGED FROM `main`

### Terminal line — ships by APK from `origin/feat/terminal-reconciled`; `main` contains no terminal app

**#231, #230, #184, #183, #182, #181, #164, #163, #162, #161, #148, #137, #136, #90, #82, #25.**
"Reachable from `origin/main`" is meaningless for these. #149 (APK provenance) belongs here too.
None should be closed on a `main` read; each needs a device version check.

**#288 is the exception and is already fixed** — the terminal renders `member_name` and the web
app never sent it, so the fix was server-side and reaches the existing APK.

### Blocked on a production database read, which this run may not do

**#263, #262, #245, #285, #284, #213, #193, #170, #67.**

**#67 is the sharpest of these.** Both halves are present at `main` — the migration
`supabase/migrations/20260725140000_orders_terminal_status.sql` exists, and
`components/orders-dashboard.tsx` reads `terminal_status` at three sites (1326, 1334, 1525). What
cannot be established from here is whether the **column is applied to production**. A clean drift
check would not settle it either: Rule 12's first row is *file absent + ledger absent = CLEAN*,
so a green drift check can mean both sides are equally ignorant. It closes the moment somebody
confirms the column exists on prod.

**#193 / #213** are the same shape — main carries the code half and deliberately dropped the
migration (`a6bb436`), so the two contradictory vocabularies no longer both exist in the repo,
but the live CHECK is a DB fact.

### Needs a product ruling, not a code change

**#274, #282, #270, #208, #154** — and two epics where "is it done?" is a judgement:

- **#13** — 16 admin pages exist at `main` (`dashboard`, `analytics`, `audit-logs`,
  `payments/lookup`, `bug-reports`, `alerts`, `orders`, …). Substantially built.
- **#19** — 27 document paths at `main`, including convert / correct / pdf / send /
  aged-receivables. Substantially built. **#61** (an edit affordance) is genuinely absent from
  main and sits on `origin/feat/documents-edit-draft-invoice`.

### Record issues — they close on acknowledgement, nothing will ever appear in code

**#199, #217, #257, #260, #261, #263, #281, #252.**

**#252's number is stale and misleading.** It claims 39 commits main-not-staging; measured by
`git cherry` / patch-id it is **23**, and the payment stack it names has since reached staging.
Anyone reading it today would over-estimate the exposure.

### Needs live traffic

**#107** — PayCloud RSA verification failing on ~100% of live traffic. Main's webhook has a
fail-closed signature path with an HMAC alternative, but whether that *fixed* the RSA failure or
*routed around* it cannot be told from code. Needs production logs.

**#268** — deliberately untouched this run, per instruction. It ships alone.

---

## WHAT I EXPECTED TO CLOSE AND COULD NOT

- **#234** — read the wrong file first; the staff route is still defective. Above.
- **#67** — repo half complete, DB apply unverifiable from here.
- **#13, #19** — substantially built; "done" is a product call, not mine.
- **#278** — looked live because `3a042bd`'s message says *"carrying the ownsOrder
  consolidation"*, and `ownsOrder` **is** on main. But `heldSessionIds` — the other half, and the
  one the issue is actually about — is not: it is defined in `lib/tab-storage.ts` on staging and
  in **no file** on main, where it survives only as two docblock references to a function that
  does not exist. A commit message that is *partly* true is the hardest kind to audit.
