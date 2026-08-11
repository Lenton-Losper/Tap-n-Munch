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

---

## CHECKPOINT 5 — the Exploiter role caught a live gap in a fix that was already proved

### #212 — EXPLOITER RESULT: **REACHED**, then closed. `64b1638`.

The agent that wrote and two-sided-proved the rule then **defeated it**, with a fixture written as a
real author would rather than by re-running its own suite:

```sql
DO $$
BEGIN
  IF EXISTS (...) THEN
    ALTER TABLE public.tabs
      ADD COLUMN IF NOT EXISTS settlement_state text NOT NULL DEFAULT 'open'
        CHECK (settlement_state IN ('open','settling','settled'));
  END IF;
END $$;
```

`blankNonCode()` blanked dollar-quoted bodies wholesale — correct, so a function body's semicolons
could not tear the outer statement — and thereby made **every statement inside such a body
invisible**. The scanner called the file clean. Four other fixtures were caught.

**Not theoretical.** FOUR committed migrations already put `ALTER TABLE` inside a dollar body, and
`20260725140000` **is that fixture one edit away** — it adds the column, then guards its CHECK inside
`DO $$ … END $$`, the *correct* idiom, written by someone who understood the problem. Folding that
CHECK back onto the column is a one-line change the scanner would have ignored.

Fixed by recursing into bodies with line-mapping, depth-capped. Two-sided: 4→5 fixtures caught, and
**40 real migrations carrying a dollar body produced zero false positives**. Suite 16→18; the added
test is the negative twin — the correct idiom inside a DO block must still not be flagged, which is
what that file actually ships.

**This is the role working as designed on its first serious run.**

### #226 — the obvious fix would have been a NEW defect

`payment_events.amount` is `NOT NULL` with `CHECK (amount > 0)`, so there is **no absent-amount case**
here — a real difference from the three gateway legs.

But `order_ids` is `uuid[]` and a tab settlement writes **ONE event for the full set**. So
"pass `event.amount` instead of `row.total`" would record **each order paid at the whole tab
amount**. The only correct comparison is `event.amount` against the **SUM** of the covered orders.

And the tolerance: the amount is **terminal-submitted**, so it is a CLIENT leg taking
`PAYMENT_AMOUNT_TOLERANCE_CENTS` (1). Reaching for the gateway constant because the word "reconcile"
appears would be wrong.

### #237 — a LIVE customer-facing money defect on the ORDINARY settle path

`issueReceipt.ts:283` uses `event.amount` verbatim, matched by `.contains('order_ids',[orderId])`.
A three-order settle of N$120 issues **three receipts, each reading Total N$40 against a payment
line of N$120.** Nothing says it is a share.

Found while answering #226; independent of it.

### Filed

**#237** (multi-order settle receipts) · **#238** (`clientAmount` recorded regardless of origin) ·
**#239** (bulk path marks paid with no audit row). One filing hit a GitHub 502 and was retried.

Open issues: 98.

### Caller count — two agents converged independently

`sp-receipt` reached SIX real callers; `sp-stock-pay` reached the same six plus three direct
`payment_status: 'paid'` writes. Both disproved two of my eight the same way (definition; doc
comment). Convergence from opposite directions is the strongest form that count has had.

### Third shell-quoting artifact of the sprint

A bash one-liner mangled escaping and printed "0 migrations with ALTER TABLE in a dollar body". The
true number is 4 — the agent re-ran from a file and corrected its own under-sell. Third time this
sprint a shell quoting artifact produced a confident wrong number. **Goes in the contract.**

### Reassigned in the same turn

`sp-receipt` → size **#237** properly (four renderers, what proration would mean across differing
totals, whether the disagreement is even visible at 32 chars) — enumerate and packet, write no copy;
then support **#234**'s rule-7 enumeration from the receipt side.

---

## CHECKPOINT 6 — the POS control exists, and nothing tests it

### #240 — the sole control protecting POS money deletes clean, and the suite stays green

The retraction held up, and the reframe is better than the original claim. `create-order.ts:69-89`
reprices by default; that IS the anti-tampering control and its own doc comment says so. But:

