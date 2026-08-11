# Overnight sprint — 2026-08-11, unsupervised

Checkpointed continuously. Assume it was cut off mid-sentence; nothing here waits for the end.

## Ground state at sprint start

- `origin/main` = **fdb999a** = production, verified cache-busted.
- Contract: `docs/agent-operating-contracts` @ **ed99f3c** (revision 2) governs.
- HARD STOPS in force: nothing pushes to main, nothing deploys, no production writes, no
  migrations applied, #127 untouched. Money-facing changes become packets.
- NEW ROLE this sprint: **Exploiter** — an instance independent of the writer must attempt the
  ORIGINAL reproduction against the fixed code before anything is called done. "Unable to reach
  the condition" is NOT "fixed" and is reported as PROOF CEILING blocked.

## What shipped earlier today, for context

Nine production deploys, 21d5133 -> fdb999a. Closed: #202, #195, #204, #192, #194, #177 (refiled
as #216), #190, #197, #201, #146, #191, #205, #210, plus #122's union verified live. Filed:
#211-#216.

## Agents dispatched (all branch-only, none may push)

| Agent | Branch | Work |
|---|---|---|
| `sp-stock-pay` | `sprint/stock-pay` | #146 prevention packet (file the issue), #187 remaining packet, then #199 reachability |
| `sp-qr-state` | `sprint/qr-state` | #211 packet, #215 packet + staging `accepting` count, #189 remaining scope |
| `sp-receipt` | `sprint/receipt` | #165 packet (arithmetic already settled — copy only), #139 answered either way, #212 lint rule (implementable) |
| `sp-variants` | `sprint/variants` | #200's real lead: are the five `required:true` variant-group items ORDERABLE. No pricing changes. |
| `sp-browse` | `sprint/browse-states` | #214 three states — ruled and implementable, copy-free path required |

## Findings as they land

_(appended below as handoffs arrive)_

## Skipped, with reason

- **#127** and anything touching duplicate order numbers — standing hard stop.
- **#129, #174/#175, #186, #139-as-a-fix** — the half-fixed four; promoting them would make them
  look done. #139 is being *investigated* only, which is the explicit instruction.
- Anything needing a migration applied — the drift guard blocks every deploy while a committed
  migration is unrecorded, and applying one is the human's.

---

## CHECKPOINT 1 — `sp-qr-state` returned

### THE FIND OF THE SPRINT SO FAR — filed as #218, and it is a PIN bypass

Found while establishing #211's fix options, not while looking for it. I verified the whole chain
at `fdb999a` before accepting it:

- The landing's open-tab lookup filters `.gte('created_at', cutoffIso)` with a **12-hour** cutoff
  (`v2/page.tsx:426`, `:434`). A tab open longer is invisible to the landing.
- So the landing offers **"Create Tab"**, which hits `idx_tabs_one_open_per_table` and gets 23505.
- `POST /api/tabs`'s 23505 branch (`route.ts:119-196`) recovers by returning the existing open tab
  with a **fresh session token** and `joinedExisting: true`.
- **That branch checks no PIN and no membership.** `grep -ci pin` over the whole branch = **0**.
  `join/route.ts:86-94` does enforce it.

Net: a walk-up scan at a table whose tab has been open >12h joins that tab, sees the previous
party's itemised orders and total, and can add to it.

**This reorders the sprint.** #211's likely fix — make "start fresh at this table" primary — routes
MORE customers through that branch. #218 must be fixed before or with #211.

### Packets ready to rule cold

- **#211** — Q1–Q5. Three mechanisms beyond the filed one: the landing blinds itself to the scanned
  table's own tab (`v2:419-422`); one-open-tab-per-table is a hard DB constraint, which bounds any
  "move the tab" answer before it is asked; and the only working escape (`handleViewMenu`) silently
  discards the tab. **Q4 (movable tabs) is money-adjacent and yours.**
- **#215** — Q1–Q5. Schema blocker confirmed; reap-to-`waiting_review` confirmed safe against
  duplicate orders via a fully traced idempotency chain. **NEW finding: the reaper would introduce
  a price divergence that the stranding currently prevents** — rolling back re-opens the review
  route, and a re-Accept after an edit returns the EXISTING order (first pricing) while the request
  finalizes with the NEW figures. Idempotency is what makes the reap safe against duplicates and
  exactly what makes it unsafe against a re-review.

### Measured

`status='accepting'` on staging: **0**. Whole table 18 rows (10 accepted, 5 waiting_review, 3
declined). No 2026-07-31 script debris present, so nothing needed discounting. Read with its power:
18 lifetime rows and 10 lifetime Accepts is a small denominator — this says stranding has never
happened on staging, not that its rate is low.

