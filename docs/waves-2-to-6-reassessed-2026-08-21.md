# Waves 2–6, re-measured — the plan does not survive contact with the diff

**Tasks 3 and 4 collapse into one finding, so they are written up together.**

Nothing here was applied. `main` was not touched.

**Baselines:** `origin/main` = `f04c01b` · `origin/cloudflare-staging` = `622b9c0`.

---

## The headline

> **`main` and `cloudflare-staging` differ by 115 files, and exactly FOUR of them are runtime.**
>
> The 80-commit wave 5 does not exist as work to be promoted. Its content is already on `main`,
> promoted as squashed commits with different SHAs that no patch-id comparison can match.

```
git diff --name-status origin/main origin/cloudflare-staging   ->   115 files
  __tests__/   48        supabase/   4   (the known migration gap)
  scripts/     45        lib/        2   <- runtime
  ops/          5        app/        2   <- runtime
  docs/         5        .github/    2
                         CONTRIBUTING.md, .gitignore
```

The whole customer-facing surface the inventory calls "the entangled core" —
`app/menu/[restaurantId]/browse/page.tsx`, `my-orders/page.tsx`,
`app/api/guest/orders/[orderId]/edit/route.ts`, `components/order-edit-panel.tsx`,
`lib/guest-orders/queries.ts`, `lib/tab-session.ts`, `lib/orders/edit-lock.ts`,
`lib/customer-copy/qr-redesign-copy.ts` — is **byte-identical on both branches**. It is not in the
115.

### Why the 199 is so wrong

`git cherry origin/cloudflare-staging origin/main` reports **43 commits on `main` that are not on
staging by patch-id**. They are the squashed promotions of the same work:

| on `main` only | what it squashes |
|---|---|
| `b30b7e5` | feat(qr): **the customer redesign, with the signed-off copy** |
| `1591d12` | feat(order-editing): customer edits before preparation, with #302, #305 and #306 |
| `cd5e01a` | feat(order-editing): desired quantities, re-acceptance on introduced content, and Ready to Pay |
| `e703eb5` | feat(staff): the terminal, dashboard and review side of the redesign |
| `ec0eb4a` `0c883d0` `77dbf76` `ef9820b` `5a0cb9a` `4e876e4` `68c1eb9` `71fe6a3` `5c9d31d` | #308/#309, #307, my-orders ×3, status split, dashboard, #315, tax-rate |
| `e13340c` `14b32cc` `96a6974` `9fcb147` `f7ee138` `56f70b8` | the security fixes, promoted individually |

A squash has one patch-id for what staging holds as twenty commits. `git cherry` therefore reports
all twenty as absent. **`git cherry` overstates the backlog in exactly the way `rev-list`
overstates it, one level down** — and the inventory corrected the first error without catching the
second. This is what `scripts/check-branch-drift.mjs` was built for: it measures twice, patch-id
then reverse-apply, so content ported under a different patch-id reads PRESENT.

### Measured, not argued

Replaying the 123 non-wave-1 backlog commits onto `main` in order:

```
total=123   applied clean=39   conflicted=84
```

84 conflicts is not entanglement between waves. It is 84 commits trying to re-apply changes that
are already there.

---

## Task 3 — waves 2, 3 and 4

Each wave's commits were cherry-picked onto `origin/main` **individually**, from a clean tree, to
see whether the wave is self-contained. It is the cheapest possible test and all three fail it.

### Wave 2 — UI/copy. **0 of 7 apply. Not self-contained. Do not promote as a wave.**

The inventory calls this *"No schema, no shared logic. Lowest-risk runtime change in the set.
Independent."* All three claims are false.

| commit | result | conflicts in |
|---|---|---|
| `cfe7887a` copy(cart): Place Order strings signed off | CONFLICT | `app/menu/[restaurantId]/cart/page.tsx` |
| `4cfef53c` copy: ship the signed-off strings, drop every PENDING COPY marker | CONFLICT | 6 files incl. `app/api/guest/orders/[orderId]/edit/route.ts`, `my-orders/page.tsx`, `components/order-edit-panel.tsx`, `lib/orders/edit-lock.ts` |
| `dffbd32c` copy(tabs): the three create-tab refusals | CONFLICT | `app/api/tabs/route.ts` |
| `1d63b328` copy(tabs): ship the pending-figure copy | CONFLICT | `browse/page.tsx`, `my-orders/page.tsx` |
| `e3e2c51d` copy: ship the 30 signed-off strings | CONFLICT | `lib/customer-copy/qr-redesign-copy.ts`, `lib/orders/customer-status.ts`, `lib/tabs/tab-flag-copy.ts` + 2 tests |
| `167bb4a9` copy: F3 drops its leading plus | CONFLICT | `tests/e2e/banner-shows-only-my-order.spec.ts` |
| `8493c069` copy: the #307 quantity refusal | CONFLICT | (modify against diverged content) |