- **Nothing downstream re-derives.** `issueReceipt.ts:266-271` copies `order.subtotal/tax/total`
  verbatim into the snapshot. `create-document.ts` genuinely does re-derive — but it serves admin
  quotes/invoices and is not on this path (all three importers checked).
- **Zero test files import the terminal orders route**, and the one test naming `create-order`
  **mocks it**.

Measured by breaking it, and the narrowing is the part worth keeping:

| Probe | Result |
|---|---|
| A — trust `params.total` unconditionally | Accept leg fails 2 tests → that branch IS covered |
| **B — replace only the documented bypass** | **43/43 green. Identical to baseline.** |

The agent narrowed from A to B rather than reporting A's failure as the answer. Reverted by blob
identity (`f7f66d3a…`).

### #241 — `/api/terminals/activate` is unauthenticated with a self-asserted device identity

Exchanges an activation code for a 1h access token + refresh token. `deviceId`/`terminalSn` come
from the **request body** and are written unverified; `validateTerminalRecord` never checks
`device_serial` against the token. A token is obtainable with curl, no device.

Filed on **trust-boundary shape, not as an exploit** — and the bounding is why it is credible:
single-use, 1h TTL, and redeeming **burns the real device's code**, so theft is noisy. Practical
exposure is a leaked or observed code.

Two things worth deciding regardless: the code is generated with **`Math.random()`**, and **no
in-repo rate limiting** guards the endpoint.

Also: token `permissions` are hardcoded at signing, so the `orders:update` check is satisfied by
every validly-issued token. Signed, not forgeable — but not a second gate either.

### Resolved: the variant latent state is NOT UI-reachable

Today's editor always emits a `type`, so #228/#229 are reachable only by **direct API write**.
Dated precisely: typed editor `2026-07-02`, normalizer `2026-04-14`, the four real orders
`2026-06-26` — **between** them. Legacy, with the window named. Priority lowered as predicted.

### Answers worth keeping from the POS enumeration

- Client `subtotal`/`total` are **discarded**; `total` is used only as a `> 0` gate.
- Size/addon **names** are matched against the catalog and unmatched ones dropped — no
  client-supplied money is reachable.
- But `priceCatalogLine` spreads `{...item}`, so **money fields are overwritten and LABELS are not**.
  A POS line's printed name is client-supplied text.
- **fdb999a's sub-cent rounding covers BOTH legs** — it sanitises at menu write, and both legs price
  from that catalog. The POS leg is covered.

### Filed

**#240** (POS repricing control untested) · **#241** (activate route trust boundary).
Open issues: **100**.

### Reassigned in the same turn

- `sp-variants` → **write #240's characterization test**. Authorised under the human's own fallback
  clause: *"deepen the coverage: non-mocked tests on paths that only have mocked ones, starting with
  anything money-facing."* Must be two-sided — assert the Accept branch still persists
  `preauthorizedPricing` verbatim, so the test cannot be satisfied by forcing repricing everywhere —
  and must be negative-probed with Probe B's exact substitution to confirm it now fails.
- `sp-receipt` → **#234's rule-7 enumeration from the receipt side**, then back to #237. Both share
  `issueReceipt.ts` and the same question: what does a receipt assert about a payment.

---

## CHECKPOINT 7 — #237 amended down; #234's safest option turns out impossible

### #237 CORRECTED — it is NOT live on the ordinary settle path

The agent retracted its own severity claim, unprompted, against an issue I had already called the
most consequential thing in its handoff. It was right.

```
TableDetailScreen.tsx:293   await settleTab(...)     <- AWAITED, issues receipts
TableDetailScreen.tsx:309   recordSaleEvent(...)     <- fire-and-forget, AFTER
```

So at settle-time issuance **there is no sale event yet**, and `issueReceipt.ts:291-303` takes the
correct fallback branch — the payment line equals that order's own total.