### #189 — CLOSED. Premise disproven: nothing was left.

Every decision item discharged on production, including both implementation notes. Note 2 was
discharged rather than assumed — `cart-edit-preserves-line.test.tsx:322-347` asserts the fold is no
longer refused by a difference the edit itself created. 27 tests green.

### Filed from this handoff

**#218** (PIN bypass) · **#219** (stranded request vanishes from the list but not its own page) ·
**#220** ("View Menu" discards an open tab) · **#221** (`flashtap_table` overwritten while the tab
id points elsewhere) · **#222** (staff told to wait for a payment that will never finish).

Open issues: 82.

### Reassigned immediately

`sp-qr-state` → investigate #218 properly (reachability, what the token grants, whether membership
is ever consulted, whether PIN-less venues make it moot), packet it — **do not fix, auth is
auto-H1**. Then reproduce on staging ONLY if a >12h open tab already exists; explicitly forbidden
from back-dating one, since that is a write I have not authorised. Then the production `accepting`
count, read-only.

---

## CHECKPOINT 2 — `sp-stock-pay` and `sp-browse` returned

### #223 — A SIXTH GATEWAY AMOUNT GATE, AND IT CONTRADICTS #187 TWO MINUTES LATER

The most consequential find of the sprint. Verified at `fdb999a` before filing.

```ts
// lib/orders/auto-cancel-stale-pos-orders.ts:165
amount: finaticResult.amount ?? Number(order.total),
```

No comparison. `grep -c payment-integrity` over the module = **0**.

An order refused by #187's amount-mismatch 400 stays `pending`/`pos`. `STALE_POS_TIMEOUT_MS` is
2 minutes, the cron runs `*/2`. The sweeper asks Finatic and marks it **paid + completed**, clears
`cancelled_at`, and **issues a receipt for `orders.total`** — the gateway's disagreeing figure
surviving only in `audit_logs.metadata.amount`.

So the outcome #187 *proposed* already happens automatically, unruled, with less verification than
#187 asked for — and it is the outcome explicitly declined at
`handle-terminal-payment-failed.ts:179-207`.

**Why five sweeps missed it, and the method that finds it.** #180's sweep was defined by
`amountsMatch` call sites; #197's five-gate table enumerated call sites too. **A symbol grep cannot
find a missing check.** The query that works is `grep -rn markOrderPaidConfirmed lib app` — and at
`fdb999a` that returns **EIGHT** files. Three have never appeared in any enumeration: the PayCloud
webhook (an unauthenticated external caller), `e04111-recovery.ts`, and `reconcile-orphan-payments`.

`sp-stock-pay` is now auditing all eight **by writer rather than by comparator**.

### #217 — the #146 prevention packet, with my brief corrected twice

- `saveAdjustmentAction` **has no caller** and has written **zero rows all time** — orphaned
  deliberately by `844118e` (63 insertions, 0 deletions: the safe action was added beside the old
  one). My "the one remaining unguarded writer a human can trigger" was wrong in its load-bearing
  clause, and #159's write-path table carries the same slip.
- `saveStockCountAction` is **not** unconditionally safe: it writes a DELTA
  (`actualCount - currentStock`), so a sale landing between the read and the insert lands it
  negative. It avoids negatives only by construction.

Reframed: the manual-adjustment refuse-vs-confirm question is moot — nobody can make one. The sale
path is what drives balances negative, and it has three holes, none touched by a manual guard.

### #199 — premise closed, nothing to do

Used by exactly one importer, load-bearing (`expect(LONG_NOTE.length).toBe(MAX_INSTRUCTIONS_LENGTH)`),
and #199's own closing sentence is a recorded decision to KEEP it until #129 lands. The brief reached
the agent as a deletion candidate because the issue's first sentence was read without its second.

### #214 — implemented, best-proved commit of the sprint

`706fcb6` on `sprint/browse-states`. My brief named ONE unguarded effect; there are **two**, and the
one I missed (`loadAllMenuItems`) is the DEFAULT path — `categoryFilter` initialises to `'all'`, so
the flash the human saw came from the effect not in the brief.

Two-sided with controls green on both sides, negative probe verified landed by blob hash
(`b181822 -> fe73454`), restored by blob identity. **A probe that did not fire was reported as such**
rather than counted: deleting the `loadedOnce` gate left everything green, the agent said so, wrote
the test for the frame it actually defends, found it unobservable in jsdom, and DELETED it rather
than ship a test failing for the wrong reason.

Audit: no sibling collapse. v2 and kiosk render no menu list. Notably `v2/page.tsx:96-99` already
carries this exact fix pattern for its own race, with the reasoning written out — and browse never
got it.

