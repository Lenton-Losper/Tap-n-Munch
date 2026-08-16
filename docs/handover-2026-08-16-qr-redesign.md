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

**`npx eslint . --max-warnings=0` is a BLOCKING gate on the staging deploy, and I was not running
it.** Piece 2's deploy failed on `react-hooks/set-state-in-effect`; staging stayed on the previous
SHA until it was fixed forward. Compounding it: `my-orders/page.tsx` carries `// @ts-nocheck`, so
a clean `tsc --noEmit` says **nothing** about that file — eslint was the only local gate that
could have caught it. Now run per piece before every push.

**A `**` before a path closes a block comment.** `**/view is deliberately…` inside a docblock ends
the comment at `**/`, and the compiler then reports twenty parse errors pointing at the code
below it, not at the comment. Cost one confusing tsc run.

**THE POWERSHELL UTF-8 TRAP FIRED A SECOND TIME, ON THIS FILE, AFTER I HAD DOCUMENTED IT ABOVE.**
`Set-Content -Encoding UTF8` on a BOM-less UTF-8 file turned all 126 em-dashes in this handover
into `â€”` mojibake, and I committed it. Caught by grepping for the mojibake sequence immediately
after the push, restored from the previous commit and re-applied with a UTF-8-aware editor.

Writing the rule down was not enough to stop me repeating it forty minutes later, so the
transferable form is narrower and mechanical: **do not use PowerShell to write any file that
contains non-ASCII.** Use the editor, or Python with an explicit `encoding='utf-8'` and a
temp-file rename. And grep for `â€”` after any bulk text edit — it is one command and it is the
only thing that sees this.

**A Python `io.open(path, 'w')` truncates before it writes.** A script that opens for write and
then throws leaves the file at zero bytes. It happened once tonight to a 232-line component; `git
checkout --` restored it and the restore was verified by blob hash against HEAD, not by `git
status`. Write to `path + '.tmp'` and `os.replace` it — which is what the later scripts do.

---

# CHECKPOINT 2 — pieces 3 and 5 shipped. The biggest real gap found and closed.

    origin/cloudflare-staging     85a945c   (pieces 1, 2, 3, 5 + the piece-2 lint fix)
    staging /api/version          cf7c1a4 confirmed live; 85a945c deploying at time of writing
    origin/main / production      3c6eec9   UNTOUCHED
    staging DB drift              136/136 CLEAN — no piece so far carries a migration

## Piece 3 — menu simplification · `qrd/3-menu-simplification` · merged `cf7c1a4` · LIVE

Spec sections 7, 8, 9, 33 and 37 on one screen. Trackers out of the menu; **Tab** replaces
**Receipt** in the header; the strip demoted to two rows and stripped of its settle promise.

**A live defect was found and fixed inside it.** The strip was a three-way ternary — one arm JSX,
two template strings. The pending figure was appended to the two template-string arms and **not**
to the JSX arm, which is the arm taken *whenever the tab has a PIN*. So on a PIN-protected tab —
the ordinary case — a customer who had just ordered saw the payable figure with nothing naming
what the restaurant had not yet confirmed. That is the exact "you owe NAD0.00 after ordering
N$132" failure the two-figure ruling was written to prevent, still live in one branch of the code
that was supposed to have fixed it. `lib/tabs/browse-tab-strip.ts` now builds the money line once,
before anything branches on the PIN, so a caller cannot render an amount without its pending note.

`browse-header-icons-are-distinct.test.tsx` was **updated, not deleted or weakened**. What it
records is a decision about two adjacent icon-only buttons below the `sm` breakpoint, and that
decision outlives the particular pair.

## Piece 5 — the shared tab · `qrd/5-shared-tab` · merged `85a945c`

**THE BIGGEST FINDING OF THE RUN.** `/menu/[id]/tab` already grouped by member and already showed
a server-derived table total — and the list it grouped came from `fetchOrdersForTab`, which is
scoped to the ids **this browser** holds. Lenton saw *"Lenton — Burger N$95"* under a heading
reading **N$115**, and Bob's Sprite appeared nowhere. The grouping was real and the data behind it
was one person's. That is worse than either half alone: the difference reads as a rounding error
rather than as absence. **Events B5, C and H could not have passed before this.**

### The decision most worth reviewing: a new route, not a wider one

The obvious home was the tab `view` route. It already reads every order on the tab to compute the
two figures and then throws the rows away — adding lines there would have cost nothing.

It is the wrong home because **that route is deliberately UNAUTHENTICATED**, and its own docblock
argues why: it returns a strict subset of what the published anon key already exposes. That
argument holds for a total and a list of first names. It does **not** hold for what everybody at
the table ate — the tab UUID travels in a `?tabId=` URL that `tab-context` adopts into
localStorage without validating it. So the lines went behind the session token, on a new
`GET /api/tabs/[tabId]/orders`, guarded by the same `requireSessionToken` +
`assertSessionMatchesResource` pair as ready-to-pay.

Rule 7 read in reverse: the cheap change was cheap *because* it reused a query, and what it would
actually have changed is **who can read the answer**.

### What it grants, and what it does not

- **Reading only.** Nothing in the new route is consulted by any write path. `is_self` is a
  rendering hint, never a permission. Section 25 holds: visibility is not edit ownership.
- `edit_lock_token` is **not SELECTed at all** — the surest way not to leak a capability from a
  new route is never to fetch it. `session_id` is dropped before grouping.
- **Never infers a financial relationship.** An order whose member cannot be resolved goes to an
  explicit `unattributed` block, named as such on screen. A key with no member row gets its own
  group instead — that one *is* attributed, to someone who left the array or ordered before
  joining, and calling it unattributed would lose the fact that those lines belong together.
- **No fallback to the session-scoped list.** A failed read says so out loud. The money still
  renders, because it comes from the separate `/view` read.

## Status vocabulary — SIX words, not four. A deliberate spec deviation.

Spec section 19 asked for four and asked that every backend state be enumerated first. It was, and
four cannot carry it:

| Backend state | Four-word model | What shipped |
|---|---|---|
| `waiting_review` / `pending` / `accepting` | Waiting for restaurant | **Waiting for the restaurant** |
| `accepted` / `confirmed` | *merged into "being prepared"* | **Accepted** — kept separate |
| `preparing` | Being prepared | **Being prepared** |
| `ready` | Ready | **Ready** |
| `ready_for_terminal` | *no home* | **Needs you** |
| `cancelled` | *no home* | **Needs you** |
| `declined` | *no home* | **Needs you** |
| `payment_status = failed` | *no home* | **Needs you** |
| `completed` + paid | Paid | **Paid** |
| anything else | *fell through to "🎉 New"* | **unknown** — promises nothing |

`accepted` is not merged into "being prepared" because staff taking an order is not the kitchen
starting it — **and it is the boundary editing closes at**, so the two states differ in what the
customer can still *do*, not only in what they are told.

**The fallback is the other half of that module.** `my-orders` ended
`configs[status] || configs.pending`, and `configs.pending` is `{🎉, 'New'}`. Every unmapped
status rendered as a brand new order. Removing the NEW badge (section 34) without fixing the
fallback would only move the lie.