**Real only where issuance happens AFTER the event exists:** `payment-events/sale/route.ts:191`
(reached when settle-time issuance silently failed), and `reconcileOrphanPayments` at `:153`/`:183`,
where it is **deterministic**. Idempotency limits it — only orders with no document are exposed.

**Left as filed, this would have been reproduced on a happy path, failed, and closed
not-reproducible.** Title and body amended.

**#226, #234 and #237 are ONE blast radius.** Neither agent had that alone.

### #234 — option A is IMPOSSIBLE, and that is the finding

| Option | Verdict |
|---|---|
| **A.** backfill `paid_at` to the true payment date | **Not implementable.** That date does not exist: `paid_at` NULL, no payment event, a *successful* reconcile writes no audit row (only the refusal branch does), and `orders` has **no `updated_at`**. Nothing records when a staff reconcile succeeded. |
| **B.** backfill to `now()` | The whole backlog enters the 48h sweep window at once, 100 per tick, each receipt asserting the customer paid **today** — plus #237's unprorated line on every multi-order settle in it. **The option rule 7 exists to prevent.** |
| **C.** fix forward only | Add `paid_at` + `safeIssueReceiptForOrder` at `:237`. Touches no existing row. `payments/reconcile/route.ts` is the ONLY paid-writer with zero `paid_at` occurrences — this brings one outlier onto the existing convention. |

**Issuance notifies nobody** — established independently by two agents from different files. One
INSERT into `receipt_documents`; every consumer is pull-based; `orders` has no `customer_email`
column at all, so a bulk mail-out is not merely gated but impossible.

**What a late receipt gets wrong:** the snapshot is BUILT AT ISSUANCE from current rows, then
frozen. Outlet name, address, VAT and registration number are read **live** — a receipt can gain a
VAT number the sale never had. `document_number` is a **single global sequence across all
restaurants**, allocated at issue, on a table with no update or delete policy.

The closing line worth putting in front of the human: *a batch of back-dated fiscal documents
numbered today is a worse artifact than an acknowledged gap.*

### Two self-limiting notes worth keeping

- `supabase/schema.sql` contains **zero** `CREATE TRIGGER` statements, so it is not authoritative
  about triggers. The `updated_at` absence is strongly evidenced (dump + no migration + no code
  reference) but **not DB-verified**, and the agent said which was which.
- Proration on #237 is **not** a design problem: the settle amount is the sum of the claimed orders'
  totals, so each share IS its own grand_total — already implemented in the fallback branch. The fix
  makes the recovery path agree with the path that works, rather than inventing a presentation.

### Reassigned in the same turn

- `sp-stock-pay` → **#219** (implementable, no ruling needed), falling back to the
  fixed-on-branch-not-live drift audit if it turns out to need one.
- `sp-receipt` → **#224** (third instance of the same false-claim pattern; needs copy, so packet
  only — and the answer may be a fourth state in `menuBodyState` rather than a new branch), falling
  back to **#165's Q4**, the VAT-invoice question that can eliminate an option before the human
  rules.

---

## CHECKPOINT 8 — the injection is proven; #219 shipped; the Exploiter split works

### #242 — `.or()` injection, PROVEN 0 → 213 rows, unauthenticated, cross-tenant

Staging, read-only, zero writes:

```
benign   "NONEXISTENT-REF-ZZZZZZ"                 ->   0 rows
injected "NONEXISTENT-REF-ZZZZZZ,id.not.is.null"  -> 213 rows, 2 restaurants
```

**Reachable by OMITTING the signature, not forging one.** `verifyWebhook` fails closed, but the
route treats *not ok* as **fall back to Finatic** rather than *stop*. No charset validation anywhere
on the path, and the filter carries **no restaurant scope at all**.

Exposure established: order-set widening, and a **200/503 boolean oracle** — "is every order
matching my predicate already paid?", one bit per request, blind enumeration across tenants.

**No forgery path was constructed, and none is claimed.** The same string goes to Finatic, so it
would have to be simultaneously a PostgREST fragment and a reference Finatic recognises. The
residual is stated rather than buried: that rests on Finatic *rejecting* trailing junk, which is
untestable here — **the single assumption holding the severity down.**