### Filed from this checkpoint

**#223** (sixth gate) · **#224** (search-during-outage false claim) · **#225** (no request
cancellation) · **#226** (`reconcileOrphanPayments` at order.total).

Open issues: 86.

### Reassigned in the same turn

- `sp-stock-pay` → audit all eight `markOrderPaidConfirmed` writers, by writer not comparator.
  Fix nothing; payments are auto-H1.
- `sp-browse` → **Exploiter on its own #214 fix**: reconstruct the ORIGINAL reproduction from the
  issue text, not from its own test, and report FIXED or UNABLE TO REACH. Then #212's lint rule.

---

## CHECKPOINT 3 — `sp-variants` and `sp-receipt` returned. Both corrected my brief.

### #200 — premise disproven for the SECOND time. Answered definitively.

The five items **ARE orderable**, and a QR customer **cannot** produce an empty selection. The
brief's second half was false in the direction that matters.

- All five required groups are DROPPED before render: they carry no `type`, and
  `browse/page.tsx:280,282` returns null for any such group. What customers see is the LEGACY
  `menu_items.variants` column via the fallback at `:315-325`, which synthesises its own required
  Size group and preselects the first option.
- The "empty selections" were never QR. Production splits cleanly:
  `KEY-ABSENT / channel=pos: 11` · `KEY-PRESENT-BUT-EMPTY: 0` · `SELECTED / channel=table: 4`.
  `cart/page.tsx:293,376` always send the key, so `{}` is the QR floor — absent is a shape QR
  provably cannot emit.

**The real finding, unasked for:** `required: true` **enforces nothing at any layer**.
`browse/page.tsx:364-369` is the only enforcement anywhere and it iterates groups normalisation has
already dropped; server-side `calculate-order-pricing.ts:162` never selects `variant_groups` at all.
Latent only because the legacy column happens to be populated on all five.

### #139 — ANSWERED. #104 does NOT cover it, and #104 said so itself.

`254c4b0`'s own message: *"THAT RE-DERIVATION IS WHAT #139 EXISTS TO CONSOLIDATE."* A recorded
decision by the person who shipped it.

- Web half: substantially done, ONE residual (`get-report-data.ts:166-168`).
- **Terminal half: entirely undone.** #104 touched ZERO terminal files. `TablesScreen.tsx:30` still
  filters `payment_status !== 'paid'` while its sibling `TableDetailScreen` was fixed — same app.
  A table card can render "NAD 0.00", "1 unpaid order" and "Ready to Close" at once.

Left open, re-scope proposed. This is exactly why it was on the do-not-promote list.

### #212 — IMPLEMENTED, and MY BRIEF WAS WRONG

I told the agent `20260628110000` must NOT be flagged. It uses the correct idiom three times and
then commits the slip anyway at `:24-26`. Following my brief would have produced **the false clean
sheet #212 exists to prevent, from the negative side.** The agent implemented the correct rule and
flagged the brief. Fourth wrong brief of mine in two days.

Two parse bugs found in the agent's own tool, both returning a **plausible wrong answer** rather
than an error: blanking quoted identifiers made it report a TYPE as the column name (and the column
name is the baseline key), and a hand-built `file://${argv[1]}` guard never matches on Windows — so
the first run **exited 0 having scanned nothing**. A green CI step checking nothing at all.

Five pre-existing hits baselined rather than fixed; the ratchet also fails if a baseline entry stops
matching.

### #165 — the most complete packet of the sprint

FOUR renderers, not two — HTML and PDF read the same snapshot and show it too, and the PDF labels
the two bases as `Unit Price | Total`, which reads worse than the unlabelled thermal version.

**The useful half:** `htmlRenderer`'s PRINT layout ALREADY implements options C and D — labelled
"Subtotal (excl. VAT)" and suppressing the unit price at qty 1. Someone hit this before and chose.
That reframes the decision from inventing a presentation to adopting one already made.

Also: the inc-VAT line total is **already stored** on `orders.items` as `total`; `toLineItem` simply
never reads it. So the snapshot seam is a one-field change and the renderer seam is four files plus
a recomputation.

### Filed from this checkpoint

**#227** (POS orders stored at client totals, no server repricing) · **#228** (`required:true`
enforces nothing) · **#229** (browse drops typeless variant groups; option sets disagree) ·
**#230** (terminal TablesScreen counts cancelled as unpaid) · **#231** (terminal paymentIntegrity
mirror) · **#232** (get-report-data). Plus the #139 answer as a comment.

Open issues: 90.

### Reassigned in the same turn