Its 7 commits share files with **61** other backlog commits.
`app/menu/[restaurantId]/my-orders/page.tsx` alone is touched by 15 others,
`browse/page.tsx` by 14, `components/order-edit-panel.tsx` by 11.

**Why it conflicts:** the signed-off strings are already on `main` inside `b30b7e5`
*"feat(qr): the customer redesign, with the signed-off copy"*. There is nothing to promote.

**Nothing to click-test, because nothing should land.**

### Wave 3 — order-editing. **0 of 18 apply. The "8" is a subject count, not a file count.**

Selected by file rather than by subject — every backlog commit touching
`app/api/guest/orders/[orderId]/edit/route.ts`, `components/order-edit-panel.tsx`,
`components/order-edit-indicators.tsx` or `lib/orders/edit-lock.ts`. That is **20** commits, not 8,
and two of them are the wave 2 copy commits — the two waves are the same work.

All 18 tested conflict. `ae9c65e9 feat(order-editing): customer edits before preparation` — the
wave's own foundation — conflicts, because `1591d12` on `main` already contains it *with #302, #305
and #306 folded in*.

The inventory's note that *"its migration (`20260813120000_order_editing_lock`) is already on
`main`, so this is code-only"* is right about the migration and wrong about the conclusion: the
code is already there too.

### Wave 4 — security test/CI backfill. **1 of 7 applies. The one that does is a test-only diff.**