**Weaker than by-payment-ref:** a blind oracle, not a dump. That one returned 15 full rows.

**A missed SITE, not a new class.** `paymentRefOrFilter` already exists and emits the byte-identical
string; the sweep was defined by the helper's callers, so it could not see the site that does not
call it. Same shape as #180's fifth gate and #223's sixth.

**The one-line fix needs one external fact first:** the validator is `[A-Za-z0-9-]{1,64}`, but this
value can arrive as Finatic's `out_trade_no`, which we do not issue. If Finatic uses any character
outside that class, sanitising fails closed on a LEGITIMATE webhook and the payment is never applied
— worse than the injection for a real customer.

### #219 — IMPLEMENTED and green, `a61b5bc`

6 named failures before, 13/13 after, with the cross-session scoping guards green on **both** sides.
No new copy needed — `normalizeOrderStatusForDisplay` already maps `accepting` → `waiting_review`.

Blast radius enumerated properly, including what is NOT affected: `countOnly` returns early **before**
the order_requests half, so it cannot reach `abandonedCount`, which fires a WRITE. And my-orders was
the one renderer keying off raw status, falling through to "🎉 New" — surfacing these rows without
fixing that would have labelled a stranded request New.

**Disclosed suppression that matters:** that file carries a pre-existing `@ts-nocheck`, so **tsc did
not verify the renderer half**. Proven by reading, not machine-checked. Said plainly rather than
buried.

### #214 Exploiter — FIXED (ordering) / UNABLE TO REACH (timing)

The agent found its own shipped test and the issue were making **different claims**. A never-resolving
promise models the state and never the transition, so it structurally could not see a FLASH.

Reverted to the genuine base via `git show fdb999a:<path>`, verified by blob both ways: the flash
reproduced — 3 commits on the default path, 4 on the tap path. And the `Beef Burger`/`Coke`
assertions PASSED before the false-claim assertion failed, so the load **completed** and the claim
was **transient**.

Closing line, kept verbatim: *"a green in this file means the false text is never RENDERED during a
slow load. It does NOT mean the human's phone shows a clean first screen."*

### #212 (second implementation) — a check that cannot detect its own blindness

With the parser regressed the gate reports "scanned 127, 0 violations" and would **exit 0 looking
exactly like success**. The baselined offenders turn that into a STALE BASELINE failure instead — so
the baseline doubles as a self-test for the parser. Designed by accident, noticed, and documented so
nobody simplifies it into an ignore-list.

Also: `20260628110000` IS a genuine offender at `:24-26` — clean where I looked, dirty further down.
**Second agent to catch that same wrong brief from me.**

### Filed

**#242** (`.or()` injection) · **#243** (dormant ordering block that can never fire) · **#244**
(sendReceiptEmail has no bound, rate limit or dedup) · **#245** (verify the five inline CHECKs
actually exist — a concrete mechanism by which the contract's own deliberately-unverified constraint
could be genuinely absent).

Open issues: **104**. Fourth shell-quoting artifact of the sprint hit my own filing; switched to
`--body-file`.

---

## CHECKPOINT 9 — an orchestration error of mine, and the two remaining assignments

### I DUPLICATED #212 ACROSS TWO AGENTS. Two independent implementations exist.

`sp-receipt` → `sprint/receipt` @ `652bf2a`, `64b1638`
`sp-browse`  → `sprint/migration-check-lint` @ `3d7ef8d`

Both are complete, both two-sided, both baseline the same five offenders, both wire into the two
workflows. Neither agent knew about the other. **That is my error, not theirs** — I assigned #212 to
`sp-receipt` in its original brief and again to `sp-browse` when reassigning it after the #214
exploiter pass, and I did not check what was already in flight.

**Both found things the other did not**, so the duplication was not pure waste:

- `sp-receipt`'s exploiter pass **reached** its own rule with a DO-block fixture, and its fix
  recurses into dollar-quoted bodies — a gap `sp-browse`'s version may or may not have.
