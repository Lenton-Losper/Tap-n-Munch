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
