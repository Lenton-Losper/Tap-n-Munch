# HANDOVER — 2026-08-16. QR customer redesign, overnight build.

Written continuously, assuming the session is cut off mid-sentence. Everything below is measured
unless it says otherwise. Nothing has gone to production.

---

## STATE AT START OF RUN (measured, 2026-08-16 ~00:10)

    origin/main                   3c6eec9   fix(landing): open the PIN prompt on TAB_PIN_REQUIRED
    production /api/version       3c6eec9   cache-busted — EXACTLY origin/main, no drift
    origin/cloudflare-staging     1d63b32   copy(tabs): ship the pending-figure copy
    staging /api/version          1d63b32   cache-busted — EXACTLY origin/cloudflare-staging
    main ↔ staging divergence     119 commits on main not on staging / 150 the other way
    staging DB migration drift    136 local / 136 applied — OK, CLEAN
    unpushed local commits        ZERO, across every local branch

**The zero was verified two-sided, per Rule 13.** The comfortable answer from an unpushed-commit
check is the one that has lied before, so before believing it I built a synthetic unpushed commit
(`git commit-tree` on `origin/main`'s tree, creating no ref) and ran both forms against it:

    RIGHT  git rev-list --count <sha> --not --remotes=origin   -> 1
    WRONG  git rev-list --count --not --remotes=origin <sha>   -> 0

The predicate can return TRUE, so its FALSE across every branch means something. The synthetic
object is unreferenced and will be collected; no branch or tag was created.

### Documents read before starting

- `docs/qr-flow-audit.md` (4146 lines) — on branch `docs/qr-flow-audit`, worktree `wt-qr-audit`,
  at `936790a`. **Not present on `cloudflare-staging` or `main`.**
- `docs/agent-operating-contracts.md` — revision 3 plus the 2026-08-15 amendment to section 1
  step 2 (the `.env.local` production-credentials near-miss).
- `docs/handover-2026-08-11-sprint.md` — last checkpoint is **2026-08-14**. It does not cover the
  2026-08-15 session, which is where QRA-01/02/03/18/19 and the two-figures tab work landed.

---

## THE HEAD START NOBODY HAS WRITTEN DOWN

A substantial part of the redesign is **already on staging** and **not on production**. This
matters for reading the spec: several of its premises describe production, not staging.

| Commit (staging only) | What it already did |
|---|---|
| `f46ccaa` | **the item popup opens for EVERY item**, including one with no options — spec §11 |
| `dd28812` | Receipt and My Orders no longer share an icon — spec §7 |
| `b512c1c` / `4861492` | tab PIN readable by every member, rendered **once**, in the strip — spec §10 |
| `5b254df` | **one authoritative tab total** (QRA-12 / #119), and honest polling |
| `7d669e0` / `1d63b32` | **two figures everywhere — payable and pending** — spec §26 |
| `66c0118` | `orders.source_request_id` — the request→order link |
| `6f2284c` | QRA-01, the edit lock refusing its own holder |

So spec §40.I ("verify whether popup-for-every-item is live, staging-only, or not implemented")
answers: **staging-only.** And spec §26's two-figure requirement is largely built already.

---

## PIECES SHIPPED TO STAGING SO FAR

Each is its own branch, its own tests, deployed and confirmed live by a cache-busted
`/api/version` before the next one started.

### Piece 1 — item sheet for every item · `qrd/1-item-sheet` · merged `e2906a1`

The popup-for-every-item half already existed. What was missing: the card itself was not
tappable — only the 9×9 round `+` button opened it, on both the list card and the Popular
carousel card.

The risk in this change is not the tap target, it is that a **second entry point** to the same
action computes its own availability and drifts from the first. That is exactly #272's shape.
So the four-part condition moved out of the JSX into `lib/menu/item-sheet-availability.ts` and
both callers ask it. `isChargeableMenuStatus` deliberately did **not** move — it stays inside
`handleAddToCart`, the single funnel, and a test asserts the new predicate does not duplicate it.

An unavailable item now carries no handler and no `role="button"` at all, rather than being a
control that silently does nothing. Variant chips and the `+` button `stopPropagation`.

- **Proof:** static + regression. `tsc` 5.9.3 exit 0. 12 tests green.
- **Two-sided probe:** deleting the `out_of_stock` guard from the shipped module turned exactly
  1 test red by name; restored, marker absent, 12 green.
- **Live on staging:** `e2906a1607c91dc42b491dbd82c34ccb3a91b574`, cache-busted ×2.

### Piece 2 — Place Order lands on My Orders · `qrd/2-my-orders-destination` · merged `71fb9e0`

Spec §16. The tab path used to clear the cart, raise a toast, and `router.replace` back to
`/browse`. Two things were wrong with that: the menu does not answer the question a customer has
one second after ordering, and the toast is the weakest carrier available for the one thing they
needed to see (#207 is the live instance of a customer toast being dropped outright). The audit
adds a third: `/browse`'s strip renders `tabs.total`, which does **not** include the request just
placed until staff Accept — so the customer landed on a screen showing a number that excluded
what they had just done.

The banner is therefore raised by the **destination** from `?placed=1`, not fired from the cart,
so it survives the navigation rather than racing it. The parameter is stripped on read, so a
refresh, a Back, or a shared link cannot re-announce an old order (spec Event Q).

**Scope deliberately narrowed, and this is a deviation from the spec — see DEVIATIONS below.**
Only the TAB path moves.

- **Proof:** static + regression. `tsc` 5.9.3 exit 0. 11 new tests; 61 green across 11 suites
  including every `browse-*` suite and both toast suites.
- **Two-sided probe:** widening the banner predicate to `!= null` turned 7 red by name; restored
  and re-verified 11 green.
- **Live on staging:** `71fb9e008a298e468ebae9e2d4b2a67d26761668` (deploy confirmation pending at
  time of writing).

---

## ORDER OF WORK — CHANGED FROM THE BRIEF, WITH THE REASON

The brief's suggested order was 1 item sheet · 2 menu simplification · 3 My Orders destination,
and said to adjust if the code says otherwise. **2 and 3 are swapped.** The code says otherwise:

`MenuOrderStatusTracker` is the six-step tracker the spec wants off the menu — and it is *also*
where `ReadyToPayCardButton` / `ReadyToPayTerminalButton` render. Removing it from `/browse`
removes a settlement affordance as a side effect. Doing that **before** My Orders is the
post-order destination would leave a window in which a customer who has just ordered has neither
a tracker on the menu nor a reason to be on My Orders. Landing them on My Orders first means
order visibility never drops at any point in the sequence.

---

## DEVIATIONS FROM THE SPEC, AND WHY

1. **Piece 2 moves only the TAB path to My Orders. The non-tab path still lands on
   `/order-confirmation/[orderId]`.**
   That screen carries the per-order Ready-to-Pay affordance, and a non-tab order has no tab to
   settle from. Moving it before settlement is consolidated (piece 7) would strand the customer
   with no way to tell staff anything. It moves in piece 7, not silently now.
   The **gateway-return** route (`app/order-confirmation/page.tsx`, the `?tn=` one) is a different
   file and is untouched — the spec already says to preserve it technically.

2. **The inline variant chips stay on the menu card for now.**
   Spec §11 wants one interaction per item, and chips on the card are arguably a second
   configuration surface. They were left because the `+` button's `disabled` state depends on
   `isRequiredVariantMissing` over the card's own selection, and removing the chips without
   resolving that would permanently disable every item with a required variant group. Recorded
   here rather than fixed inside a piece scoped to something else.

---

## OPEN — TO BE FILLED AS THE RUN CONTINUES

- Section 40 assessment A–L: in progress; the terminal (G) and backend (D/E/J) halves are being
  established by dedicated read-only investigations rather than asserted from the audit alone.
- Events A–Q simulation results.
- PENDING COPY list.

### PENDING COPY so far

`git grep "PENDING COPY" -- lib/customer-copy/qr-redesign-copy.ts`

| String | Renders |
|---|---|
| `PENDING COPY — Order sent to the restaurant` | My Orders, temporary banner after Place Order (6s) |

Pre-existing markers elsewhere, unchanged by this run: 17 in `lib/orders/edit-lock.ts`, 2 in
`lib/orders/calculate-order-pricing.ts`, 1 in `lib/tabs/tab-flag-copy.ts`.

---

## TOOLING NOTES EARNED THIS RUN

**PowerShell 5.1 destroys UTF-8 in a probe round-trip.** `Get-Content -Raw` on a BOM-less UTF-8
file reads it as Windows-1252, and `Set-Content -Encoding utf8` writes the mojibake back **with a
BOM**. It silently turned `PENDING COPY — ` into `PENDING COPY â€” ` in a source file. It was
caught by the suite's own PENDING-COPY assertion, which is the only check that looked at the
string's content rather than its behaviour. Use a UTF-8-aware editor for probe substitutions on
any file containing non-ASCII, and keep an assertion on literal copy where copy matters.

**`scripts/check-migration-drift.mjs` needs `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in the
environment**, and a freshly-added worktree has neither `node_modules` nor `.env`. Run it from the
worktree's own root (Rule 10) after junctioning and copying `.env.test`, exporting the two vars
from `.env.test` — and check the URL carries the staging ref `mdqjpxwczrhkxkbqatqa` before doing
anything with the result.