- `sp-browse` found that **a regressed parser reports "scanned 127, 0 violations" and exits 0**, and
  that the baseline is what converts that silent blindness into a stale-baseline failure. It also
  masks comments/strings/`$$` bodies preserving offsets and splits ALTER TABLE actions on
  **top-level commas only**.

**FOR THE HUMAN: pick one, do not merge both.** The two implementations differ in language (`.ts`
via tsx vs `.mjs`), in where the suite is wired, and in parser strategy. My reading is that
`sp-browse`'s is the more defensively built and `sp-receipt`'s has the better-proved parser, and the
right move is to take one wholesale and port the other's DO-block test into it as a fixture rather
than reconcile the two scanners.

### Both #212 versions agree on the five offenders

`20260620150000` · `20260628110000` · `20260629120000` · `20260719110000` · `20260724180000`.
Two independent parsers reaching the same set is the strongest evidence either has.

### Final two assignments of the sprint

- `sp-variants` → **the fixed-on-branch-but-not-live drift audit, BOTH directions.** branch→main and
  main→staging. A previous audit of this shape found **31 issues already fixed and not live**, and
  closing them was most of a session's output with no new code. Deliver a table with a PARTIAL
  column, and treat #129 / #174 / #175 / #186 / #139 as never-closeable — promoting them makes them
  look done, which is why they are on the list.
- `sp-qr-state` → **work the issue list from the newest number downward**, Reality & Proof first on
  every one. Close what is already live at `fdb999a` by reading the file at the ref. Skip #127, any
  migration-dependent issue, any unruled auto-H1, and the four half-fixed. Report how far it got and
  every skip with its reason.

### Sprint state