| commit | result |
|---|---|
| `22bd7298` fix(#122): CSPRNG payment references | **CLEAN** |
| `9b529beb` fix(#122): authenticate the by-payment-ref lookup | CONFLICT |
| `6167f5dc` #254: port the `?ref=` injection fix | CONFLICT |
| `23bb1505` fix(security): one ownership predicate | CONFLICT |
| `2417411e` #262: the anon-grant migration | CONFLICT |
| `8392da8e` fix(security): a session ended by Close Table is over | CONFLICT |
| `2aa2186a` test(security): the browser proof for the session boundary | CONFLICT |

Consistent with the inventory's own finding that all six protections are already on `main`. What is
genuinely missing is **coverage**, and coverage is not a commit list — it is a file list.

### What wave 4 actually is: 48 test files

That is the real, promotable content, and it is the largest honest gap between the branches. It
includes the security coverage the inventory was pointing at —
`guest-orders-by-payment-ref-auth.test.ts`, `guest-routes-do-not-leak-foreign-order-ids.test.ts`,
`payment-reference-entropy.test.ts`, `tabs-route-discloses-pin-only-to-token-holder.test.ts`,
`tab-session-id-survives-tab-close.test.ts`, `session-eviction-sweep.test.ts`,
`generate-tab-pin.test.ts` — plus 41 others.

43 are **new to `main`** and 5 are **diverged** (`cart-per-item-instructions`,
`create-order-reprices-terminal-leg`, `payment-ref-cross-tenant-union`,
`payment-ref-filter-injection`, `terminal-cancel-bypass-end-to-end`,
`terminal-cancel-payload-reaches-handler`).

**The right shape is a file-level port, not a cherry-pick of the commits that produced them.** Take
staging's version of the 43 new files in one commit; review the 5 diverged ones by hand, because a
diverged test is a test whose subject changed on one branch and not the other.

**Risk:** the tests run in CI against a live staging project and 13 are known to fail at baseline
(`9c37952`). Landing 48 new suites on `main` without re-baselining will turn the production deploy
gate red. **That has to be measured before the port, not after** — and it is the one part of this
that can block a deploy.

**Click-test after it lands:** none. Tests do not ship to a customer.

---

## Task 4 — the "80-commit guest/QR/tabs/payments unit"

**It does not need an out-of-hours window, because it is not 80 commits. It is four files, from two
commits, and one of them applies clean.**

### What actually changes

| file | commit | what it does |
|---|---|---|
| `app/api/orders/route.ts` | `d55f3a9` **#303** | replaces two bespoke 400 refusals for a non-open tab with one 410 *"Your dining session has ended…"*. Keeps the status check — deleting it would let an order race onto a tab being settled. |
| `lib/customer-copy/customer-safe-error.ts` | `d55f3a9` **#303** | drops the now-unreachable *"This tab is ready to pay — you cannot add more items."* from the customer-visible allowlist. |
| `app/menu/[restaurantId]/tab/page.tsx` | `cd2802e` | adds a back-to-menu control to the Tab screen, which had **no exit at all**. Forward navigation to `/menu/{id}/browse?table={n}`, deliberately not `router.back()`. |
| `lib/customer-copy/qr-redesign-copy.ts` | `cd2802e` | the label for it. |

### What breaks if it half-lands

- **`cd2802e` alone** — safe. It is purely additive: one button, one copy key, one new test. It
  cherry-picks onto `main` **clean**, touching exactly
  `app/menu/[restaurantId]/tab/page.tsx`, `lib/customer-copy/qr-redesign-copy.ts` and
  `__tests__/customer-screens-have-an-exit.test.ts`.
- **`d55f3a9` split across its two files** — this is the one that bites. If
  `app/api/orders/route.ts` lands without `customer-safe-error.ts`, the allowlist still names a
  sentence the route no longer emits: harmless. **The other way round is the real hazard** — drop
  the allowlist entry while the route still returns the 400, and a live refusal stops matching the
  customer-safe allowlist. What happens then depends on `#206`'s handling of an unrecognised server
  string; on the customer's screen that is the difference between a sentence and a generic error.
  **Land both files in one commit.** It conflicts on `__tests__/customer-safe-error.test.ts` only —
  the runtime halves apply.

### The copy problem, and it is yours to rule on

`cd2802e` ships `tabBackToMenu: 'PENDING COPY - back to the menu'` — a **literal placeholder that
renders to the customer**, top-left of the Tab screen, at FNB ChowNow while it is trading. Your
standing rule is that copy ships as PENDING COPY or not at all, so this is consistent with it, but
it is worth seeing before it is on a phone rather than after.

### Click-test script

Short, because the change is short. On `flashtap.app`, one restaurant, one table:

1. Scan the QR, place an order, open **Tab**.
2. **The new control is top-left and reads `PENDING COPY - back to the menu`.** Tap it → lands on
   `/menu/{id}/browse?table={n}`, same table, tab intact.
3. Browser back from browse → does **not** land on a stale confirmation or an ended session.
4. Open Tab from the browse strip *and* from the header; the control behaves the same from both.
5. "No active tab" empty state — its existing exit still works and is not duplicated.
6. **#303:** have staff mark the tab ready to pay, then try to add an item from a still-open
   customer tab. Expect **HTTP 410** and *"Your dining session has ended. Please scan the QR code to
   start a new order."* — not the old *"This tab is ready to pay…"*, and not a generic error.
7. Repeat 6 after Close Table. Same message, same status.

### Rollback

`git revert` of the promotion commit, then dispatch `production-worker.yml`. No migration, no
schema change, no data written, so the revert is complete — there is no state left behind. The two
`customer-copy` files are compile-time constants; the route change is a status code and a string.

### How long the window needs to be

**It does not need one.** Four files, no migration, no money path, no session-boundary logic, and a
clean revert. The `#303` change touches the order-creation route, so it wants a moment when nobody
is mid-order — but that is minutes, not an out-of-hours window.

The out-of-hours window the inventory asks for was sized for 80 commits over
`lib/guest-orders/queries.ts`, `lib/tab-session.ts` and the tab routes. **None of those files
differ between the branches.** That work already went to production, in the squashed promotions
listed at the top, and has been running.

---

## What I did not establish

- **Whether `main`'s squashed versions are behaviourally identical to staging's history.** I
  compared trees, and the trees agree on every file outside the 115. That is a strong statement
  about the *code*, and it says nothing about whether a squash dropped something in a file that
  later commits rewrote anyway.
- **Whether the 48 test files pass on `main`.** Not run. 13 are known to fail at baseline `9c37952`
  and the suites cannot run in parallel because they share one staging project.
- **The four migrations.** Unchanged from the inventory; `orders_unique_order_number` still needs
  the duplicate count first and `seed_whatsapp_account_staging` must never be promoted.
- **`scripts/` (45 files) and `ops/` (5).** Wave 1 covers them; they are inert.