`paid` is checked before any kitchen status, because `markOrderPaidConfirmed` writes `completed`
from any status. `completed` **without** a paid `payment_status` is deliberately NOT "Paid" —
staff reconcile can complete an order with no payment (#234), and that is the one error in this
table that costs somebody money.

## THE RE-ACCEPTANCE REVERSAL — read this before reviewing piece 6

The overnight brief rules: *"An edit that raises the total still requires staff re-acceptance —
that ruling stands. An edit that only removes items, lowers quantities or changes notes does
not."*

That **reverses a ruling the same human made on 2026-08-13**, recorded in
`docs/handover-2026-08-11-sprint.md`:

> *"Re-acceptance: ANY total movement, and only NOTES are exempt. RULED by the human 2026-08-13.
> … a removal changes what the kitchen makes and what the customer pays, so staff see it before
> cooking. The tempting simplification `return nextTotal > previousTotal` in
> `editRequiresReacceptance` was CONSIDERED AND REJECTED — there is a named test that fails if it
> is ever substituted."*

The new brief names the exact three cases, so this is a deliberate reversal by the person who made
the original ruling, not an oversight. The operating contract's *"a recorded decision is a ruling
already made"* exists to stop an **agent** overruling an absent human; this is the human
overruling themselves, in writing, in the instruction I am executing.

**It is being implemented, and the named test is being updated rather than deleted.** The safety
property the original ruling protected is preserved by a different means: a reduction no longer
*gates* on staff, but it is still recorded and still surfaced to them, so nobody cooks the old
list. Flagged here because it is the single change in this run most worth a second look.

## Verified myself rather than waiting — the four sale controls

Measured at `85a945c`, and it matches the audit exactly:

    checkStockSufficiency     app/api/orders/route.ts:187, app/api/terminal/orders/route.ts:100
                              -> NOT in the edit path
    validateOrderQuantities   app/api/orders/route.ts:58
                              -> NOT in the edit path
    repriceKeptLines          strict reduction BY CONSTRUCTION: an index outside the stored array
                              is refused, and a raised quantity is refused with the reason written
                              in the code (reprice-priced-lines.ts ~99 and ~114-116)
    editRequiresReacceptance  edit-lock.ts:231 — `toCents(prev) !== toCents(next)`, ANY movement

So the brief's *"expand the edit API"* is the audit's **Model A**, and the audit's stated
prerequisites for it are real rather than theoretical: all four guards that protect the creation
of a sale live on `POST /api/orders` and none of them is in the edit route. Piece 6 ports them
rather than reasoning around them.

## PENDING COPY — running list

`git grep "PENDING COPY" -- lib/customer-copy/qr-redesign-copy.ts lib/orders/customer-status.ts`

| Key | Renders |
|---|---|
| `orderPlacedBanner` | My Orders, banner immediately after Place Order |
| `stripHeadlineOpen` / `stripHeadlineReadyToPay` / `stripHeadlineClosed` | browse tab strip, leading word |
| `stripCta` | browse tab strip, trailing affordance — says View, not settle |
| `navTab` | browse header, the Tab button |
| `tabOrdersUnavailable` | Tab, when the shared read failed |
| `tabEmpty` | Tab, when the table genuinely has no orders |
| `tabOrderNotYetNumbered` | Tab, per order, before Accept allocates a number |
| `tabOrderAwaitingConfirmation` | Tab, per order, submitted-and-unanswered |
| `tabMemberPayable` | Tab, the per-person owed figure |
| `tabUnattributedHeading` | Tab, the unattributed block |
| `CUSTOMER_STATUS_COPY` × 7 | every customer status render site |

---

# CHECKPOINT 3 — piece 6 shipped, and the A–Q simulation runs GREEN against staging

    origin/cloudflare-staging     be461c7
    staging /api/version          37f39a2 confirmed live (cache-busted); be461c7 is script-only
    origin/main / production      3c6eec9   UNTOUCHED
    simulation                    26 checks, 0 FAILS, against the DEPLOYED worker

## Piece 6 — the full edit mutation set · `qrd/6-full-edit` · merged `ea063e6` + `04fdd1b`

The audit's **Model A**, which the audit recommended against. The human chose it knowingly, and
the audit's objection is what the piece had to answer: four guards protect the creation of a sale,
all four live on `POST /api/orders`, and none was in the edit route.

`lib/orders/apply-edit-additions.ts` ports **three of the four** — the per-line quantity cap, the
stock sufficiency check, and pricing against the live menu — calling the same functions, in the
same order, with the same fail-open on a stock READ error, so the same customer action cannot
succeed by one route and fail by another. The fourth, the payment-method allowlist, is
deliberately not ported: an addition to a tab order chooses no payment method, so there is
nothing to check it against. Recorded rather than silently omitted.

**A raised quantity is sent as an ADDITION, not as a raised `keep`.** `repriceKeptLines` refuses a
raise by construction and that refusal is load-bearing — the reduction path re-sums from the
order's own STORED lines, so a raise there would multiply a stored price without touching any of
the three guards.

### New rulings I took, since none existed and the build could not wait

1. **Mixed-vintage pricing.** Survivors keep the price and tax rate stored at placement;
   additions are priced at today's menu. Repricing the survivors was rejected for the reason
   already written into `reprice-priced-lines.ts` — it moves the price of items the customer is
   KEEPING, and it would refuse a removal because an *untouched* survivor had since gone out of
   stock. Mixed vintage is also what a real bill does. **Cost:** one order's lines can disagree
   about tax basis, which #250/#251 already describe; this adds a second way to reach it.
2. **The payment-method allowlist is not ported** (above).
3. **Piece 6 was split.** "+ Add something" opening the MENU in picker mode and returning to the
   pending edit is a cross-screen round trip that must survive navigation. Folding it in would
   have made this the big-bang commit the brief warns against. **Adding one more of a line
   already on the order works now; adding a NEW item from the menu is not built.**

## THE A–Q RESULTS TABLE

Run: `npx tsx scripts/simulate-qr-redesign-events-staging.ts`, against
`https://flashtap-staging.llosperofficial.workers.dev`, with real database state. Two guards,
both fatal, both before the first write. Fixture in table range 9200–9599, session ids prefixed
`probe-`, cleanup in a `finally` that discovers dependents.

| Event | Verdict | What was observed |
|---|---|---|
| **A** solo customer | PASSES | tab started, order submitted as an `order_request` |
| **A7** staff accepts | NEEDS-DEVICE | the Accept route requires a staff session a probe cannot honestly mint; the accepted order is seeded as fixture and the *route* is the human's click-test |
| **B** couple sharing | **PASSES** | Lenton sees `[Bob, Lenton]`, Bob sees `[Bob, Lenton]` — each phone sees the whole table |
| **B6** no cross-customer edit | **PASSES** | `is_self` marks exactly the viewing customer on each phone |
| **B-sec** | PASSES | the shared-tab response carries no session id and no edit-lock token |
| **C** group of four | **PASSES** | Ana sees `[Ana, Bo, Cass]`; Dee, who ordered nothing, sees the same table and has no group of her own |
| **C** My Orders stays personal | PASSES | Ana 1 order, Dee 0 — collective Tab, personal My Orders |
| **D** change before the kitchen | **PASSES** | reduction 498 → 403, `requiresReacceptance=false` |
| **D-reversal** | **PASSES** | a reduction does not require re-acceptance and `totalChanged` still reports the movement |
| **D-add** the new capability | **PASSES** | an item ADDED to an existing order: payable 115 → 193 at the menu price 78; the client deliberately sent `0.01` and it was **discarded** |
| **D-add-review** | **PASSES** | an addition raises the total and **does** go back for re-acceptance |
| **E** edit hold | **PASSES** | a non-owner gets **404**, not 403 — the response does not confirm another diner's order exists |
| **F** kitchen wins | **PASSES** | 409 `preparation_started`, *"The kitchen has started this order, so it can't be changed now."* — no token/lock jargon |
| **G/P** order more | PASSES | a new ticket, not a mutation: 2 → 3 orders for one customer |
| **H** pending + accepted | **PASSES** | payable 210 and pending 288 as separate figures, both visible |
| **H-lines** | PASSES | the same screen carries a submitted order and an accepted one, each labelled |
| **I** ready to pay | PASSES | writes `tabs.status='ready_to_pay'` and a preference — it alerts staff, it does not charge |
| **J** individual payment | **PASSES** | a terminal with a **genuine terminal JWT** settled a SUBSET (1 of 2 orders); the QR tab then showed remaining payable 20 |
| **J-visible** | PASSES | the settled order stays visible on the shared tab and stops counting toward payable — spec §29's partially settled tab |
| **K** whole-tab settlement | **PASSES** | the remainder settled; QR payable 0; `tabs.status` still `open` |
| **L** order after payment | PASSES | after full settlement the tab is `open` — payment does not end the visit |
| **M** late arrival | PASSES | covered by C/M: four phones joined by PIN at different times |
| **N** old customer vs new occupants | **PASSES** | after `close_table_session`, the old session's shared-tab read is refused **410** |
| **Q** refresh / return | PASSES | the repeat read is stable |
| **AUTH** (added) | PASSES | the shared tab without a session token → 410 |

**O** (customer scans another table) is **NOT RUN** — it is a landing-screen decision with no
API surface of its own, so it is the human's click-test. Nothing in this run changed it.

### What the simulation established that no amount of reading could

**Event J is real.** The audit's *"split and partial payment: NONE OF IT EXISTS"* is true of the
CUSTOMER surface and **false of the terminal's**: `app/api/terminal/tabs/[tabId]/settle/route.ts`
takes an `order_ids` array and binds it to the tab, so charging one diner's share is supported
server-side today. The human's ruling on this was correct and the audit's sentence was scoped to
what it had read. A terminal was seeded, activated through `POST /api/terminals/activate`, and
used its real JWT to settle a subset — and the redesigned QR tab reflected the remaining balance
with the paid order still on screen.

### The defect the simulation found, which no test would have

`GET /api/tabs/[tabId]/orders` selected a `created_at` column that **does not exist** on either
`orders` or `order_requests`. Both queries errored, and the route answered **200 with
`members: []`** — which the Tab screen renders as *"Nothing on the table tab yet"*.

A broken read presented as an empty table is exactly the failure the piece was built to remove,
and the only evidence was a `console.error` inside a Worker. Fixed in `04fdd1b`: the column list
is now the measured one, and on a query error the route returns `members: null`, which
`fetchSharedTab` already treats as a failure — so the screen says *"we couldn't load your
table's orders"* and the money, which comes from a different read, still renders.

**Two fixture defects in the harness itself were also found, and both read exactly like defects
in the thing under test:** the seeded accepted order was inserted without `items` (event D then
failed *"Line 0 is not part of this order"*, which looks like the edit route refusing a valid
index), and My Orders was read from an invented endpoint whose 404 read as *"this customer has
no orders"*.

---

# THE TERMINAL — NO CODE CHANGE NEEDED. Test on the existing APK.

**Answering the lead-time question first, because TMS needs it:** the redesign requires **no
terminal change**. Do not build a staging APK. Everything shipped tonight is web-side — one new
read-only endpoint and customer screens — and nothing the terminal writes or reads changed shape.

**And section 29 of the spec was right, while the audit's sentence was scoped.** The audit says
*"split and partial payment: NONE OF IT EXISTS"*. That is true of the **customer** surface and
false of the terminal's. Read at `feat/terminal-reconciled` / `72142ce`:

| | |
|---|---|
| `TableDetailScreen.tsx:70` | `const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())` |
| `TableDetailScreen.tsx:182, 647` | `toggleOrderSelection(item)` — **a checkbox on every claimable order row** |
| `TableDetailScreen.tsx:602-604` | `handleSettleSelected → runSettle(Array.from(selectedIds))` — **charge one person's orders** |
| `TableDetailScreen.tsx:606-610` | `handleSettleEntireTab → runSettle(unpaidIds)` — **settle the remaining balance** |
| `api.ts:610-628` | `settleTab(tabId, orderIds, amount, …)` → `order_ids: orderIds` |
| `app/api/terminal/tabs/[tabId]/settle/route.ts` | takes the `order_ids` array and **binds it to the tab**, never trusting cross-tab ids |

So Event J — *"I'll pay mine"* — is a real, shipped capability on both the device and the server.
The only place it did not exist was the customer's phone, which had no way to see a partially
settled tab at all. That is what piece 5 fixed, and the simulation verified it end to end with a
genuine terminal JWT.

**One consequence of piece 6 worth knowing before the click-test:** an edit that ADDS an item
raises the total, which sends the order back to `pending`. A `pending` order is not in the
terminal's settleable set until staff Accept it again. That is the existing transition table
doing its job, not new terminal behaviour — but if you add an item and then immediately try to
settle on the terminal, the order will not be there until you re-accept it.

---

# CHECKPOINT 4 — piece 9: "+ Add something", the last unbuilt spec item

    origin/cloudflare-staging     a159ba4
    origin/main / production      3c6eec9   UNTOUCHED
    staging DB drift              136/136 CLEAN — no piece in this run carries a migration
    unpushed, all local branches  ZERO (positional form)

`qrd/9-add-something-picker`. This was deliberately split out of piece 6 and is now built, so
**the full mutation set the human ruled for is complete**: add items, remove items, change
quantities in both directions, swap (remove + add), edit notes.

**Why it needed its own piece.** The editor is React state inside `OrderEditPanel`; the menu is a
different ROUTE. Going there unmounts the panel — which also releases the edit lock, deliberately,
so a customer who wanders off does not hold an order hostage for three minutes. So the pending
edit cannot live in component state across the round trip, and it must not live on the server
either, because nothing may commit until Save. `sessionStorage`, keyed per order, is the only
home with that exact lifetime.

**The part that would have been silently wrong.** In picker mode the item does **not** enter the
cart. Putting it there would let a customer press Place Order on something they meant as a change
to an existing order — two kitchen tickets for one intention, which is precisely what the ruling
avoids. The click-test asks you to watch the Cart badge for this reason.

Only the fields the SERVER prices from are carried; the cart item's `subtotal` / `base_price` /
`total` are dropped rather than passed through, so nothing suggests a client figure means
anything on the way in.

The editor reopens itself on return with **no extra query parameter** — a pending addition
existing for that order *is* the signal an edit is in progress. Cancel clears the list, which
clears the storage, so it cannot loop.

- **Proof:** static + regression. `tsc` 5.9.3 exit 0; `eslint --max-warnings=0` exit 0. 15 new
  tests, 152 green across 13 suites.
- **Two-sided probe:** collapsing the per-order key to one shared key — which would make one
  order's picks appear on another — turned exactly 3 red by name; restored, marker absent, 152
  green.
- **PROOF CEILING: UNIT.** The round trip crosses two routes and a storage boundary, which the
  API-level simulation cannot drive. Step 7b of the click-test is what settles it.

---

# THE GITHUB ISSUE WORK

## Close-audit — PARTIAL, and honestly labelled

133 issues are open. I ran the first pass mechanically (`git log --grep` across every open number
against `origin/main`), which produced ~35 candidates, and then verified candidates by
**Archaeological proof** — reading the file at `origin/main` — because `git log --grep` is where
this audit starts and never where it ends.

**Production was re-measured at the moment of use:** a cache-busted `https://flashtap.app/api/version`
returned `3c6eec9605ab5b9ac1887d2d0cefbfbc20338fa0`, byte-equal to `git rev-parse origin/main`.

### A. SHIPPED AND LIVE — closed, each with its evidence on the issue

| | Evidence read at `origin/main` |
|---|---|
| **#242** PostgREST `.or()` injection in the webhook resolver | the `.or()` is gone; two `.eq()` queries unioned in JS at `resolve-order-by-merchant-order.ts:66,88`, with the reasoning and a 13-payload measurement in the docblock. `ea80e72` ancestor ✅ |
| **#240** no test covers the POS repricing control | `__tests__/create-order-reprices-terminal-leg.test.ts`, 207 lines, present. `e05a59e` ancestor ✅ |
| **#188** `.wrangler/` untracked but not gitignored | `.gitignore` carries `.wrangler/`; `eslint.config.mjs:10` carries `'.wrangler/**'`. `36a078f` ancestor ✅ |
| **#211** open tab + scanning another table dead-ends the landing | `v2/page.tsx` distinguishes same-table from different-table and offers `Start a new tab at Table {n}` with *"your Table 3 tab stays open"*. `f7f28fc` ancestor ✅ |

### B. FIXED ON A BRANCH, NOT LIVE

| | |
|---|---|
| **#257** main's `guest-orders-validation` carries four permanently-red tests | **Settled by blob identity, not by reading**: `origin/main:__tests__/guest-orders-validation.test.ts` is `d8e1824…` (131 lines) and `origin/cloudflare-staging:…` is `546d50f…` (153 lines). Staging carries the repaired test; main does not. Promoting it closes the issue. |

Everything shipped tonight is also list B by definition — nine redesign pieces plus #286 and the
credential-logging fix, all on `cloudflare-staging`, none on `main`.

### C. EXPECTED TO CLOSE AND COULD NOT

**#285** — *an accepted `order_request` with a NULL `accepted_order_id` is unlinkable*. The issue
itself says the population is **zero on both environments** and that what is unverified is whether
**production's** `order_requests_accepted_has_order` CHECK exists, because the constraint arrived
inside a `CREATE TABLE IF NOT EXISTS` and would have been silently skipped if the table already
existed.

Settling it needs a read of production's `pg_constraint`, which is not reachable from here — and
the recorded alternative (*probe behaviour with live controls*) means **writing to production**,
which is forbidden and correctly so. So this is a **"should not be done"** ceiling rather than an
obtainable one: nobody should go and get it the way I would have had to. It stays open.

### D. TERMINAL LINE — cannot be judged from `main` at all

`origin/feat/terminal-reconciled` ships to devices by APK and `main` contains no terminal app.
"Reachable from `origin/main`" is meaningless for **#230, #231, #148, #136, #137, #181–#184,
#161–#164, #90, #25**. None of them was assessed, and none should be closed on a `main` read.

### THE HONEST GAP

This is a **partial** audit. I verified six issues to CODE standard out of 133 open. The
mechanical first pass covering all 133 is done and its candidate list is reproducible in one
command; what is missing is the file-reading verification for the ~29 remaining candidates. I
would rather hand you six issues settled with evidence than thirty settled by commit message —
commit messages lie in both directions, and #188 nearly went into the wrong list from a shell
quoting bug that printed a clean, confident, wrong answer.

## Issues FIXED tonight

### #286 — the unpaid-tab badge showed the cache, and could not show pending

**The issue's premise is partly wrong, and that is worth recording.** It describes
`orders-dashboard.tsx:600-610` as *"the tabs panel"*. There is no tabs panel showing per-table
totals — that code feeds the **unpaid-tab-elsewhere badge**, the staff-only flag rendered on an
order card whose customer left another tab open. Right line numbers, wrong description.

The finding underneath is real and sharper than filed: the badge rendered `tabs.total`, the cache
the human demoted to display-only on 2026-08-15. A staff member was being shown a money figure,
to prompt them to go and speak to a customer, taken from the one column the product has ruled
must not be rendered as what is owed.

**What I measured, and what I did not.** Read-only against staging, 6 open/ready tabs:

    cache AGREES with computed payable                 6
    cache DISAGREES                                    0
    tabs with pending money the badge could not show   2

The cache-disagreement half is **not demonstrable on staging today** — six tabs on a project
cleaned earlier tonight, and absence there is not evidence of absence. The 13-gross/6-outstanding
split is a **production** measurement from 2026-08-15 recorded in `tab-outstanding.ts`, inherited
here, not re-measured. The half I did measure is the one that fires today: 2 of 6.

Fixed by using `computeTabFigures` — the same function every customer surface uses — and showing
both figures. **The terminal Tables screen half of #286 is deliberately NOT done**: its
`unpaidTotal` is already payable computed with the same `owesMoney` predicate, so the decide half
is right; the display half needs an APK, and adding a `pendingTotal` the terminal cannot render
would be an unread field. **#286 stays open for that half.**

### The customer app printed the session token to the browser console

Found while reading the browse screen, filed by nobody. Three `console.log` calls printed
credentials in plain text on every mount on a customer's phone:

    session-ended/page.tsx:9   localStorage token: <flashtap_session_token>
    session-ended/page.tsx:10  localStorage tab:   <flashtap_tab_id>
    v2/page.tsx:185            token at mount:     <flashtap_session_token>

**Two of these are live on PRODUCTION** — verified by reading the files at `origin/main`.

**Why I did not wake you.** It does not widen the attack surface: anything that can read the
console on that device can read `localStorage` on it too, and the token is already there. I
grepped for anything shipping console output off-device — Sentry, LogRocket, Datadog, Bugsnag,
console hooking — and there is none. So it is bad hygiene, not an exposure, and it did not meet
the one bar you set. **If a crash-reporting SDK is ever added it stops being merely untidy**,
which is why the fix ships with a guard that scans shipped source and refuses credential-shaped
values as arguments to a console call anywhere under `app/menu`.

Also removed: a debug effect logging the full payload of three named menu items on every
customer's browser on every menu load, left over from investigating #229.

**Promoting the two production instances is your call** — nothing went to `main` tonight.

### #173 — a READY order was told it was being prepared

Confirmed live on **production** by reading `origin/main:components/OrderStatusBanner.tsx`. The
file is byte-identical on main and staging (blob `04605af`), so it was live everywhere.

```ts
case 'ready':
  message: oldStatus === 'accepted' ? `Order #N is being prepared.` : `Order #N is ready!`,
  type:    oldStatus === 'accepted' ? 'info' : 'success',
  icon:    oldStatus === 'accepted' ? '👨‍🍳' : '🍽️',
```

An order moving `accepted → ready` announced the **less advanced** state — message, severity and
icon downgraded together. And that transition is not an edge case: it is what happens whenever
the kitchen sets no explicit `preparing` step. The customer was told their food was being cooked
at the moment the restaurant said it was done.

The second half: the terminal writes `confirmed` where the dashboard writes `accepted`.
`confirmed` had no case, fell to `default: return null`, and the customer heard **nothing**.

One cause — a private status map, the fifth copy of the customer vocabulary in this product. It
now switches on `customerOrderState`, so it cannot disagree with My Orders or the Tab, and it
gains a `preparing` case it never had.

**Deliberately not changed:** the arm that fires when an in-progress order *disappears* and infers
completion from the disappearance. Routing its synthetic `'completed'` through the vocabulary
would have changed it — `completed` without a paid `payment_status` maps to `ready` on purpose
(#234) — so a vanished unpaid order would have started announcing *"is ready!"*. Its message is
built locally now, preserving existing behaviour exactly.

---

# EVERY PENDING COPY STRING, AND WHERE IT RENDERS

`git grep "PENDING COPY" -- '*.ts' '*.tsx'`

## `lib/orders/customer-status.ts` — the status vocabulary (7)

Renders on **every** customer status site: My Orders badges, the Tab's per-order line, the
status-change banner.

| Key | Placeholder | Backend states it covers |
|---|---|---|
| `waiting` | Waiting for the restaurant | `waiting_review`, `pending`, `accepting` |
| `accepted` | Accepted | `accepted`, `confirmed` |
| `preparing` | Being prepared | `preparing` |
| `ready` | Ready | `ready`, and `completed` with no payment |
| `paid` | Paid | `payment_status = 'paid'` |
| `needs_you` | Needs you | `ready_for_terminal`, `cancelled`, `declined`, payment `failed` |
| `unknown` | The restaurant is handling this | anything unmapped — **must promise nothing** |

## `lib/customer-copy/qr-redesign-copy.ts` — the redesign's own strings (14)

| Key | Placeholder | Renders |
|---|---|---|
| `orderPlacedBanner` | ✓ Order sent to the restaurant | My Orders, 6s banner after Place Order |
| `stripHeadlineOpen` | Table tab | browse tab strip, leading word |
| `stripHeadlineReadyToPay` | Ready to pay | same, when the tab is ready to pay |
| `stripHeadlineClosed` | Tab closed | same, when the tab is closed/settled |
| `stripCta` | View tab → | strip, trailing affordance — **says View, not settle** |
| `navTab` | Tab | browse header button (replaced Receipt) |
| `tabOrdersUnavailable` | We couldn't load your table's orders just now. The total above is still correct. | Tab, when the shared read fails — **must not imply the table is empty** |
| `tabEmpty` | Nothing on the table tab yet | Tab, genuinely empty |
| `tabOrderNotYetNumbered` | New order | Tab, per order, before Accept allocates a number |
| `tabOrderAwaitingConfirmation` | Waiting for the restaurant | Tab, per order, submitted-unanswered |
| `tabMemberPayable` | Owed: | Tab, the per-person figure |
| `tabUnattributedHeading` | Also on this table | Tab, orders whose member could not be resolved |
| `pickerBanner` | Choosing something to add to your order | the menu, in picker mode |
| `pickerBack` | Back to my order | beside the picker banner |

## `lib/orders/edit-lock.ts` — the editor (4 new)

| Key | Placeholder | Renders |
|---|---|---|
| `editDeadline` | You can change this order until the restaurant starts preparing it. | editor, **primary** line |
| `holdSecondary` | Editing reserved for you · {seconds}s | editor, **secondary**. `{seconds}` is substituted by `.replace()` and must stay literal |
| `addSomething` | + Add something | editor, opens the menu in picker mode |
| `addOneMore` | Add one more | editor, per line |

> `EDIT_COPY.lockHeld` (*"{seconds}s left to make changes"*) is **superseded and no longer
> rendered**. It is kept exported with the reason attached rather than deleted, because it is the
> string spec §21 is about.

## `lib/tabs/tab-flag-copy.ts` — staff (1 new)

| Key | Placeholder | Renders |
|---|---|---|
| `unpaidTabElsewherePendingSuffix` | awaiting confirmation | staff order card, appended inside the unpaid-tab badge's `{total}` |

## Pre-existing, untouched by this run

17 in `lib/orders/edit-lock.ts` (the original edit-lock set), 2 in
`lib/orders/calculate-order-pricing.ts`, 1 in `lib/tabs/tab-flag-copy.ts`.

**Total new tonight: 26 strings.** Every one is a placeholder; none was drafted, per your standing
instruction. Several change what a customer is told about money and are yours to rule on —
`tabMemberPayable`, `tabOrdersUnavailable`, `tabOrderAwaitingConfirmation` and the whole status
table especially.

---

# #275 — staff were shown "Invalid transition: pending → preparing"

Fixed, and **it got more likely tonight, not less**, which is why it was worth doing now.

The issue's own reproduction was: staff Accept → the customer **removes** a line → the order
returns to `pending` for re-acceptance → staff press Start Preparing on a pre-refresh screen. As
of your re-acceptance reversal a reduction **no longer** returns an order to `pending`, so that
exact path is gone — but an edit that **adds** an item does, and adding is newly possible. The
path survives with a different first step.

Both routes now answer in the dashboard's own vocabulary — its badge for `pending` reads **New**,
so "pending" was a word staff saw nowhere else — and every branch says what to *do*. "Invalid
transition" told them only that something was wrong, which is the half they could already see.

**The refusal itself is unchanged and was not relaxed.** `isValidStaffStatusTransition` still has
no `pending → preparing` edge. The issue was deliberately filed separately so nobody "fixes" it by
widening the table; that has been honoured.

**The terminal route was changed too, and it needs no APK.** The device renders `error` verbatim,
so the string is what staff read on the terminal. I grepped `C:\RN\FlashTapTerminal/src` for
`Invalid transition` and `Invalid status` — no matches — so nothing on the device keys on the
prose and the improvement lands without a rebuild. A stable `code` now travels with every
refusal, so the next thing that wants to react has something better than a sentence to match on
(#273's lesson).

---

# #283 (FIRST HALF ONLY) — the tab PIN came from `Math.random`

```ts
Math.floor(1000 + Math.random() * 9000).toString()
```

`Math.random()` is not a CSPRNG — V8's is xorshift128+, seeded per isolate and **recoverable from
a small number of outputs**. And the outputs here are handed to whoever created the tab. So an
attacker who opens several tabs of their own on the same Worker isolate can recover the generator
state and predict the PIN a genuine customer is about to be given. The PIN is the only control on
joining someone else's table.

Same finding and same fix as **#277**, which replaced `Math.random()` in `mintTabSessionId`.

Uses **rejection sampling**, not `% 9000`: 65536 is not a multiple of 9000, so a plain modulus
makes the bottom 2536 values ~50% more likely — and "the distribution is not exploitable" is the
entire point. It also **does not fail open**: with no Web Crypto it throws, exactly as
`mintTabSessionId` does.

**#283 IS NOT CLOSED AND MUST NOT BE.** This is one of its two halves. A CSPRNG stops
*prediction*; it does nothing about a client trying all 9000 values. There is still **no rate
limiting** on PIN entry. The issue compares this to the staff PIN beside it, which has a full
lockout in `lib/terminal-auth/pin-lockout.ts` — reusing that shape is a design decision rather
than a swap, and QRA-06 records that this product has no rate limiting anywhere except the
PayCloud webhook. **That half is yours to rule on.**

---

# WHAT THE INVESTIGATIONS TURNED UP — including two things I then fixed

Four read-only investigations ran alongside the build. Their findings, and what I did with them.

## #288 — the terminal labels every order "Guest". FIXED, and it needed no APK.

`TableDetailScreen.tsx:665` renders `{item.member_name || 'Guest'}` — and `member_name` **did not
exist anywhere in the web app**. Verified two-sided, exit codes read from the command itself:

    git grep -q "member_name"       -- '*.ts' '*.tsx' '*.sql'  -> exit 1  ABSENT
    git grep -q "member_session_id" -- '*.ts'                  -> exit 0  control, search works

So the fallback fired on every row, always. **This is not cosmetic**: the terminal ships a
per-order multi-select and a "Settle Selected" button — the feature that answers *"I'll pay
mine"* — and staff could not tell which orders were whose. As of tonight the customer's phone
groups their tab by name and the staff terminal did not.

Fixed server-side; **the device already reads `member_name` and already falls back to 'Guest'**,
so the field simply starts arriving. The raw `session_id` / `member_session_id` are destructured
off before the response spread — `ownsOrder` makes knowing one the whole authorisation, and there
is no reason for one to be on a terminal screen.

## #287 — the first partial settle wipes the ready-to-pay signal. FILED, NOT FIXED.

`clearReadyToPayAndReopenTab` clears `payment_preference` / `ready_to_pay_at` **unconditionally**,
with no "does this tab still owe money" guard. On a table of four who have all asked to pay,
charging one diner wipes the signal for the other three, and the terminal's chip — which reads
`tab.status === 'ready_to_pay'` — silently disappears.

**I did not fix it, and the reason is a three-way tension worth your ruling:**

- Restoring the chip means keeping `status = 'ready_to_pay'` — and `app/api/orders/route.ts:138`
  **refuses new orders on a `ready_to_pay` tab**, which would stop the remaining diners ordering
  anything more. That contradicts Event L and the helper's own documented intent.
- Preserving only the flags and reopening the status changes **nothing observable**: every
  consumer keys on `status`.
- So **every option that restores the staff signal needs a terminal change**, which needs an APK,
  which needs TMS lead time.

Options and a recommendation are in #287. Short version: preserve the flags now (safe, additive,
stops destroying the record), split the concepts properly when an APK is next built.

## Findings I did NOT act on, recorded so nobody re-derives them

- **`/tab` never fetches the PIN.** Browse reads it from the token-guarded route; the Tab screen
  shows only `sessionStorage.flashtap_creator_tab_pin`, so **a joined member sees no PIN there**.
  Spec §10 wants the PIN findable; today it is findable on the menu strip only. Not a regression —
  it predates tonight — but it is the gap if you were expecting the Tab to carry it.
- **`/order-confirmation` is the signed Finatic `return_url`** (`payments/paycloud.js:393-398,
  560, 787`), so that route can be demoted but **never renamed**. Piece 2 and piece 8 both respect
  this; anyone tempted to delete it should read that first.
- **#252's number is stale.** It claims 39 commits main-not-staging; measured tonight by
  `git cherry` / patch-id it is **23**, and the payment stack it names has landed on staging.
- **#255 and #256 premises are now false as written** — staging has the stock files and the
  gateway-amount constants they say it lacks.
- **#179 has a recorded ruling against it** — fixed at `df99356`, then **reverted at `f74303e`**,
  with the reasoning preserved as a test comment at `origin/main:__tests__/table-landing-routing.test.ts:133`.
  Do not re-fix without overturning that.
- **#200 and #117 are the same defect filed twice**, and the mechanism is narrower than the title:
  the pricer never *selects* `variant_groups`, so it does not ignore a price it can see. Whether
  anyone is undercharged depends on whether a priced option has no legacy twin. **Measure before
  building a fix.**
## #238 — FIXED. And #268 turns out to be blocked on a port, not on effort.

`markOrderPaidConfirmed` wrote `amount` and `clientAmount: amount` into the `payment.completed`
audit entry — the same value twice, under two names. **Measured across all six call sites, it is
worse than the issue says:** four pass the order's own total (terminal callback, terminal
verify-payment, the PayCloud webhook, the reconcile cron) and two pass Finatic's figure (the
auto-cancel cron's pre-cancel check, the terminal payment-failure correction). So `clientAmount`
was nobody's client amount — it was `amount` again, under a label that made a historical mismatch
look investigable when nothing had been recorded to investigate.

Safe to correct because it was **write-only**: grepped across `*.ts`, `*.tsx`, `*.sql`,
`__tests__` and the terminal app; nothing read it.

Now `amount` is what the caller asserted, `amountMeaning` says whose figure that is, and a new
optional `gatewayAmount` carries the provider's own number. `?? null`, **not** `|| null` —
*"Finatic said N$0"* and *"this path never asked Finatic"* are different facts, and there is a
test for exactly that collapse.

**#268 stays open, and I established why it cannot be closed on staging tonight.** Its subject is
the webhook's valid-signature path, and `extractWebhookGatewayAmount` **exists on `origin/main`
and not on `cloudflare-staging`**:

    git grep -q "extractWebhookGatewayAmount" origin/main               -> exit 0  present
    git grep -q "extractWebhookGatewayAmount" origin/cloudflare-staging -> exit 1  absent

The webhook's claim helper has no amount in scope at all, so closing #268 means porting that
helper first — onto the **sole confirmation path for QR hosted checkout**. Not a change to make
unattended at the end of a long session. This commit gives it the field to write into. Both
issues carry a comment saying so.

## #232 — FIXED, and the probe corrected my own claim about the proof

`unresolvedOrders` on the staff report read `o.status !== 'cancelled' && o.payment_status !== 'paid'` —
the **sixth** site of a question this codebase has answered five times. `payment_status =
'cancelled'` is a value it writes and is deliberately absent from `OWES_MONEY_PAYMENT_STATUSES`,
so an order whose *payment* was cancelled appeared as *"stranded/pending, surfaced same-day"* —
money nobody owes, presented as money to chase.

**Measured impact on staging: none.** 14 non-cancelled orders, `payment_status` only ever `paid`
or `pending`, so the predicates agree exactly today. That is a freshly-cleaned sample and is not
evidence of absence; the defect is latent.

**The part worth reading.** The test first said *"that the report calls `owesMoney` is covered by
reading and by tsc."* A two-sided probe reverting the call site measured what actually noticed:

    jest  -> 10 passed    the suite binds to the RULE, so it cannot see the call site
    tsc   -> exit 0       the inline version is perfectly valid TypeScript

**Nothing caught it.** Writing "covered by tsc" would have been a false statement about my own
evidence, in a commit message. So the suite now also scans the shipped source, and the same probe
re-run turns 2 red by name. Same shape as the credential-logging guard, and for the same reason:
it is the only thing that can see this.

## #246 — the partial-menu-failure banner vanished exactly when it mattered most

The render site required `filteredGroupedEntries.length > 0`, so when some categories failed to
load **and** the customer then searched for something not in the part that *had* loaded, the
banner disappeared — leaving them looking at **"No items found"**, an affirmative claim about the
restaurant's menu, with no hint it was incomplete. The item they were searching for may well have
been in the category that failed.

**It does not overrule the recorded decision beside it,** and that is the whole reason it works.
`menu-body-state.ts` rules that *"while searching, a stale notice must not displace the 'no
results' wording"*. That stands, and now has its own test. These are **two different seams**:
`menuBodyState` decides what the **body** says (still "No items found"); the banner is a strip
**above** it, and whether it appears is a question the body-state rule never answered. They now
coexist.

## #216 — NOT fixed, but the audit found the mechanism the issue does not name

Measured on staging: **0 of 11** live tabs are invisible to the terminal, so the state is not
currently present. But `app/api/tabs/route.ts:350` is

    await supabase.from('restaurant_tables').update({ status: 'occupied' }).eq('id', tableRow.id)

with **the result discarded** — no error checked, nothing logged, route returns success. If that
one write fails, the tab is live while its table stays `available`, and the terminal's
`.eq('status','occupied')` filter hides the table, the money on it, and any way to settle it.
Nothing reports it. Same family as #195.

I did not change it: the robust fix is dropping the `occupied` filter from the terminal query —
defensible, because the query already joins `tabs!inner` filtered to live tabs, so the filter is
purely narrowing — but it changes what staff see on the payment terminal, which is auto-H1 and
needs your ruling. Recorded in full on the issue.

## #249 + #248 — one function answering the same question two different ways

**#249's premise is narrower and worse than its title.** It says *"the two guest list queries
disagree"*. It is **one function disagreeing with itself**: inside `fetchGuestActiveTableOrders`,
`countOnly: true` counted `orders` alone while the row path thirty lines below returned
`requestRows + orders` and reported `count: merged.length`. `fetchGuestOrdersBySession` — the
other query — was already correct.

**Not academic.** The landing calls it with `countOnly` and, on a zero, calls
`clearActiveOrderBannerState()`. A customer whose only live item was an unaccepted request had
the one thing telling them about it thrown away.

**They could not be fixed separately.** Making the count include requests without fixing #248
would have carried *that* defect into the count path — and the same landing screen counts
hosted-checkout orders older than ten minutes to decide whether to fire
`/api/orders/expire-pending`, so a stray `waiting_review` request could have triggered it. One
predicate and one query helper, shared by both paths, so they cannot drift apart again.

Two two-sided probes, one per defect, each caught independently: 2 red and 3 red by name.

---

# CONTINUATION SESSION — the close-audit, #257, and four more fixes

Everything below is on `cloudflare-staging` only. `origin/main` and production are untouched at
`3c6eec9`.

## The close-audit — COMPLETE. `docs/close-audit-2026-08-16.md`

Four buckets: **A** shipped and live, **B** fixed on a branch but not live, **C** genuinely open
with the decisive line quoted at `origin/main`, **D** cannot be judged from `main` at all.

**Nothing was added to bucket A in this pass.** Every one of the ~29 mechanical candidates was
verified and none turned out to be already live. That is the honest result and it is worth saying
plainly rather than dressing up: the mechanical grep produced candidates, and reading the file at
the ref killed all of them.

Two corrections are recorded in the audit itself. **#234** — I read
`lib/payments/reconcile-orphan-payments.ts` (the cron, which is fine) and nearly declared it
fixed; the defect is in the *staff* route. **#278** — its commit message says *"carrying the
ownsOrder consolidation"* and `ownsOrder` **is** on main, but `heldSessionIds`, the half the issue
is actually about, exists in no file there. A commit message that is *partly* true is the hardest
kind to audit.

## #257 — SETTLED. Promotion is all that is needed.

Answered empirically rather than by comparing blobs. In a detached worktree at `origin/main`:

    BASELINE  main's own test file            4 failed, 9 passed, 13 total   EXIT 1
    SWAPPED   staging's file (blob 546d50f)   15 passed, 15 total            EXIT 0
              ...against MAIN'S OWN validation.ts

So main's `guestCanAccessOrder` already implements the contract staging's test asserts — the test
was the stale half, not the code. Checked for the base-conditional trap: staging's file imports
only symbols main exports, and does not touch `redactGuestOrderRow`.

`promote/257-guest-orders-validation-test` is cut from `3c6eec9`, one file, **pushed and not
merged**. Merging it takes main's known-failing baseline from 7 suites / 17 tests to 6 / 13 — the
same as staging, so both branches would finally share one baseline.

## #224 — a total menu outage no longer hides behind "No items found"

Merged `d300dc3`. The recorded decision in `menu-body-state.ts` was **not** overruled: the old
assertion (*"a banner is absent for a TOTAL failure — that is the body's job"*) was **rewritten,
not deleted**, because the body's job changed. A companion test asserts the two never both speak.

## #220 — "View Menu" no longer destroys the customer's tab

Merged `134d575`. **The archaeology is the finding.** `handleViewMenu` was born as
`handleOrderSeparately` (`98e98b9`), where `clearTab()` was correct — the customer was declining
to join. `82baa3e` renamed it and carried the call across unchanged, so a button meaning *"let me
look at the menu"* still behaved like one meaning *"I am not joining this tab"*. There is no
recorded decision defending the clear for View Menu; the decision was made for a different button.

Worse than the title says: `clearTab()` reaches `clearTabSession()`, so it wiped the browser's
link to the tab. A joiner who never knew the PIN could not get back at all. And on the
tab-elsewhere card it contradicted the screen's own words — `TAB_ELSEWHERE_COPY.staysOpen(n)`
renders *"Your Table N tab stays open"* seven lines above the button that forgot it.

Clearing survives at the three sites that genuinely END a session, and a test asserts that, so the
fix cannot be "improved" into deleting tab-clearing everywhere.

## #169 — the existence probe that reported absent tables as present

Merged `a716087`. Audit result: **the broken idiom is not currently used as an existence probe
anywhere.** All 57 `head:true, count:'exact'` sites count rows in tables known to exist, which is
correct usage. Nothing to fix — said plainly rather than dressed up as a diff.

What shipped instead is the issue's own third follow-up: `lib/supabase/schema-probe.ts`, which
makes the correct form the path of least resistance and turns *"calibrate against a known-absent
control"* into `calibrateSchemaProbes()` — something you run, not something you remember.

**Three states, not two.** `present:false, absent:false` is a real outcome; reading a permission
error as "absent" is the same instrument lying in the other direction.

**Live control on staging, read-only:**

    control table  ABSENT (fake):  code=PGRST205
    SAME absent table, two forms:
      head:true count:exact -> error=null count=null
      probeTable (no head)  -> code=PGRST205 absent=true

New fact: **the defect reproduces on staging too.** The issue's evidence was production-only.

Recorded but NOT changed: three `restaurant_roles` scripts probe with a loop variable and do
`count ?? 0`, so a missing table would be snapshotted as *a table with zero rows* and the
pre/post comparison would agree. Production/migration tooling, out of scope for this run.

## #206 — customer toasts stop rendering raw server error text

**Ruling taken: default-deny**, recorded because the issue offered it as a suggestion. A denylist
is safe only for the strings someone remembered to ban, and #206 exists because a route can return
`updateError.message` straight from Supabase.

Step 1 of the issue — the enumeration — is done and lives in the census test. 17 customer-written
sentences survive verbatim; everything else becomes the caller's fallback. **No route is touched.**

The probe is the part worth keeping: reverting ONE call site left the 33-test census **green**
and `tsc` at **exit 0**; only the source scan caught it. That is why there are two test files.

A gap in my own first commit, closed by the second: the five tab-route patterns went in with no
positive test, so a typo in any of them would have failed silently — census green, sentence
suppressed, customer shown the generic fallback for a message meant to reach them.

## The A–Q simulation harness was lying, and is fixed

Two defects, found because the harness lied to me:

1. `seedTable` died on `restaurant_tables_..._table_number_key`. A run that aborts before
   `cleanup()` leaves its scratch table behind and the NEXT run dies on it — which is how one run
   lost 18 of its 28 checks to debris from an earlier run that had itself died on a bad `tsx`
   entry point. It now retries on a fresh number and says so. It deliberately does **not** reuse
   the stale row: that would inherit whatever state the aborted run left on it.

2. The summary printed **"10 checked, 0 FAILS"** after aborting at check 11. The exit code and the
   withheld `QR_EVENTS_SIM_DONE` sentinel were always correct — but the line a human reads, and
   the line a background watcher `tail`s, stated a true number in a way that means the opposite of
   how it reads. It now says `ABORTED AFTER n CHECKS ... This is not a pass.`

## Issues I did NOT build, because they turn on a ruling

Filed, not built, per the standing instruction:

- **#179** — widening `parseTableLandingPath` to admit `/table/%205` is new behaviour on the QR
  entry path. The issue already spells out the three questions. Note its "unify the two guards"
  suggestion is now moot: the second guard's page was deleted by #118.
- **#243** — the hosted-pending ordering block has never fired. Making a dormant ordering block
  start firing is a behaviour change, and the issue says so itself.

## #209 — the withdrawn-method toast named cash whatever was withdrawn

The toast hardcoded *"Cash payments are no longer available. Please select Card."* in a branch not
gated on cash. A customer whose **card** was disabled mid-tab was told cash was gone and instructed
to pick card — the method just turned off — then had their preference cleared and was returned to
the selector with that wrong guidance.

**Option A needed no API change.** The issue's rule was *"A if the API returns enough to
distinguish, else B"*. A is free and not from the response: the client already knows what it sent.
`paymentPreference` is the value posted at `:283`.

**A correction to the issue.** It says the same applies to `'other'`. It does not — the route
guards `paymentPreference !== 'other'` (`ready-to-pay/route.ts:80`), so the 403 fires for cash or
card only. The old string was correct for one of **two** triggers, not one of three.

It no longer names a replacement. *"Please select Card"* was a guess this module cannot make
correctly — nothing here knows which remaining methods are enabled — and the handler already calls
`refresh()`, so the selector is the thing that can tell the truth.

Not marked `PENDING COPY`: the marker renders verbatim to customers, #204 Q1 ruled these strings
ship as written, and this is a mechanical parameterisation of them. Putting the marker on a live
payment instruction would be a regression, not caution.

## #267 — `git worktree remove` eats the shared node_modules

**Reproduced first**, because the incident was 2026-08-11 and a git update might have fixed it. It
had not. On `git 2.51.2.windows.1`, against a **throwaway** junction target:

    fake target entries BEFORE: 7
    git worktree remove --force  ->  exit 0, no mention of node_modules
    fake target entries AFTER:  0

`scripts/worktree-teardown.ps1` owns the ordering: drop the junction **link-only**
(`cmd /c rmdir`), then remove, then **re-count the target and fail loudly if it shrank**. That
third step is the only one that catches somebody forgetting, which is the case that will occur.

It ships `-SimulateUnsafeRemoval`, a documented self-test that skips the unlink so anyone can
confirm the hazard on their own git version instead of trusting a docblock — and that is also the
negative half of the probe:

    safe path                target 7 -> 7, worktree gone, exit 0
    -SimulateUnsafeRemoval   git worktree remove exit 0 (silent), target 7 -> 0,
                             script exit 1 with the repair procedure

**A correction to the issue:** it says to document this *"alongside the existing junction
guidance"* in `CONTRIBUTING.md`. There was none — that file was 52 lines about database safety and
said nothing about worktrees. So the practice that creates the hazard was never written down
either, which is worse than the issue assumes. Both halves are there now, including why the
junction must stay: without it `npx tsc --noEmit` runs `tsc@2.0.4` and exits 0 on anything.

## #196 — its one open question, settled for staging

*"Whether any environment ever hands the guest API a non-string order id."* The issue argued item 1
is type-only from the column type, the migration and the TS type — three declarations, none of
which is the wire.

`scripts/probe-196-guest-order-id-type.ts` reads the wire, on **raw text** rather than the parsed
object: `JSON.parse` distinguishes `"id": 7` from `"id": "7"`, but only the bytes show whether the
server **quoted** it, and quoting is the question. Calibrated against a synthetic quoted and
unquoted body first, per #169's rule, and it refuses to report if the controls fail.

    controls: quoted -> string, unquoted -> NON-string
    observed 18 live 200 responses
    non-string ids: 0

Non-vacuous by construction — it exits 1 with `INCONCLUSIVE-AS-FAIL` on zero readable responses,
because "0 non-string ids" out of 0 observations proves nothing.

Settles staging today. Does **not** settle production, and cannot settle *"no environment ever"*.
Nothing depends on the answer: the fix on `fix/four-one-line-defects` is correct either way, and
that branch is still unmerged — not my call.

## On extending the A–Q simulation

The brief asks for new checks covering what was fixed, and that **every new check must be able to
FAIL**. Applying that honestly, **none of this session's five customer-facing fixes is observable
through the API surface the simulation drives**:

- **#220, #224** — render and `localStorage` state on a client path. The simulation makes HTTP
  requests; it cannot see a toast, a banner or a cleared browser key.
- **#206** — reaching those toasts needs a server error a customer can trigger. Manufacturing one
  on staging means breaking a route.
- **#209** — reaching that toast needs a payment method disabled on a live restaurant *while a
  customer holds an open tab mid-settle*. That means mutating `restaurant_settings` on the shared
  staging restaurant, and a crash mid-run would leave it misconfigured for every other agent. The
  trigger is CODE-proven instead (`ready-to-pay/route.ts:80` gates on
  `!allowedMethods.includes(paymentPreference)`), and that is stated rather than dressed up.
- **#267** — not a web path at all.

So no checks were added to the simulation, and it stays at **28**. Two live instruments were built
instead, both of which can fail and both of which calibrate themselves first:
`scripts/calibrate-schema-probes-staging.ts` (#169) and `scripts/probe-196-guest-order-id-type.ts`
(#196). Adding a check that passes without exercising the fix would be worse than adding nothing,
which is the same reasoning that produced `INCONCLUSIVE-AS-FAIL` for #249.

## The simulation harness caught itself

The abort-summary fix shipped earlier in this session then fired for real. A later run hit a
transient `fetch failed` on its first request and printed:

    ABORTED AFTER 0 CHECKS -- 0 FAILS among those; the rest NEVER RAN. This is not a pass.

Under the old wording that run would have read `0 checked, 0 FAILS`. It was re-run and passed
28/28.

## Instruments that lied in THIS session — add to the list

- **A background watcher polled the wrong hostname.** `lentonlosper.workers.dev` does not exist;
  the worker is `llosperofficial.workers.dev`. Every poll returned empty, the loop ran to
  exhaustion, and the wrapper still exited 0. **Always resolve the host from `wrangler.toml` or
  `.env.test`, never from memory.**
- **`node node_modules/.bin/tsx` is a shell script.** Running it under `node` on Windows is a
  syntax error. Use `node node_modules/tsx/dist/cli.mjs`.
- **...and that entry point does not inject `.env.test`.** The `.bin` shim does. Bypassing it
  means `set -a; . ./.env.test; set +a` first, or the script dies claiming the secrets are missing
  when they are simply not loaded.
- **Escape sequences in a heredoc'd Python string collapse before Python sees them.** A backslash-n
  intended as two characters arrived as a real newline and silently broke an `assert ... in s`
  match — the edit then aborted having written nothing, which was the good outcome. Build such
  escapes from `chr(92)` when they must survive, and write long content with an editor instead.

# CLICK TEST 2026-08-16 — three defects a real phone found and 28/28 did not

Table 120, staging, real device. All three are fixed on `cloudflare-staging` only; `origin/main`
and production remain at `3c6eec9`.

Filed as **#291** (swap), **#292** (Tab screen blanking), **#293** (ex-VAT line prices).

## The headline lesson: the harness was not lying, the spec did not ask

**Events A–Q never contained a swap.** So the simulation never drove remove-then-add, and 28/28
stayed green for as long as swapping was completely impossible — including on the run immediately
before the click test. That is a gap in the specification, not a defect in the instrument, and no
amount of re-running would have closed it.

Two of the three were invisible to the simulation for structural reasons, and it is worth being
precise about which:

| | Could A–Q have caught it? |
|---|---|
| **#291** swap | **Yes, and it now does** — `D-swap` drives the real route. The event simply did not exist. |
| **#293** line prices | **Yes, and it now does** — the figure is computed server-side, so `B-money` observes it. |
| **#292** screen blanking | **No.** A React loading state on a client render path. The simulation makes HTTP requests; no check it could contain would fail if this regressed. |

## #291 — swapping an item was impossible

Remove the only line, add another: the panel showed the removal struck through **and** the
addition listed, then refused with *"An order needs at least one item"* and greyed Save out. The
one mutation the section-22 overrule was written to allow was the one that could not be performed.

**Both sides carried the same assumption**, which is the trap: the client counted only `kept`, and
`repriceKeptLines` threw on an empty `keep`. Fixing only the client moves the refusal to a 400 the
customer cannot read.

`lib/orders/edit-emptiness.ts` now owns it — **an edit is empty when kept lines AND pending
additions are both zero** — imported by the Save button, the warning line and the route. Same
shape as `canOpenItemSheet`. `repriceKeptLines` reduces and re-sums; it no longer decides
emptiness, and its test asserting the throw was **rewritten, not deleted**.

Re-acceptance is not special-cased: `D-swap-review` asserts it equals `newPrice > oldPrice`.

**The proof, on the deployed worker, both directions:**

    against 859f3a5 (no fix)   FAILS  D-swap  swap REFUSED 400 "An order needs at least one item"
    against 955c027 (fixed)    PASSES D-swap  "item-1" -> "item-2", 1 line, total 20 at menu price

## #292 — the Tab screen blanked every 5 seconds

**Neither suspected cause.** `useTabSessionEndedRedirect` is imported by browse and cart only and
never by this page, so Table 120's version bump 2→3 was a red herring. And a failing shared-tab
read cannot loop: its catch ends in `window.location.replace('/session-ended')`, a one-way trip
off the screen.

The cause was one boolean serving two states: `load()` set `loading`, the interval called it every
5000 ms, and `showTabLoading` returns a full-screen spinner early. A first load has nothing to
show; a refresh already has data and must replace it in place. `my-orders` never had this.

**A second, worse defect found while fixing it.** The catch evicted on *any* failure, including on
a background poll — and `handleSessionExpired` clears the session token, tab id, table and cart.
One dropped request out of a tick every 5 seconds would have thrown away a working customer's
route back to their own bill, and a joiner who never knew the PIN could not return. Refresh
failures now keep the screen; a first load that cannot read the tab, and a genuinely settled tab,
still evict.

## #293 — line prices were ex-VAT while the total was inclusive

*"Beef Burger x1 — NAD82.61"* above *"NAD95.00 awaiting confirmation"*, with N$95 on the menu.
`toLines` read `item.subtotal`. `total` is the charged amount for **both** tax modes, so reading
`subtotal` was wrong regardless of the rate.

**The field was renamed, not just repointed**, and the rename did the auditing: `tsc` enumerated
the render sites as TS2339 at `tab/page.tsx:456` and `:499` and nowhere else — a compiler
enumerating consumers rather than a grep agreeing with itself. **My Orders is clean**, checked:
it does not import the grouping and shows no per-line price at all.

The existing grouping test passed throughout because its fixture items had `subtotal` and no
`total`, so the two figures coincided.

## Instruments

- **`tsc` is blind to the simulation.** `scripts/simulate-qr-redesign-events-staging.ts` carries
  `@ts-nocheck`. Verified deliberately: appending an identifier defined nowhere still gives
  **exit 0**. A helper first written as `round2` was undefined and would have aborted the run at
  runtime behind a green compile. Never read a `tsc` pass as covering that file.
- **The simulation's own cleanup never deleted `payments`**, and filtered `payment_events` on
  `order_id` when the column is `order_ids` (a uuid ARRAY). PostgREST returns success for both, so
  cleanup reported a clean run while deleting nothing — which is why 20 fixture tables, 19 open
  tabs and 3 probe menu items were sitting in the live staging menu. Fixed.

# FINAL STATE

    origin/main / production      3c6eec9   UNTOUCHED, verified cache-busted at the end of the run
    origin/cloudflare-staging     f833753
    staging DB migration drift    136 local / 136 applied — CLEAN. No piece tonight carries a migration.
    unpushed, all local branches  ZERO (positional form)
    A–Q simulation                26 checks, 0 FAILS against the deployed worker

## FINAL STATE — continuation session, every number re-measured at the end

    origin/main                   3c6eec9605ab5b9ac1887d2d0cefbfbc20338fa0   UNTOUCHED
    production https://flashtap.app/api/version          3c6eec9...  cache-busted
    production https://riviera.flashtap.app/api/version  3c6eec9...  cache-busted
                                  -- identical to origin/main. Nothing reached production.
    origin/cloudflare-staging     859f3a5
    staging deployed              27f0350 at time of check; 859f3a5 was still rolling out
    unpushed, all local branches  ZERO (positional form: rev-list --count <b> --not --remotes=origin)
    working trees i169/i220/qrd-stage/qrd-docs   all clean
    A-Q simulation                28 checks, 0 FAILS, sentinel present, against the deployed worker
    migrations                    NONE. `git diff --name-only f833753 origin/cloudflare-staging`
                                  returns 21 files and not one under supabase/migrations.

**On the drift number.** The earlier session's `136 local / 136 applied` is NOT re-measured here
and should not be read as if it were. What I verified is narrower and sufficient for this run: no
commit in it touches `supabase/migrations`, so it cannot have changed the drift either way.

**A note on the production URL.** I first checked `flashtap.llosperofficial.workers.dev` and got a
404, then resolved the real routes from `wrangler.production.toml` (`flashtap.app`,
`www.flashtap.app`, `riviera.flashtap.app`). Same class of mistake as the staging watcher that
polled a hostname that does not exist. **Resolve every host from config, never from memory** — a
404 is the lucky version of that error; the watcher's version returned empty and looked like a slow
deploy for thirteen minutes.

## Branches from the continuation session, all pushed

    fix/224-outage-banner-during-search          promote/257-guest-orders-validation-test
    fix/220-view-menu-keeps-the-tab              fix/169-calibrated-schema-probe
    fix/206-customer-safe-error                  fix/209-payment-method-withdrawn-copy
    fix/267-worktree-teardown-guard              probe/196-guest-order-id-type
    fix/sim-seed-collision-and-abort-summary

All merged into `cloudflare-staging` except **`promote/257-...`**, which is cut from `3c6eec9` and
is deliberately left for the human — it targets `main`.

Verified rather than assumed: every `fix/*` branch from both sessions was checked with
`git merge-base --is-ancestor <branch> origin/cloudflare-staging`. All 17 returned YES.

## Branches, all pushed

    qrd/1-item-sheet                    qrd/6-full-edit
    qrd/2-my-orders-destination         qrd/7-my-orders-cleanup
    qrd/3-menu-simplification           qrd/9-add-something-picker
    qrd/5-shared-tab                    docs/qr-redesign-2026-08-16
    fix/286-unpaid-tab-flag-figures     fix/173-ready-order-told-preparing
    fix/browse-debug-logging            fix/275-staff-transition-copy
    fix/283-tab-pin-csprng              fix/288-terminal-member-name
    fix/238-audit-records-whose-figure  fix/232-report-unresolved-owes-money
    fix/246-partial-banner-during-search
    fix/249-248-active-table-count-and-filters

## Everything the spec asked for that the domain could NOT truthfully support

1. **Four customer status words (§19).** Six shipped. Four cannot carry `ready_for_terminal`,
   `cancelled`, `declined` or a failed payment, and merging `accepted` into "being prepared" is
   untrue *and* hides the boundary editing closes at. Recorded rather than faked.
2. **A single truthful amount in the tab strip (§9).** There isn't one — payable and pending are
   different questions. The strip shows both rather than picking one, which is what §9 itself
   asks for when a single figure cannot represent the state.
3. **Event O** (scanning a second table while a tab is open) has no API surface of its own; it is
   a landing-screen decision and is your click-test.
4. **#285** cannot be settled without a production write. Recorded as a "should not be done"
   ceiling; nobody should go and get it.

## What I built differently from the spec

| | |
|---|---|
| Pieces 2 and 3 **swapped** | removing the tracker also removes a settlement affordance; landing on My Orders first means order visibility never drops at any point in the sequence |
| Six status words, not four | see above |
| Piece 6 **split**, picker deferred to piece 9 | a cross-screen round trip that must survive navigation; folding it in would have made piece 6 the big-bang commit you warned about |
| Piece 2 moved **only the tab path** to My Orders | the non-tab path's confirmation screen carries the only Ready-to-Pay a tab-less customer has; it moved in piece 8 once settlement was consolidated |
| Inline variant chips left on the menu card | removing them without resolving `isRequiredVariantMissing` would permanently disable every item with a required variant group |
| Model A over the audit's recommended Model B | your ruling. The audit's objection was real, so three of the four sale guards were ported rather than reasoned around; the fourth does not apply to a tab |

## New rulings I took, because none existed and the build could not wait

1. **Mixed-vintage pricing on an edited order** — survivors keep the price stored at placement,
   additions are priced today. The alternative moves the price of items the customer is *keeping*
   and refuses a removal because an untouched survivor went out of stock.
2. **The payment-method allowlist is not ported into the edit path** — an addition to a tab order
   chooses no payment method, so there is nothing to check it against.
3. **The shared-tab lines go behind the session token**, not onto the unauthenticated `view`
   route, even though that route already had the data.
4. **A failed shared-tab read shows a notice, never the session-scoped list** — a fallback there
   would show one diner's food under a whole-table heading exactly when it was broken.