Production `fdb999a`, untouched. `origin/main` unchanged all sprint. Open issues **104**.
Branches carrying work, none pushed: `sprint/browse-states` (#214 + exploiter),
`sprint/migration-check-lint` (#212), `sprint/receipt` (#212 + exploiter), `sprint/variants`
(#200 + #240), `sprint/qr-state` (#219 + probes), `sprint/stock-pay` (empty — audit only).

---

## CHECKPOINT 10 — #224: two recorded decisions say to do the opposite

### The packet wrote the counter-argument instead of the change. Correctly.

Two deliberate, reasoned comments in the code point the other way:

```
lib/menu/menu-body-state.ts   "While searching, a stale notice must not displace the
                               'no results' wording."   if (notice && !searchQuery) return 'failed'
browse/page.tsx:471-475        "Marking completion rather than success keeps the existing
                               search-with-no-results wording reachable instead of replacing
                               it with a spinner for a load that is not running."
```

**The reframe that dissolves most of it:** not *"should the notice beat the search wording"* but
*"does the already-agreed rule that we never assert what the restaurant sells survive a search box"*.

- tone **partial** — some categories loaded, the customer searched them, nothing matched.
  "No items found" is TRUE of what we have. **The recorded decision is right.**
- tone **total** — nothing loaded, so there is no corpus that was searched. The wording is not
  weaker than the notice, it is FALSE — and the word "stale" in the author's own rationale cannot
  apply to a notice that is the only fact available. **The decision does not reach this case.**

The author's reasoning was held to its own terms rather than to the reviewer's. `searchQuery` is a
parameter of `menuBodyState` with **zero test coverage**, so the decision is pinned by a comment and
nothing else.

### Two findings nobody had written down

- **#246, live on main:** the partial-failure banner is gated on `filteredGroupedEntries.length > 0`,
  so it vanishes exactly when the customer most needs it — searching for something that lives in the
  category that FAILED. They are told it does not exist, with no retry.
- **#247, branch blocker:** all-menu marks COMPLETION, category marks SUCCESS-only, so the same
  situation yields two different wrong screens — and the category path is a **spinner that never
  resolves**. Would have shipped inside #214.

**And "no retry affordance" is worse than filed:** `main:1023` suppresses even the "ask staff"
line when a search is active. Total outage + search = a false claim and **zero affordances**.

### My "fourth state" hypothesis was half wrong

`menuBodyState` already HAS four states. #224 needs three changes at three seams and only one is in
that function. Briefing it my way would have fixed (i) and silently left (ii) — live on main — and
(iii). The correction is worth more than the recommendations.

### `menuBodyState` exists on ONE local branch and NO remote

Checked across all four refs. The contract's "work can exist on no remote at all" case: anyone
briefed to edit that file from a main-cut branch would find no such file.

### Filed

**#246** (partial banner hidden by search) · **#247** (branch-only permanent spinner).
Open issues: **106**.

### Reassigned in the same turn

`sp-receipt` → **#165 Q4** — the Namibian VAT-invoice question, the one that can ELIMINATE an option
rather than add one. If the repo says nothing, say so plainly; that is the answer and it tells the
human they need an outside source. Then **deepen coverage on `issueReceipt.ts`** — money-facing,
mocked-only, and the thing #226/#234/#237 all turn on. Write the assertion that would have caught
#237.

---

## CHECKPOINT 11 — I duplicated #219 too. Second collision, both mine.

### TWO independent implementations of #219 exist

`sp-qr-state` → `sprint/qr-state` @ `a61b5bc`
`sp-stock-pay` → `sprint/stock-pay` @ `1a1b05b`  (~40 minutes later)

Neither agent knew. **Second orchestration collision of the sprint, and like #212 it is mine** — I
reassigned from a stale picture of what was in flight instead of checking.

**FOR THE HUMAN: take `sp-stock-pay`'s (`1a1b05b`).** Both widen the two queries identically; they
differ in where the render hazard is closed:

| | where normalised | reach |
|---|---|---|
| `a61b5bc` | `my-orders/page.tsx` | the one renderer that keys off raw status |
| **`1a1b05b`** | **`mapOrderRequestToGuestRow`** | **all three query paths at their convergence point** |

Not a matter of taste. The mapper's **own docstring** claims it maps a request *"with status set to a
value the UI treats as pre-order ('waiting_review' or 'declined')"* — and `accepting` is neither, so
the function was not keeping its stated contract. `active-order-visibility.ts:38-41` also says in
terms that anything making a status visible must run through the normaliser. `1a1b05b` fixes the
function that was lying about itself; `a61b5bc` fixes the renderer that suffered for it, and does not
protect `OrderStatusBanner` or `order-confirmation`.

### Both found the "🎉 New" hazard independently

`my-orders/page.tsx:81` ends `configs[status] || configs.pending`, and `configs.pending` is
`{ emoji: '🎉', label: 'New' }`. So widening the queries alone would have put a request **still
awaiting staff review** into the customer's list labelled "New" — further along than an accepted
order, and strictly worse than the disappearance #219 is about. The comment above that table records
the identical defect being fixed once already.

Two agents reaching that independently is the strongest evidence it is real.

### Two techniques worth keeping from `1a1b05b`

- **The baseline delta was MEASURED, not asserted.** Stashed only `queries.ts` back to the base blob,
  re-ran, got the identical `4 failed / 2 passed`, popped, confirmed the blob returned and the index
  was empty. The contract *says* `guest-orders-validation` fails on a main-cut branch; this is the
  difference between saying it and knowing it.
- **The failing-first run could not isolate the normalisation** — with the queries unwidened the row
  is absent and the assertions failed on `undefined`, which is evidence of the wrong thing. The agent
  said so, then reverted ONLY the mapper line for a clean 3-failed / 12-passed. Probe-must-be-narrow,
  applied unprompted.

### Filed

**#248** (payment filters applied only to the orders half — and it interacts with #243, which
currently masks it, so fixing #243 alone would UNMASK this) · **#249** (the two list queries disagree
about whether requests count toward `countOnly`, while one of them includes in rows what it excludes
from the count).

Open issues: **108**.

### Reassigned in the same turn

`sp-stock-pay` → **the main→staging half of the drift audit**, with `sp-variants` holding branch→main.
Nine production deploys landed on main today, so that gap is wider than it has been all week. The
question that matters: **would the absence of a fix on staging make a staging test lie about
production?** A suite that passes because staging lacks a fix is worse than a failing one.