- `sp-receipt` → **Exploiter on #212** (fresh fixture, never seen by its own suite), then the depth
  read on #226.
- `sp-variants` → **#227**, its own issue 3, which is bigger than it flagged: what a terminal token
  grants, whether a modified client could submit an arbitrary total, and whether fdb999a's sub-cent
  rounding applies on that leg. Investigate only.

---

## CHECKPOINT 4 — a false issue I filed, retracted; and #218 is much worse than filed

### I FILED #227 ON A FALSE PREMISE. Closed.

"POS terminal orders stored at client-supplied totals with no server repricing" — **false**. The
route file never calls `calculateOrderPricing`, which is what was seen. But it calls `createOrder`,
and `create-order.ts:69-89` reprices **by default**; the terminal route does not pass
`preauthorizedPricing` (`grep -c` = 0), so client totals are never stored. Verified before closing.

The control is **recorded in writing** at `create-order.ts:24-32`: *"for that path the recompute is
the anti-tampering control and must not be bypassed."*

**The error's shape:** scoping a claim by what a file TOUCHES instead of what it CALLS — the same
mistake that produced #200 twice, and the exact rule the contract's blast-radius section states.
The agent that filed it found and retracted it on its own initiative, before anyone acted.

What survives is smaller and also already ruled: `validateOrderQuantities` runs only on the QR leg,
and `quantity-limits.ts:12-15` records the POS exemption as deliberate.

### #218 — THERE IS NO GATE, AND THE REQUEST WRITES TO THE VICTIM'S TAB

Three corrections, all accepted and applied to the issue:

1. **My text overstated the exposure.** "Sees the previous party's orders and total" is already true
   for any anon client — RLS permits anon SELECT on open tabs with **no restaurant scope**. The
   exposure is the **ACTING**, not the reading.
2. **`POST /api/tabs` has no authentication of any kind.** The route's entire gate list is printed
   on the QR code. The 12h window is not a gate — it only decides whether the UI walks someone in
   by accident. Reachable by one unauthenticated request against ANY table with an open tab, at ANY
   age.
3. **The request WRITES to the victim's tab.** `issueTokenForOpenTab` raises `tabs.session_version`
   to the table's current version — the exact mechanism staff use to invalidate sessions. So an
   unauthenticated POST **re-arms a killed tab and mints a fresh valid token**. Filed as **#235**.

What the token grants: add charges to the victim's tab · flip it to `ready_to_pay` (locking every
legitimate member out with 409 `TAB_PAYMENT_IN_PROGRESS`) · enumerate its orders · itemise them via
the pre-existing table-number-match hole. NOT settlement.

Membership is never consulted or written — asymmetric with the join route.

### Two things I refused, and why they stay unmeasured

- **The staging repro is NOT zero-write.** I authorised it believing it was. It writes a
  `customer_sessions` row and updates `tabs.session_version` — re-arming a tab, which is the defect
  itself. Withdrawn.
- **The production script was denied by the permission classifier**, and the agent asked me to run
  it instead. **I did not.** Running a peer's denied command on their behalf is permission
  laundering. The script is committed and guarded; it needs the human. So production's `accepting`
  count, PIN policy and stale-tab population all remain unmeasured — reported, not guessed.

### The paid-writer audit: TEN sites, not eight

Two of my eight were false positives (`mark-order-paid-confirmed` is the definition;
`e04111-recovery`'s only hit is **inside a doc comment**). Three more were missed by the writer grep
— direct `payment_status: 'paid'` writes bypassing the shared function, its audit shape, its receipt
call and its `paid_at`.

**The honest query is both**: the six importers PLUS `grep -rn "payment_status: 'paid'" app lib`.
The agent improved on the comparator grep and then found its own improvement insufficient.

Four of the six callers write `orders.total` rather than the gateway figure. For three that is
correct — agreement was established first. For the rest it is written *instead of* checking.

### Filed from this checkpoint

**#233** (PayCloud webhook, seventh gate — the only unauthenticated external writer) · **#234**
(staff reconcile: no `paid_at`, no receipt, and the sweep structurally cannot see them) · **#235**
(session re-arm undoes the staff kill switch) · **#236** (`pin_required` true with `tab_pin` NULL
fails open). **#227 closed as my error.**

Open issues: 95.

### Reassigned in the same turn

- `sp-stock-pay` → **#234's rule-7 enumeration**, without a database: what the sweep does when it
  sees these orders, whether a customer gets an email for a weeks-old meal, whether an old receipt
  would even render correctly, and what the safe shape of the fix is.
- `sp-qr-state` → the `.or()` interpolation write-up (two agents found it independently from
  opposite directions), then **#219**, which is implementable without a ruling.
