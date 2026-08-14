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

---
---

# MORNING REPORT

Written mid-sprint and updated as things land, so it survives an unannounced stop.

**Production is `fdb999a` and was never touched. `origin/main` unchanged all sprint. Nothing deployed. No migration applied. No production write. #127 untouched.**

Open issues **108**, up from 82 at sprint start. That number going UP is the result — almost nothing was broken tonight; a great deal was found.

---

## 1. READY TO TEST — what to click, and where

Everything is on a local branch. **None is pushed**, so nothing can reach production until you say so.

| Branch | Commit | What | How to check it |
|---|---|---|---|
| `sprint/stock-pay` | `1a1b05b` | **#219** — a stranded request no longer vanishes from the customer's order list | Hard to reach by hand (needs a stuck `accepting` row). Verified by 15 tests; the render half is read-only-verified. **Take this one, not `a61b5bc`** — see §4. |
| `sprint/browse-states` | `706fcb6`, `909967e` | **#214** — browse no longer says "Menu coming soon!" while the menu is loading | **Scan a QR code on a real phone, on mobile data, cold cache, and watch the first screen.** That is the one check no test can make and it is the check that produced the issue. |
| `sprint/variants` | `6896c88`, `ae7b970`, `fdab54a` | **#200** evidence + **#240** — pins the POS repricing control that had no test | Nothing to click. Test-only. |
| `sprint/migration-check-lint` | `3d7ef8d` | **#212** — CI lint for inline CHECK on `ADD COLUMN IF NOT EXISTS` | Nothing to click. **Blocks a deploy if a new migration carries the pattern** — that is the intended teeth. |
| `sprint/receipt` | `652bf2a`, `64b1638` | **#212 again** — a second, independent implementation | Pick ONE. See §4. |
| `sprint/qr-state` | `ae68bad`, `44554ce`, `840f62f`, `a61b5bc` | read-only probes + the duplicate #219 | Probe scripts are inert. |

**The only real click-test is #214 on a phone.** Everything else is proved by test or is evidence.

---

## 2. NEEDS A RULING

Ordered by what it costs to leave alone.

### Money, live, unruled

- **#223 / #233 — a sixth and seventh gateway amount gate.** The stale-POS cron and the PayCloud webhook both mark orders paid with **no amount comparison at all**, and the webhook is the only **unauthenticated external** writer in the set. An order refused by #187's 400 is marked paid two minutes later by the cron and issued a receipt for the order total. **Rule these together with #187** — three sites answer the same question three different ways today, and fixing them piecemeal recreates the split #180 removed.
- **#234 — staff reconcile marks paid without `paid_at`,** so the receipt sweep structurally cannot see those orders. The safest-looking fix (backfill the true payment date) is **impossible**: that timestamp is recorded nowhere. Options are fix-forward-only, or backfill to `now()` and have every receipt assert the customer paid today. Recommendation: fix forward, then measure the backlog, then decide about it separately.
- **#237 — a receipt issued late shows the whole settle amount as its payment line.** Not the ordinary path (I over-filed that and it is corrected on the issue) — it fires on recovery and backfill paths, which is exactly the population #234 would enlarge.
- **#165 — receipt VAT presentation.** The arithmetic is settled and correct. This is purely copy. The useful finding: **the HTML print layout already implements two of the four options**, so the decision is adopting a choice already made rather than inventing one. One question can eliminate options before you rule — whether a Namibian VAT invoice must show the ex-VAT line amount. Being checked now.

### Auth and access, live, unruled

- **#218 — `POST /api/tabs` has NO authentication of any kind**, and its 23505 branch hands over an existing tab's session with no PIN and no membership check. The 12-hour window is not a gate; it only decides whether the UI walks a customer in by accident. The token grants **adding charges to someone else's tab** and **flipping it to `ready_to_pay`**, which locks every legitimate member out mid-meal. **And the request writes to the victim's tab** — it re-arms a tab staff had deliberately killed (#235).
- **#242 — `.or()` injection from an unauthenticated webhook body.** Measured 0 → 213 rows across 2 restaurants on staging. No forgery path was constructed and none is claimed; the residual assumption holding severity down is that Finatic rejects trailing junk, and that is untestable from here. **The one-line fix needs one external fact first:** what characters Finatic can put in `out_trade_no`, because sanitising with our own validator could fail closed on a legitimate webhook and never apply a real payment.
- **#241 — `/api/terminals/activate` is unauthenticated with a self-asserted device identity.** Filed on shape, not as an exploit — it is single-use, 1-hour TTL, and redeeming burns the real device's code, so theft is noisy. Two things worth ruling regardless: the code uses `Math.random()`, and nothing in-repo rate-limits the endpoint.

### Smaller, still yours

- **#217** — the #146 prevention half. The refuse-vs-confirm question is **moot**: that path has no caller and has written zero rows all time. The sale path is where balances go negative.
- **#211 / #215** — Q1–Q5 each, both with money-adjacent questions. #215's reaper is blocked on a schema addition, and the reaper would **introduce** a price divergence the stranding currently prevents.
- **#224** — two recorded decisions say to do the opposite of what the issue asks. The counter-argument is written; the split is by failure tone.
- **#210** — `declined_reason` is written by one line and read by nothing. Build the staff surface, or relabel it an internal note.

---

## 3. COULDN'T DO, AND WHY

- **Every production measurement.** An agent was denied by the permission classifier and asked me to run its script instead. **I refused** — running a peer's denied command is permission laundering. So these stay unmeasured and are *not* guessed at: the `accepting` count, production PIN policy, stale-tab population, the #234 backlog size, how often the un-checked cron legs fire, and whether the five inline CHECK constraints actually exist (#245). Every one is a read-only query and the guarded scripts are committed and ready.
- **The #218 staging reproduction.** I authorised it believing it was zero-write. It is not — it writes a session row and **re-arms the victim tab**, which is the defect itself. Withdrawn.
- **End-to-end POS submission** and the webhook injection end-to-end. The first needs a staging write I did not authorise; the second **should not be done** — on staging the `__stagingFinaticStub` path is live, so an unsigned probe is one field away from mass-marking orders paid.
- **#214 on a real phone.** jsdom has no paint and no network. The Exploiter reached the ordering half and reported the timing half as **unreachable**, not fixed.
- **Finatic's tolerance of malformed references,** and its `out_trade_no` charset. Both need the vendor, not the repo.

---

## 4. TWO DUPLICATIONS — BOTH MY ERROR

I assigned **#212** and **#219** to two agents each, from a stale picture of what was in flight.

- **#212** — `sprint/migration-check-lint` `3d7ef8d` vs `sprint/receipt` `652bf2a`+`64b1638`. **Take one wholesale**, do not merge. They differ in language, wiring and parser strategy. Suggestion: take `3d7ef8d` (better defended — its baseline doubles as a self-test, because a regressed parser would otherwise report "0 violations" and exit 0) and port the other's DO-block case in as a fixture.
- **#219** — `1a1b05b` vs `a61b5bc`. **Take `1a1b05b`**: it normalises at the convergence point rather than in one renderer, and the function it fixes had a docstring claiming behaviour it did not have.

Not pure waste — each pair found something the other did not, and two independent parsers agreeing on the same five migration offenders is the strongest evidence either has. But it was waste I caused.

---

## 5. WHAT THE SPRINT ACTUALLY PRODUCED

**Three premises disproven**, each of which would have become a fix for a problem that does not exist:
- **#227** — I filed it. The POS leg IS repriced; the control is documented in writing. Closed.
- **#200** — the items are orderable, and no QR line can carry an empty selection. The 11 empty lines are POS, a shape the QR cart cannot emit.
- **#199** — not a deletion. Its own second sentence names its consumer, and its closing line is a decision to keep it.

**Four of my briefs were wrong** and agents corrected each rather than implementing them — twice on the same #212 negative control, once on #214's unguarded effect (I named one; there are two, and the one I missed is the default path), once on #146's "only unguarded writer" (it has no caller and has never written a row).

**The Exploiter role earned its place on its first serious run:** the agent that wrote #212's rule, proved it two-sided and shipped it then **defeated it** with a DO-block fixture — and four committed migrations already use that shape.

---

## CHECKPOINT 12 — #200's mechanism is LIVE; two more fixes landed

### #200 — the server pricer has NO CONCEPT OF VARIANTS. Live on production.

`grep -rin "variant" lib/orders/` returns **zero hits** at `fdb999a`.
`calculate-order-pricing.ts:162` selects `id, base_price, sizes, addons, tax_rate_id, status`.

The client resolves variants; **the server never does.** A variant line is priced from bare
`base_price` and the modifier is dropped. Customer shown N$60, charged N$45.

**The framing that matters, and the issue does not carry it:** the mechanism is LIVE and the
historical loss is **ZERO** — those are different facts. It was measured at zero of 2,604 orders.
So neither "it is leaking money" nor "it measured zero, close it" is right. The next variant order
undercharges.

Open: does the POS path share it? It also calls `createOrder`. Being traced now rather than
inferred.

### #203 — PARTLY DISPROVEN. Two of four gaps have closed.

Measured at current refs, not from commit messages: the signature redaction and the global-merchant
refusal are both now present on staging. The headline "four missing, three security or money" is now
**one security gap plus one correctness gap**.

**The convergence is the sharp part:** staging runs BOTH the injectable `paymentRefOrFilter` AND the
injectable webhook resolver (#242). So **anything about order enumeration verified on staging is
verified against code production does not run — in the unsafe direction.** Amended, not closed.

### #165 Q4 — no legal requirement in the repo, but the repo is not silent on the QUESTION

Zero legal citations anywhere; every "Namibia" hit is marketing copy or a timezone. **The human
needs an outside source.**

**But this codebase already ships #165 option 1, on the document literally labelled TAX INVOICE** —
gross line total against gross unit price, ex-VAT only in the totals block, same tax helper, same
column headings. And the receipt PDF's own comment says it was modelled on that generator: it copied
the layout, palette and headings and **not** the line-total basis.

So **"leave the receipt as it is" is not a no-change option** — it is a decision to keep a tax
invoice and a receipt disagreeing about the same sale. Added as **Q5**.

Also prices option C properly: the invoice keeps both bases per line, the receipt snapshot keeps one,
so labelling the column is impossible for already-issued documents.

### Fixes landed

- **#207** `1eb4503` — `useSyncExternalStore`, removing the mount-effect drop as a CLASS rather than
  an instance. 30 consumers, tsc clean across all.
- **#225** `a14ba67` — request cancellation on both menu effects. **Stacks on `sprint/browse-states`
  and must integrate after it.**
- **`d46f90e`** — first coverage ever on `issueReceiptForOrder`. The load-bearing test is the one
  nobody would think to write: *no sale event yet → payment line synthesized from grand_total*, the
  branch that keeps #237 off the ordinary settle path.

### Three techniques earned this round

- **A NULL PROBE, REPORTED AS ONE.** Removing the finally-guard changed nothing; the agent said so
  rather than dropping the probe — then found it had written a comment claiming "this one matters",
  and **corrected its own false comment.** Guard kept, now labelled as untested.
- **A probe that silently did nothing, caught by hashing.** Fourth instance this sprint. The rule is
  earning its place: quote a before/after blob hash or the probe is not evidence.
- **The `test.failing` trap** — it passes whenever its body throws, INCLUDING when the harness breaks
  and the function never runs. `Tests: 0 total` in another costume. The fix is a control on the
  identical fixture asserting the function ran to completion while deliberately NOT asserting the
  value under test. **New, and going in the contract.**

### #214 did NOT introduce #225 — measured, not asserted

Identical suite against genuinely reverted pre-#214 content: same 3 failures by name, same 3
controls green. I would have accepted the assertion.

---

## CHECKPOINT 13 — #244 converted from a risk into a constraint

### Auto-delivery is UNBUILT, not half-built. Four negatives, each checked.

1. **No markers** — zero TODO/FIXME/"Phase 3"/"not yet" in `lib/receipts` or any receipt route.
2. **No address to send to** — every `email` column in every migration is staff/admin. Even
   `platform_admins.email` was disposed of by name rather than left as an unexamined candidate.
   **No customer address is reachable from an order.**
3. **No consumer** — the three cron routes on disk and the three wired in the worker are the same
   list. Nothing scans for undelivered receipts.
4. **The one "Phase 3 prep" migration is fully consumed** — spent, not pending.

**So the safety of #234's backfill is STRUCTURAL and cannot erode by accident.** Reaching auto
delivery takes three separate additions that do not exist.

### THE TRIPWIRE — posted on #244

**The day a `customer_email` column lands, #244 stops being latent.** That single change flips it,
because `sendReceiptEmail` has no date bound, no rate limit and no dedup. **The guard belongs in the
same change as that column, not after it.**

### Two dormant seams — the honest qualification

`receipt_deliveries.status` admits **`pending`** and **nothing ever writes it** — inserts are only
`sent` or `failed`, with `requested_at` and `completed_at` at the same instant, a synchronous record
of a send that already happened. A `pending` row is the shape an async model would use, and
`receipt_deliveries_status_idx` **already exists to scan for it.** That index and that enum member
are exactly where a future worker would attach.

Found as a status VALUE rather than a column — which is why my phrasing ("a column in a migration
that is not yet used") would have missed it.

### Filed verbatim from agent-supplied final text

**#250** — sale receipt and tax invoice disagree about the line-item VAT basis. The TAX INVOICE
shows gross, the receipt shows ex-VAT, same tax helper and same column headings, and the receipt PDF
says in its own comment that it was modelled on that generator. **Nothing records a decision to
differ.**

**#251** — `ReceiptLineItem` stores ONE VAT basis, so an issued receipt cannot be re-presented. This
**prices two of #165's three options**: labelling the column cannot be applied retroactively at all,
because the other number is not in the document. The underlying data is not lost —
`calculate-order-pricing.ts:124` already stores the gross line figure on `orders.items` and
`toLineItem` never reads it — so widening for FUTURE receipts is cheap.

Open issues: **110**.

### Reassigned

`sp-receipt` → **close its own ceiling gap**: the enumeration is `fdb999a`-only, and it knows local
branches hold unpushed work (it found `menuBodyState` on one local branch and no remote). Sweeping
~30 refs for `sendReceiptEmail` / `customer_email` / delivery machinery establishes #244's
constraint **repo-wide rather than at one ref**, which is the version worth recording.

---

## CHECKPOINT 14 — the drift audit, and TWO corrections to your standing assumptions

### CORRECTION 1: #174/#175 ARE FULLY LIVE. They can come off the do-not-promote list.

Checked because I named them, and reported as a measurement over received wisdom:
`21d5133` IS an ancestor of `origin/main`; `lib/tables/table-number-conflict.ts` is **identical**
across refs and carries #175's rationale in its header; the migration is on main;
`components/qr-code-management.tsx` is **identical** and renders the number at `:208-209`; and
**both** #175 tests are present on main.

**The "index shipped, sibling UI did not" split was real once and has since closed.** Not closed by
the agent — that is yours — but the pair is no longer a promotion hazard.

### CORRECTION 2: the `dd3d9eb` trap cited in the CONTRACT has expired

The contract warns that commit would plant a false statement on main — its text asserts
`lib/tabs/settle-tab-state.ts` exists, true on staging and false on main. **That premise is now TRUE
on main**; the file is present at both refs. Still not on main, but the stated reason not to promote
it no longer holds. **Worth correcting in the contract, since it is cited there as a live example.**

### #129 IS PARTIAL, and it is the exact hazard the list exists for — #253

`lib/orders/instruction-limits.ts` is **byte-identical** on both refs, so a file-presence audit
scores it done. At main its only importer is a **test** — zero production call sites, exactly as
`d57c659` says. The fix is three input caps plus the staff truncation, **all staging-only**.
**The constant travelled; the fix did not.**

### #252 — staging is 39 commits behind main, and the gap is THE PAYMENT STACK

Every #195 commit, #187, #190/#197, #191, #189, #205, #146, #106, #165, #122's union, and
`fdb999a`'s sub-cent rounding.

**Staging is the reproduction environment.** A payment bug reproduced there today is reproduced
against an older stack than production. Compounds #203/#242 — staging also runs both injectable
paths, so order-enumeration findings verified there are verified against code production does not
run, in the unsafe direction.

**Do not reconcile blindly:** `a6bb436 revert(#193)` is a deliberate divergence.

### METHOD FINDING worth more than the table

**`git log main..branch` reports 268 commits "not on main". Patch-equivalence reports 12.** The gap
is entirely cherry-pick originals whose copies are already live under different SHAs — and **four of
the twelve are already live under a different SHA**, which a name-based audit would have proposed
re-promoting into production.

Any audit of this repo must use `git cherry` / `patch-id`, never reachability.

### #200 — "QR only" is TRUE, and the undercharge is FULLY SILENT

My inference that the POS shares it was reasonable and **wrong**. The pricer is channel-agnostic, but
**the terminal cannot express a variant**: `POSOrderItem` has no variant field, `mapMenuItem` never
reads `variant_groups`, and `POSSaleScreen` contains "variant" zero times. It can print one the QR
flow created; it cannot sell one.

**And nothing logs the shortfall.** The size-mismatch warning never fires, because the selection
travels in `selected_variants` and `extractSizeName` reads only the size fields — so nothing fails to
match. `POST /api/orders` then prices and inserts without comparing the client total. **No warning,
no log, no record.** That is why zero-of-2,604 was only findable by measuring menu data.

Plus a trap: the undercharge happens at `POST /api/orders`, not `accept/route.ts` — **anyone hunting
it in the obvious place finds correct-looking code.**

### #209 Q1 REVISED B → A

The issue's own framing of option A is wrong in our favour: the 403 body **already names** the
refused method, and the client already holds `paymentPreference` in its own state. **No API change,
arguably no new string.** Also the branch fires for **cash and card only** — `'other'` is excluded at
`:80` — so it is correct for one of **two** triggers, not three.

### Filed

**#252** (staging 39 behind) · **#253** (#129 partial). Open: **112**.

### SCOPE STATED PLAINLY: ~42 refs unaudited

59 refs are ahead of main; 33 have tips dated 2026-07-30 or earlier. Ten dated 2026-08-04+ are the
ones to audit next. **Deprioritised by age — disclosed as a judgement call, not hidden.**

---

## CHECKPOINT 15 — main→staging drift. A wrong explanation of mine, corrected and verified.

### CORRECTION: the #122 "staging has an auth fix main lacks" story is WRONG. I propagated it.

I verified before recording. `guestCanAccessOrder` is **byte-identical at both refs** — same content
hash `18ce303910cccb41059c23a3570a135c6342f9dd`. The diff between the two `validation.ts` files
begins *after* that function.

- **Code: main is AHEAD.** `isWellFormedPaymentRef` + fail-closed `paymentRefOrFilter`. Staging
  returns bare `string`, no validation.
- **Test: main is BEHIND.** Its four cases call `guestCanAccessOrder` with `{}` — no `restaurantId`
  — asserting the contract that existed before `f4f9111` made restaurant binding mandatory.

So the 4-test delta is **a stale test on main, not a missing code fix**, and my version inverted
which branch is behind on a security-relevant file. The agent had it wrong too, corrected itself,
then flagged it again when my re-send showed the wrong version still circulating. Filed as **#257**:
four standing reds on a multi-tenant isolation function are exactly the noise a real regression hides
in — and every agent is told to ignore them.

### THE ANSWER TO "would a staging test lie about production" — worse than the question assumed

All eight fix-suites checked. **Every one is main-only:**

```
payment-ref-filter-injection · payment-ref-cross-tenant-union · gateway-amount-exact-match
reconcile-gateway-amount-exact-match · settle-stores-rounded-amount · stock-negative-balances
stock-negative-balance-report · guest-orders-declined-visibility     all: staging = ABSENT
```

**No staging test lies, because none exists.** Staging is green on these paths **by omission, not by
passing** — and that is worse: a red test gets investigated, an absent one is indistinguishable from
coverage.

### The three headline gaps — filed

- **#254** — the `?ref=` injection is **still open on staging**. It was *reproduced on staging* on
  2026-08-08 per the fixing commit, and fixed on main only. Compounds #242: two unauthenticated
  injection points on the reproduction environment.
- **#255** — **all** of #146's detection is main-only, and the two impossible balances (−8617, −154)
  are **on staging**. The environment holding the only known bad data is the one with no detector.
- **#256** — staging sits **between #180 and #190**: integer-cent `amountsMatch` but no gateway
  split, so gateway echoes get the client tolerance, an absent amount is not refused, and reconcile
  still compares raw floats at 2 cents. **An intermediate state that exists on no other branch and
  was never ruled on.**

### Method, again: `git cherry` OVER-reports too

87 by SHA → 39 by `git cherry` → **21 genuine / 7 patch-id false positives / 11 test-or-script-only**.
Proven not assumed: `ce02bf8` shows as absent while its file is **byte-identical on both refs** — the
file diverged elsewhere, so the patch-id differs while the fix is present.

Combined with the other direction (268 → 12, four already live), **neither reachability nor patch-id
alone is trustworthy here. Only reading the file at the ref is.**

### A promotion-order dependency worth having before anyone picks

**`1a1b05b` (#219) depends on `63a09a6` (declined visibility), which is not on staging.** Both touch
`lib/guest-orders/queries.ts`; `includeDeclined` is 0 at `c2c5d84`. Cherry-picking #219 alone will
conflict or land incoherently.

### And one gap correctly DE-escalated

#201's self-confirm button is still on staging — but revision 2 records it as **unsatisfiable**, so
it is dead code there, not a live defect. Listing it without that caveat would have overstated the
risk. The agent said so rather than padding the count.

Open issues: **116**.

---

## CHECKPOINT 16 — FINAL. Two agents hit the session limit; both delivered first.

`sp-receipt` and `sp-browse` both hit the limit at ~15:58 (resets 18:50 Africa/Windhoek). **Both
sent complete handoffs before stopping.** Nothing was lost.

### #243/#248 — THE OBVIOUS FIX IS INVALID, and that is the finding

**`order_requests` has NO `payment_status` column.** So "apply the payment filters to the requests
query too" issues `.eq('payment_status', …)` against a column that does not exist — PostgREST
errors, the route 500s, and v2's effect is `void run()` with **no catch**. It would trade a silent
wrong banner for an unhandled rejection on the landing screen.

Channel-only filtering does not rescue it: a request can carry `payment_channel: 'hosted'` while the
hosted checkout is **deferred to accept**, so it has no payment in flight and still matches.

**Found by reading the migration, not by a green test** — the agent's own stub applies filters to
fixture objects and can never error on a missing column. It said so.

### #243 dated precisely, and the failure mode is instructive

The block worked for two months. Killed on **2026-07-26 by `7efd00c`**, a *correct* security fix
scoping by session id — whose `--stat` against `v2/page.tsx` is **empty**. It did not touch the
caller. It fails to `null` rather than throwing, and "no block" is visually identical to "no pending
payment". Six weeks unnoticed.

And the sibling call at `v2:577` passes `countOnly: true`, so it works — **anyone eyeballing the file
sees a working call directly above the broken one.**

### THE ORDERING CONSTRAINT — #248 must land STRICTLY FIRST

Measured both directions. Fixing #243 alone means: a table where **nobody has attempted any
payment**, with one plain QR request awaiting review, tells a customer who has paid nothing that *"A
payment is being processed for this table"* and disables ordering for ten minutes.

Including in cherry-pick order onto main.

### #244 CLOSED REPO-WIDE — 198 refs, 144 unique commits

Three negatives, **with a positive control on the same 144 commits** (`sendReceiptEmail`, 817
matches) so the clean sheet reflects the repository rather than the search:

- `customer_email` — **zero matches, ever**. Every variant hit is the migration *filename* appearing
  as a string in apply/verify scripts, disposed of by name.
- Issuance has **never** referenced delivery on any commit. Not "not currently" — never.
- `lib/receipts/delivery/*` has **never** contained `pending`, so that status and its index have
  never had a writer.

Also: `sendReceiptEmail` appears in 11 files but has **3 callers** — four of the rest are
terminal-app files holding a *different* function of the same name. Anyone counting files gets 11.

### A measurement-harness lie, caught by the agent in itself

`EXIT=$?` after a pipe into `head` reports **head's** status, not `git grep`'s — it printed EXIT=0 on
a search that had found nothing. Re-run without the pipe. The agent's own summary: *"my measurement
harness lies more often than the code does."* Fifth instance this sprint.

### Also disclosed rather than hidden

`sp-browse` started reading in a fresh worktree **without provisioning it**, `npx jest` resolved
outside the repo, and it flagged skipping the TOOLCHAIN rule rather than quietly fixing it.

And its committed tests **pin defective behaviour on purpose**, with the file header saying so in
the imperative: when #248 is fixed they SHOULD go red, and that red is the signal. A green suite
pinning a defect is a recorded hazard here (#131, #146) and it refused to add another silently.

### FINAL SPRINT STATE

**Production `fdb999a` — never touched. `origin/main` unchanged. Nothing deployed. No migration
applied. No production write. #127 untouched.**

Open issues **116**, from 82 at start.

Branches, none pushed:
`sprint/browse-states` (#214 +exploiter) · `sprint/browse-cancellation` (#225, **stacks on
browse-states**) · `sprint/migration-check-lint` (#212) · `sprint/receipt` (#212 +exploiter +receipt
coverage) · `sprint/variants` (#200 +#240) · `sprint/qr-state` (#219 +probes) · `sprint/stock-pay`
(#219, **the better one**) · `fix/207-toast-mount-race` (#207) · `sprint/243-investigation`
(investigation artifact).

---

# EVENING SESSION — 2026-08-11, after the reset

## Shipped to production, three gated deploys, each verified before the next

    fdb999a -> 49ccfea   #212 migration lint, ALONE (new blocking CI gate)
            -> 524c592   batch: #207, #200/#240 evidence, issueReceiptForOrder coverage
            -> e578bd6   #219, alone (interaction with #122's union confirmed first)

**Production = `origin/main` = `e578bd6`.** Verified cache-busted. No drift between them.

The #212 gate's own CI output, not inferred from the job conclusion:

    INLINE CHECK CONSTRAINT CHECK: scanned 127 migration(s), 5 with an inline CHECK
                                   on ADD COLUMN IF NOT EXISTS (5 known and baselined).
    INLINE CHECK CONSTRAINT CHECK: OK — no new inline CHECK constraints.

Closed: **#212**, **#207**, **#219**. #240 left OPEN — coverage closed, route seam still uncovered.

## All nine sprint branches PUSHED to origin

They existed on one disk. Same exposure as the ledger branch. `origin/main` untouched by the push.

## Staging moved for a click-test: `c2c5d84` -> `99d2853`

Three browse commits cherry-picked (NOT the 90-commit version), gated, deployed, verified twice with
distinct cache-busters. **A second menu category was seeded on the staging test restaurant** — #225
was untestable without one, since no staging restaurant had more than one category. Disclosed to the
human as a write they had not authorised.

## THE FINDING THAT OUTRANKS THE REST — production RLS is UNMEASURED

`20260726200000_enable_rls_tabs_restaurants_users_sessions.sql:3` says *"Staging first; production
requires explicit sign-off"*, and its **only apply path in the repo is staging-scoped**. If it never
ran, production `tabs` is at baseline: `GRANT ALL … TO anon`, `SELECT USING (true)`,
`UPDATE USING (true)` — **`tab_pin` anon-readable and `tabs` anon-writable**, which makes #218, #235,
#236 and every PIN gate moot.

**Nine green deploys do not settle it** — the drift check compares filenames against the ledger, and
a ledger row is not evidence the SQL ran.

**I tried to measure it with the public anon key and was BLOCKED by the permission classifier. I did
not work around it.** Same denial a peer got; laundering my own around it is no better. It needs the
human and it is one query.

## Five packets delivered

- **#242 needs NOTHING from Finatic.** `.eq()` carries no parser, so two `.eq()` unioned in JS needs
  no charset assumption. Measured 213→0 with six real references returning **identical id sets**, and
  13 adversarial payloads all 0. The premise was false twice over: `paycloud.js:356-358` records
  PayCloud's own charset for that field and says it **intentionally excludes the comma**, and a census
  of all 144 stored references found **zero** rejects.
- **#223/#233/#187 as ONE packet**, plus an **eighth gate nobody had enumerated** —
  `payments/receipt/route.ts:103`, the last raw-float money gate in the repo, invisible to both the
  writer grep and the comparator grep.
- **#218/#235** — four corrections, three shrinking the issue and one enlarging it past it. #235's
  named mechanism is **inert** (`tabs.session_version` is write-only). `tabs.members` **publishes
  every member's session_id to anon**, which kills the membership option AND makes `f4f9111`'s own
  rejoin branch bypassable.
- **#254 ported** to staging, two-sided, 213→0 measured through the branch's own function.
- **#252 batch 1**: 31 commits, gated green, one escalated.

## Corrections carried into the contract (`c4b0383`)

- **#122 story fixed** — main is AHEAD on code and BEHIND on tests; I had it inverted and propagated it.
- **`dd3d9eb` incident EXPIRED** — the file it warns about is now on main. Labelled historical with an
  explicit instruction to delete the rule if no live instance can be cited next review.
- **#174/#175 off the do-not-promote list** — both fully live, measured.

## Open: 117

---

## CHECKPOINT — THE 42501 CORRECTION. The reasoning matters more than the finding.

The human ran the production RLS probe I was blocked from running and read the result as:

> *"That's a GRANT-level refusal… The anon role has no privilege on tabs on production."*

**That reading is wrong, and wrong in the direction that hides a live exposure.**

**Postgres reports a COLUMN-level privilege failure as `permission denied for table`.** So a 42501
on `select tab_pin` does not mean the role has no grant on the table — it means the role lacks
privilege on **that column**. The two are indistinguishable from the error text alone.

Measured, production, public anon key, read-only:

```
select tab_pin            -> 42501 permission denied for table tabs
select id, members        -> OK rows=3          <-- DECISIVE
select id, status, total  -> OK rows=3
select *                  -> 42501
```

**The discriminator is the pair, not either half.** `GRANT ALL` (baseline) would have allowed
`select *`. No grant at all would have refused `id, status, total`. Only a **column-level** grant
produces exactly this pattern — and that is precisely what `20260726200000` writes:
`REVOKE ALL FROM anon`, then `GRANT SELECT (id, …, members, …) TO anon`.

### Three consequences, all inverted from the first reading

1. **The migration DID run on production.** Good news, and it means `tab_pin` is genuinely
   protected — PIN gates are not theatre.
2. **`members` IS in the granted column list**, and the anon SELECT policy has **no restaurant
   scope**. So the exposure is live: `members[]` rows exposing a `session_id` = **3 of 3**, keys
   `["joined_at","session_id","display_name"]`. Filed **#262**.
3. Therefore `f4f9111`'s own *"already-a-member rejoin without PIN"* branch is bypassable by reading
   a value we publish — **an IDOR fix resting on a public value.**

### The transferable lesson

**An error message describes the check that failed, not the state of the system.** A single denied
query is one bit; the state needed at least three. The probe that settles it is the one that varies
what is asked while holding the credential fixed — `tab_pin` vs `members` vs `*` — because each
outcome is only meaningful against the others.

Filed **#263** for the second half: the migration is live with **no committed production apply
path**, and `check-migration-drift.mjs` compares filenames against a ledger that `db query` does not
write and `migration repair` writes without running SQL. **For any security-relevant migration the
ledger is not evidence; the only proof is probing enforced behaviour.** Same shape as
`restaurant_terminals_status_check`.

## Evening state at this checkpoint

    production / origin/main   a43aade   (fdb999a -> 49ccfea -> 524c592 -> e578bd6 -> a43aade)
    origin/cloudflare-staging  99d2853   (three browse commits, for the click-test)

Closed this session: **#212, #207, #219**. #240 left open — coverage closed, route seam is not.

**Every branch is now on origin.** Nine sprint branches, `fix/242-webhook-resolver-eq`,
`fix/254-staging-ref-injection`, and both reconciliation batches. Nothing lives on one disk.

**Reconciliation, both batches gated GREEN, pushed, not merged:**
`reconcile/main-to-staging-2` @ `c37e5ca` (31 commits) → `…-batch2` @ `715461f` (8 more, 39 ahead).
Ordering proven by measurement: main's own #219 conflicts on raw staging and applies clean on
batch 1.

**#212's control was weaker than the code it defends**, at exactly the property it tests hardest —
the suite has a whole `masking` describe block, and the control that argues masking matters did not
mask. Fixed on main (`a43aade`) rather than staging, because that migration is a deliberate
divergence and the red would have been permanent — #257's shape.

**An agent corrected my instruction and was right:** I said rebase batch 2; staging had not moved,
so a rebase would have been a no-op it could then have reported as work. It cherry-picked instead
and said so. *"I rebased and it's green"* would have been a true sentence describing an action that
did nothing.

## NEXT, per the human: #262 FIRST, nothing else until it ships

Remove `members` from the anon column grant. **Enumerate every legitimate anon reader BEFORE
changing anything** — report breakage rather than discovering it. Migration via
`safe-supabase-linked`, staging first, then production with drift confirmed both sides. Fallback if
a real path breaks: scope the SELECT policy by restaurant. Then re-run the decisive probe:
`select id, members` must REFUSE where it currently returns 3.

**#218's packet waits.** Q1b is now a confirmed exposure rather than a hypothesis, and it eliminates
the membership option before Q1 is asked.

---
---

# FINAL CHECKPOINT — 2026-08-11 evening. Written assuming total context loss.

## STATE

    production / origin/main    a43aade7ef50d0d60cb2c21e14fcf40b76bf6ba9   verified cache-busted
    origin/cloudflare-staging   99d285376154558a661ede38be53ebc4ab2bc2ed   verified cache-busted
    open issues                 119

Production path this session: `fdb999a` → `49ccfea` (#212) → `524c592` (batch) → `e578bd6` (#219) → `a43aade` (#212 control fix). Four gated deploys, each verified before the next. Closed: **#212, #207, #219**. #240 deliberately left open — coverage closed, route seam is not.

**EVERY BRANCH IS ON ORIGIN. NONE MERGED.** Nine `sprint/*`, `fix/207-toast-mount-race`, `fix/242-webhook-resolver-eq`, `fix/254-staging-ref-injection`, and both reconcile branches. Nothing lives on one disk.

**RECONCILIATION — both gated GREEN, both pushed, NOT merged. The human's to push, not the integrator's:**

    reconcile/main-to-staging-2         c37e5ca   31 commits on staging 99d2853
    reconcile/main-to-staging-2-batch2  715461f    8 commits stacked on batch 1

**ORDERING IS PROVEN, NOT ASSERTED.** Main's own `e578bd6` (#219) cherry-picked onto RAW `origin/cloudflare-staging` conflicts — `UU lib/guest-orders/queries.ts`, `DU __tests__/guest-orders-declined-visibility.test.ts` — and applies **clean** on batch 1, because batch 1 supplies `63a09a6`. **Batch 1 strictly first.**

Excluded deliberately: `f7ee138` (#122 union) belongs to #254, because its only gain over staging is DOOR 1 and that guard lives in `validation.ts` — landing it alone gives staging a guard that can never fire, under a comment saying it fails closed. `a6bb436`'s `20260811120000` is never reconciled.

---

## THE 42501 CORRECTION — the most valuable thing in this document

**What happened.** A production probe with the public anon key returned `{"code":"42501","message":"permission denied for table tabs"}` on `select tab_pin`. That was read — by the human, and I did not challenge it fast enough — as proof the anon role has **no privilege on `tabs`**, and therefore that the RLS migration had never run.

**Why that reading is wrong.** **Postgres reports a COLUMN-level privilege failure as `permission denied for table`.** The error names the table because that is the object the check was against; it does not tell you whether the role lacks privilege on the *table* or merely on the *column you asked for*. Those two states are **indistinguishable from the error text alone**.

**The decisive test is the PAIR, never either half:**

| query | if GRANT ALL | if no grant | if COLUMN grant |
|---|---|---|---|
| `select *` | OK | denied | **denied** |
| `select id, status, total` | OK | denied | **OK** |
| `select tab_pin` | OK | denied | **denied** |
| `select id, members` | OK | denied | **OK** |

Production returned denied / OK / denied / **OK rows=3**. Only the last column matches. So:

1. **The migration DID run on production** — despite its header saying "Staging first; production requires explicit sign-off" and its only in-repo apply path being staging-scoped.
2. **`tab_pin` IS genuinely protected.** PIN gates are not theatre. Good news, and invisible under the first reading.
3. **`members` IS granted** — so the exposure is live, which the first reading would have closed as a non-issue.

**The transferable lesson, same class as the lying instruments in Revision 1: an error message describes the CHECK THAT FAILED, not the state of the system.** A single denied query is one bit. Establishing the state took four. The probe that settles it **varies what is asked while holding the credential fixed** — because each outcome is only meaningful against the others.

Second half, filed as **#263**: the migration is live with **no committed production apply path**, and `check-migration-drift.mjs` compares migration *filenames* against a ledger that `db query` does not write and `migration repair` writes **without running SQL**. **For any security-relevant migration the ledger is not evidence; the only proof is probing enforced behaviour.** Same shape as `restaurant_terminals_status_check`.

---

## TOP ITEM — #262, LIVE EXPOSURE, NOT YET FIXED

`20260726200000:53-74` does `REVOKE ALL FROM anon` then `GRANT SELECT (id, restaurant_id, table_id, table_number, status, settled_type, total, members, payment_preference, ready_to_pay_at, pin_required, session_version, created_at, firebase_id, firebase_restaurant_id, settled_at, customer_name) TO anon`, and the anon SELECT policy has **NO restaurant scope**.

Measured on production, public anon key: `members[]` rows exposing a `session_id` = **3 of 3**, keys `["joined_at","session_id","display_name"]`.

**So anyone with the public anon key can list the session_id of every member of every open tab, across all restaurants.** And `app/api/tabs/[tabId]/join/route.ts:82-84` computes `alreadyMember` from a **client-supplied** `sessionId` against that array — so `f4f9111`'s own *"already-a-member rejoin without PIN"* branch, added as part of a join-by-UUID IDOR fix, **is bypassable by reading a value we publish.**

**PLAN, ruled by the human:** remove `members` from the anon column grant. Enumerate every legitimate anon reader FIRST and report breakage rather than discover it. Migration via `npx tsx scripts/safe-supabase-linked.ts`, **no raw `--linked`**. **Staging first**, drift confirmed before and after; production is a separate confirmed step and is the human's. Fallback only if a real path breaks: scope the SELECT policy by restaurant. Then re-run the decisive probe — `select id, members` must **refuse** where it currently returns 3 rows.

Two agents were enumerating readers independently when this session ended. The distinction that decides it is **CLIENT, not file**: browser-anon reads break, service-role server routes do not (`service_role` holds `GRANT ALL`). Enumerate by client construction site, not by the word `members` — `select('*')`, spreads and wholesale responses hide it.

---

## THE PIN QUESTION — ANSWERED. Reads only.

**Can staff see a tab's PIN today? NO. There is no staff surface that reads it.**

`grep -rn tab_pin` over `app components lib contexts` returns only:

- `app/api/tabs/join/route.ts:35,45` — selects and COMPARES it (by-PIN join)
- `app/api/tabs/[tabId]/join/route.ts:86,91` — COMPARES it
- `app/api/tabs/route.ts:100` — WRITES it at creation
- everything else is `tab_pin_required`, the settings **boolean**, not the PIN

**Recovery path if a customer forgets it: NONE, except staff clearing the table.** The PIN is shown once at creation and kept only in the creator's own `sessionStorage` as `flashtap_creator_tab_pin` (`v2/page.tsx:676`, read at `browse:195` and `tab:74`). `clearTabSession` can drop it — which is what makes **#220** ("View Menu" silently discards an open tab) worse than it looks. Once that storage is gone the PIN is unrecoverable by any in-product path; `close_table_session` settles the tab, which is the only escape.

**Bearing on #262: none, and that is the point.** Removing `members` from the anon grant does not touch PIN visibility or recovery, because no anon path reads `tab_pin` today — it already refuses with 42501. The grant change is safe from this angle.

---

## DECISIONS THAT MUST NOT BE RE-DERIVED

- **#212 → take `sprint/migration-check-lint` (`3d7ef8d`).** NOT `sprint/receipt`'s duplicate; they collide on both workflow files. (Already shipped as `49ccfea` + `a43aade`.)
- **#219 → take `sprint/stock-pay` (`1a1b05b`).** NOT `sprint/qr-state`'s. It normalises at the convergence point, not in one renderer. (Already shipped as `e578bd6`.)
- **`sprint/243-investigation` must NEVER reach main.** Its tests pin defective behaviour ON PURPOSE — when #248 is fixed they *should* go red. Shipping it puts a green suite on production asserting a bug is correct: **#131's shape exactly.** Noted on #248.
- **#242 needs NOTHING from Finatic.** `.eq()` carries no parser, so two `.eq()` unioned in JS needs no charset assumption. Measured 213→0 with six real references returning identical id sets, 13 adversarial payloads all 0. Fix assembled on `fix/242-webhook-resolver-eq`, awaiting the Q1 ruling.
- **#174/#175 are fully live and OFF the do-not-promote list.** Measured, not inherited.
- **The `dd3d9eb` contract incident has EXPIRED** — the file it warns about is now on main. Labelled historical, with an explicit instruction to delete the rule if no live instance can be cited.
- **#122's baseline story was INVERTED and is corrected:** `guestCanAccessOrder` is byte-identical at both refs. Main is AHEAD on code, BEHIND on tests. The 4-test delta is a stale test on main (#257).

---

## OUTSTANDING CLICK-TESTS — staging `99d2853`, restated in full

**Verify the build first.** Anything but this SHA and stop:

    curl -s "https://flashtap-staging.llosperofficial.workers.dev/api/version?cb=<any>"
    -> {"commit":"99d285376154558a661ede38be53ebc4ab2bc2ed"}

**URL, both tests** — use a **fresh incognito window each time** (a stale `flashtap_tab_id` in localStorage dead-ends you on #211, unrelated and unfixed):

    https://flashtap-staging.llosperofficial.workers.dev/menu/a1999166-ddfa-40d1-ad1f-2f01282a1652/v2?table=1001

A `drinks` category with 4 items was seeded on the staging test restaurant — #225 was untestable without a second category. Keep it.

### #214 — a loading menu must not read as an empty one

Phone, **mobile data not wifi**, cold cache, fresh incognito. Open the URL, reach the menu, watch the first screen at the moment items should appear.

**PASS:** a loading treatment, then items. Nothing is ever claimed about what the restaurant sells.
**FAIL:** "Menu coming soon!" · "This restaurant hasn't added menu items yet." · `No items in "mains" yet.` — at any moment, even for a fraction of a second.
**What it cannot tell you:** whether the spinner *looks* right or how long it is up. The exploiter proved the false text is never committed during a slow load but reported the TIMING half as **unreachable in jsdom**, not fixed. That judgement is the only reason this needs a phone.

### #225 — a response for a category you have left must not be applied

Same conditions. Reach the menu, tap **mains**, then **within about a second, before its items finish loading, tap drinks.** Repeat, varying the gap.

**PASS:** heading and items always agree. Under `drinks` only Rooibos Tea, Orange Juice, Sparkling Water, Iced Coffee.
**FAIL — three distinct shapes, each on its own:** Beef Burger / Chicken Wrap / Cappuccino under the **drinks** heading · a notice naming a category you have LEFT ("We couldn't load mains" while on drinks) · drinks items showing while a notice about drinks is **absent** because a stale success cleared it — **that third one is the worst and was not in the original report.**
**Expected behaviour change to judge:** switching categories now shows a loading treatment instead of the previous category's items. Strictly more honest; whether it feels right on a phone is a legitimate finding.

---

## #262 — STOP CONDITION HIT. The grant removal cannot go first. Nothing was written or applied.

The human asked to be told about breakage rather than discover it. **There is breakage, and it is larger than "member names disappear".**

### The mechanism, and it is proven by the human's own probe

**PostgREST refuses the ENTIRE query when the select list names an ungranted column.** It does not drop the column and return the rest. Two-sided, from the production measurement already recorded above:

    select tab_pin           -> 42501   (ungranted column -> WHOLE query refused)
    select id, status, total -> OK      (all granted -> OK)

Every anon select of `tabs` names `members` **alongside** `status`, `total`, `pin_required`, `settled_type`. Drop the grant and all of them return 42501 in full — the guest client can no longer read a tab's total, status or PIN requirement **at all**.

### Four anon select sites, six guest surfaces

Browser anon client (`lib/supabase/client.ts`, no auth session on guest QR pages):

1. `contexts/tab-context.tsx:126-131` — `loadTab()`. On error: logs and **returns**. Silent. `tabTotal`, `tabStatus`, `settlementType`, `tabMembers` freeze at initial values.
2. `app/menu/[restaurantId]/v2/page.tsx:428-433` — the open-tab lookup on the QR landing. On error `setOpenTab(null)`, so **the "join this tab" affordance silently disappears** — a guest at a table with an open tab is told there is none.
3. `lib/tab-session.ts:71-76` — `fetchTabById()`. **Throws.**
4. `lib/tab-session.ts:90-96` — `fetchActiveTabForTable()`. **Throws.**

3 and 4 are the shared library: `fetchTabById` is used by browse, receipt, tab and v2 pages; `fetchActiveTabForTable` by `useSessionTokenGuard` (the session-token guard on guest pages) and `useTabSessionEndedRedirect`.

**Identical at `99d2853`.** Staging breaks the same way — "staging first" would have knocked over the browse click-test environment rather than surfacing a smaller problem.

### Two consumers are real features, not cosmetic

- `app/menu/[restaurantId]/tab/page.tsx:135-188` keys the **per-person bill breakdown** on `member.session_id` and labels it `member.display_name`. Without it everyone renders **"Guest"** — on a surface where people split a bill.
- `app/menu/[restaurantId]/receipt/page.tsx:140-158` builds the receipt's member name map the same way.
- Genuinely cosmetic, count-only: `v2:459`/`:1161-1163`, `browse:794-801`.

**That is the collision: the customer-facing member NAMES live in the same array as the session ids.**

### The stated fallback is NOT IMPLEMENTABLE — do not spend anything on it

Scoping the anon SELECT policy by restaurant has nothing to bind to:

1. An anon PostgREST request carries **no restaurant identity**. The anon JWT claims are `role`/`iss`/`ref`/`exp`. The `.eq('restaurant_id', …)` in client queries is a **filter the client supplies**, not an identity a policy can enforce — an attacker supplies a different one. The only request-derived alternative, `current_setting('request.headers')`, is attacker-controlled and therefore not a control.
2. Even if it worked, the same migration makes `restaurants` anon-listable (`GRANT SELECT (id, name, slug, …) TO anon`, `USING (deleted_at IS NULL)`, no scope). An attacker enumerates every restaurant id and re-runs per restaurant. It converts one query into N.

### The PIN bypass is confirmed LIVE and WORKING, not merely theoretical

`app/api/tabs/[tabId]/join/route.ts` reads `members` under service-role at `:81`, computes at `:82-84`

    const alreadyMember = Boolean(sessionId) && members.some((m) => String(m?.session_id) === sessionId)

and `:86-93` **skips the PIN check entirely** when `alreadyMember`, then issues a real session token at `:112`. **The value that satisfies that check is the value anon can list.**

### And the exposure survives #262 anyway

`app/api/tabs/[tabId]/route.ts:30` selects `members` and `:41` returns the row **verbatim**. That route is session-token guarded and service-role — so closing the anon grant does **not** close it. Anyone holding a token for one tab still reads every co-member's session id. **Redaction at the route boundary is required regardless.**

### REVISED PLAN — code first, then the grant

1. Remove `members` from the four anon select lists.
2. Make `app/api/tabs/[tabId]/route.ts` return `display_name` + `joined_at` and **not** `session_id`; the tab and receipt pages consume it. Member counts come from the same response.
3. Ship and verify that code.
4. **Then** the migration: `REVOKE ALL … FROM anon` + re-`GRANT SELECT` the 16 remaining columns — column grants are not individually revocable, and `REVOKE ALL` + re-`GRANT` is `20260726200000`'s own idiom.
5. Then the decisive probe: `select id, members` must refuse where it now returns 3 rows.

**Migration LAST, so there is no window where the grant is gone and the client still asks for the column.**

### AWAITING RULING — three questions

- **Q1.** What do the tab and receipt pages show for other people? **A.** redacting seam, names preserved, exposure closed *(recommended — it also closes the token-guarded leak in the same change, and B needs that route anyway for the count)*. **B.** accept degradation to "Guest". **C.** grant first, fix after — **not viable, listed to be ruled out**.
- **Q2.** Ship order. **A.** code to production first, verified, migration last *(recommended)*. **B.** migration first — that is Q1.C.
- **Q3.** The PIN bypass is live **now**. Interim containment (require the PIN even for `alreadyMember`), or ship the real fix? Recommended **B, ship the real fix** — with the caveat that it leaves a working bypass open for the duration, and if that is more than a day, contain first.

**Nothing written. No branch, no commit, no migration, nothing applied to staging or production, no Supabase command run.**

---

## #262 — SECOND, INDEPENDENT ENUMERATION. Converges, and adds one finding that changes the blast radius.

Two agents enumerated the anon readers of `tabs.members` separately, neither seeing the other's output. **Both found the SAME four query sites** on the browser anon client:

    contexts/tab-context.tsx:126      loadTab
    app/menu/[restaurantId]/v2/page.tsx:428   open-tab lookup
    lib/tab-session.ts:71-72          fetchTabById
    lib/tab-session.ts:91-92          fetchActiveTabForTable

Independent convergence on a security-critical enumeration is the strongest evidence this sprint has produced, and it is the third time the pattern has paid.

They differ only in surface COUNT — six vs eight — because the second also counts `useTabSessionEndedRedirect` and enumerates the shared-library call sites separately. Not a disagreement about what breaks.

### The hypothesis that mattered — CONFIRMED

**`lib/tab-session.ts` names `members` INSIDE the library, and five of its six call sites never mention the word.** A grep for `members` scoped to pages finds `receipt` and `v2` and **misses `browse`, `tab`, `useTabSessionEndedRedirect` and `useSessionTokenGuard`** — half the surfaces, including the QR browse page.

**Enumerating by client-construction site rather than by the symbol is what finds them.** A symbol grep would have under-reported the blast radius by half.

The other hypothesis — an anon `select('*')` on `tabs` already failing — is a **clean negative**. All 28 `.from('tabs')` sites carry explicit column lists. Checked rather than inferred from the absence of bug reports.

### THE NEW FINDING — the blast radius is ENVIRONMENT-CONDITIONAL

`lib/supabase/server.ts:10`, verified at `origin/main`:

    const key = serviceRoleKey || anonKey

**`createServerSupabaseClient` falls back to the anon key.** Every one of the ~20 `app/api/**` routes treated as service-role is service-role **only while `SUPABASE_SERVICE_ROLE_KEY` is set in that environment**. If it is ever unset, renamed, or missing from a Worker's secrets, those routes silently become **anon** clients — inheriting anon's RLS policy and column grants, **with no code change and no deploy**.

Applied to #262: the "safe, unaffected, service-role" column of the enumeration is conditional on an environment variable nobody has checked. If it were unset, removing `members` from the grant would additionally break the tab-join and order-attribution routes.

**Not a claim that it IS unset anywhere** — the agent explicitly refused to read the Worker env and labelled it a conditional. **What settles it:** confirm `SUPABASE_SERVICE_ROLE_KEY` is present in the production and staging Worker secrets.

**Fix shape regardless: throw on a missing service-role key rather than substituting a weaker credential.** A server helper that silently degrades to the public key is the same class as the lying instruments — it reports success while doing something narrower than its name promises.

### The asymmetry that should shape the fix

`members` is not uniformly load-bearing:

- **`v2` (the unauthenticated QR landing — the widest exposure) needs only a COUNT.** `:459` reduces it immediately to `members.length`, rendered at `:1161-1163` as "N people on this tab". It never touches a single `session_id`.
- **`browse:794-801`** — same, count only.
- **`tab/page.tsx:133-145` and `receipt/page.tsx:140-159`** genuinely need the `session_id` ↔ `display_name` pairing, for the per-person split and the receipt name map.

**The surface with the widest exposure has the narrowest requirement.** A `display_name`-only or count-only shape satisfies `v2` and `browse` outright, and only `tab` and `receipt` need the pairing — which is a **server-route** question, not a grant question.

### The terminal — NEGATIVE, and the detail is instructive

`origin/feat/terminal-reconciled:src/lib/supabase.ts:5` **does** construct an anon client. But `git grep -ln "supabase\."` over `src/**` returns **nothing** — it is constructed and never imported or used. Its only tabs access is HTTP to a service-role route.

**Stopping at "it builds an anon client" would have reported the opposite conclusion.**

---
---

# CHECKPOINT — 2026-08-11 late evening. #262 in progress, seam NOT finished.

## STATE

    production / origin/main   97e4fe1e59fc9c0eb3cd69540800357d541af1b6   cache-busted verified
    origin/cloudflare-staging  99d285376154558a661ede38be53ebc4ab2bc2ed
    open issues                118

Production path this evening, four gated deploys each verified before the next:

    a43aade -> 7405b26  (#214 + #225, browse-cancellation)
            -> 237caec  (#262 CONTAINMENT — PIN bypass closed)
            -> 97e4fe1  (#266 — SUPABASE_SERVICE_ROLE_KEY pinned in both worker deploys)

Closed: **#214, #225, #266**. Filed: **#264, #265, #266**.

## THE SERVICE-ROLE QUESTION — ANSWERED, do not re-derive

`SUPABASE_SERVICE_ROLE_KEY` **IS present in BOTH Worker envs.** Measured, not inferred. The entire "unaffected because service-role" column of #262's enumeration stands.

**The discriminator, reusable on any environment:** `/api/guest/orders/active-table?restaurantId=..&table_number=..&countOnly=1` is an unauthenticated GET returning only an integer (`fetchGuestActiveTableOrders`, `lib/guest-orders/queries.ts:182`, fails closed unless `countOnly`). Production returned `count:2`, `count:2`, `count:5` for three restaurant/table pairs. The anon control — identical filters, public anon key, same project — returned `Content-Range: */0` for all three. `createServerSupabaseClient()` has exactly two possible keys and anon provably cannot see those rows.

Anti-artifact controls proving it is a live query, not a cached constant: `payment_status=paid` → 2, `payment_status=pending` → 0, `payment_channel=qr` → 0, bogus uuid → 0.

**It was set out of band** — present on the Worker, absent from every committed path. That was #266, now fixed: both workflows push it via `wrangler secret put`, and the step **fails** on empty rather than warning. Verified the step executed (`✨ Success! Uploaded secret SUPABASE_SERVICE_ROLE_KEY`), and re-ran the discriminator afterwards to prove the overwrite did not change which role production runs as — still 2 and 5.

**#264 remains open and is the behavioural half:** `lib/supabase/server.ts:10` is `const key = serviceRoleKey || anonKey`. It should THROW, not substitute the public anon key.

## #262 — WHERE IT ACTUALLY STANDS

**SHIPPED:** containment only. `app/api/tabs/[tabId]/join/route.ts` now requires the PIN unconditionally — one line, `if (pinRequired && !alreadyMember)` → `if (pinRequired)`. `alreadyMember` was KEPT: it has a second legitimate job preventing a rejoin appending a duplicate `members[]` entry. Failing-first proof asserts on the TOKEN, not the status code — the unfixed route hands a working session token for a stranger's tab to a caller supplying only a published `session_id`.

**The exposure is still live.** anon still reads `members[]` with `session_id`s on every open tab in every restaurant.

**ASSEMBLED, NOT SHIPPED:** `fix/262-redacting-seam` @ `442467d` (branched off `237caec`). Its #266 half is now on main separately; the rest is not. Contains:
- NEW `app/api/tabs/active/route.ts` — unauthenticated GET, service-role, `{ id, status, total, pin_required, member_count }` only. Reproduces v2's 12-hour `created_at` cutoff and its `table_id`-else-`table_number` branch, `.limit(1)` with **no `.order()`** (v2 had none; adding one changes which tab is picked). Carries v2's normalisations verbatim including `pin_required !== false` — NOT `Boolean()`, so a null column reads as PIN-required.
- v2's `~:428` rewired to it. All five fields confirmed consumed; the old query fetched nine columns nobody read.
- `fetchActiveTabForTable` — `members` REMOVED. Sole consumer `hooks/useSessionTokenGuard.ts:88` reads only `status`/`session_token`.
- NEW `lib/tab-status.ts` — leaf module for `ACTIVE_TAB_STATUSES`. Necessary because `lib/tab-session.ts` → `lib/supabase/client.ts` constructs a **browser** client at module scope, so an API route must not import it.

**NOT BUILT — this is the remaining work:**
1. The HMAC opaque member key (ruled below).
2. `contexts/tab-context.tsx` (~:126) and `lib/tab-session.ts` `fetchTabById` (~:71) still select `members` — they feed `tab/page.tsx:135` and `receipt/page.tsx:142`, which need the pairing.
3. The migration narrowing the anon grant. **LAST.**
4. The decisive probe.

## THE OPAQUE MEMBER KEY — RULED, four requirements

**HKDF from `SUPABASE_SERVICE_ROLE_KEY`, tab id as the info parameter.** Chosen over a dedicated secret because it needs no new configuration and the secret is already measured present in both Workers.

1. **Domain separation** — a distinct literal salt/info prefix, `"flashtap:tab-member-key:v1"` or similar, so the derivation can never collide with another use of that secret. The version is the escape hatch for rotating member keys independently.
2. **Throw if the secret is absent.** No fallback, no default, no empty string. Same requirement as #264's fix; both should land such that a missing service-role key fails loudly at first use.
3. **Never persist the derived key.** Map at read time on BOTH sides — `members[]` and `order.member_session_id`. Anything writing it to a row is a defect.
4. **Verify it is per-tab** — same customer, two tabs, two different keys. Test it.

**Why not stripping session_id:** `tab/page.tsx:161-179` groups orders by matching `member.session_id` against `order.member_session_id`; `receipt/page.tsx:140-157` keys its name map the same way. Strip it and both fall into their `members.length === 0` branch, labelling everyone **"Guest"** — explicitly rejected.

**Why not a positional index:** membership churn re-labels past orders.

**Why rotation is safe:** the key is never persisted and both sides are mapped server-side at read time, so a rotation changes both consistently and the join still resolves. It need only be stable within a response, not across time.

## FACTS THAT MUST NOT BE RE-DERIVED

- **PostgREST refuses the ENTIRE query when the select list names an ungranted column.** It does not drop the column. Proven two-sided on production: `select tab_pin` → 42501, `select id,status,total` → OK. This is why the migration is LAST — remove the grant while a client still asks and it is a full guest outage, not a cosmetic degradation.
- **Postgres reports a COLUMN-level privilege failure as `permission denied for TABLE`.** A single 42501 is one bit. The decisive test is the PAIR, never either half.
- **`GET /api/tabs/[tabId]` has ZERO callers** — grep for `api/tabs/` outside `app/api/` returns only `/join`, `/member`, `/ready-to-pay`, `/settle`. Its `:30` selects `members` and `:41` returns the row VERBATIM. That leak is independent of the anon grant and activates the moment the seam wires anything to it. `session_id` is itself a credential — `fetchGuestOrdersBySession` (`lib/tab-session.ts:125`) fetches orders BY session id.
- **Only v2's `~:428` is genuinely pre-token.** `browse`'s two tab reads both run only when the guest already holds a token. My brief said otherwise and was wrong.
- **`lib/tab-session.ts` names `members` INSIDE the library and five of its six call sites never mention the word.** Enumerate by client-construction site, never by grepping `members`.
- **`git worktree remove` FOLLOWS a junctioned `node_modules`** and deletes the shared install. Remove the junction link-only (`cmd /c rmdir <path>\node_modules`) first. This happened once today and destroyed ~530 packages mid-session; any test run in that window is suspect.

## THE DECISIVE PROBE — run it after the migration, not before

    select id, members   (public anon key, production)

Must **refuse** where it currently returns 3 rows. That is the only proof #262 is closed. The migration ledger is not evidence — `db query` does not write it and `migration repair` writes it without running SQL (#263).

## STAGING RESEEDED

The staging test restaurant had five drink-like items (Cappuccino, Coke 600ml, Flat White, Rock Shandy, Still Water) in `mains`, which weakened #225's click-test: the human's FAIL indicator named Cappuccino, and a Cappuccino under `drinks` reads as belonging there. Moved all five into `drinks`. `mains` is now food only; a leak is unmistakable. Worth a re-tap of #225, though the code result stands — the loading/heading behaviour is independent of category membership.

Staging tab at table 1001: `8bf5a1cf-cb5a-4998-8835-4b6fc36dd35d`, PIN **4196**, status open.

## OWED TO THE HUMAN

- **#265 recovery-path packet, after #262 lands.** What the recovery should be given staff cannot see the PIN either. Containment REMOVED the only working recovery path, because that path *was* the hole — the `alreadyMember` branch. Correct trade, deliberate, but it makes a real recovery route required rather than optional. Today the product's answer to a forgotten PIN is "staff settles your tab".
- **#218/#235/#236 packet** — rebuild against measured production state.
- **#223/#233/#187 one packet** — delivered, awaiting `#223: Q1:A Q2:B ...` format reply.
- **#242** on `fix/242-webhook-resolver-eq`, **#254** on `fix/254-staging-ref-injection` — both assembled, awaiting deploy decision.
- **#252 reconciliation** — `reconcile/main-to-staging-2` (`c37e5ca`) then `-batch2` (`715461f`), batch 1 STRICTLY FIRST (proven by cherry-pick conflict). Both gated green and pushed. **The human's to push, not the integrator's.**

---
---

# CHECKPOINT 2 — 2026-08-12, ~00:30. #262 seam SHIPPED, migration BLOCKED.

Supersedes the state block in the previous checkpoint (`c0dd102`), which predates the last two deploys.

## STATE

    production / origin/main   2ccea66fa0f0aee5493e7d948ddc3344e98d88e6   cache-busted verified
    origin/cloudflare-staging  99d285376154558a661ede38be53ebc4ab2bc2ed
    open issues                119

Deploy path 2026-08-11 evening, five gated deploys, each verified before the next:

    a43aade -> 7405b26  #214 + #225 (browse-cancellation)          CLOSED
            -> 237caec  #262 containment — PIN bypass closed
            -> 97e4fe1  #266 — service-role key pinned in both     CLOSED
            -> 2ccea66  #262 SEAM — HKDF member key + both selects

Filed tonight: **#264** (helper should throw), **#265** (PIN lockout, packet owed), **#266** (closed), **#267** (worktree junction footgun).

## ⚠️ THE ORDERING TRAP — READ THIS BEFORE TOUCHING THE MIGRATION

**The migration must be APPLIED to production BEFORE its file reaches main.**

`production-worker.yml` has a `Check migration drift (production DB vs supabase/migrations)` step that compares migration **filenames** against the production ledger. A file present in the repo but not applied to the DB makes that step fail, which **blocks every production deploy** — not just this one.

This already happened tonight with `20260811120000` and cost a deploy cycle. The correct order is:

1. Apply the SQL to staging. Verify.
2. Apply the SQL to production. 
3. Confirm the drift check reads clean.
4. **Then** merge the migration file to main.

Note also that `db query` does NOT write the migration ledger (#263) — applying the SQL this way may still leave drift. `migration repair --status applied <version>` writes the ledger **without running SQL**. Verified-present objects get a repair, never a re-run. Never rewrite the committed file.

## #262 — WHERE IT STANDS

**SHIPPED and verified live at `2ccea66`:**

- `lib/tab-member-key.ts` — HKDF opaque member key. Web Crypto (`crypto.subtle`), matching `lib/terminal-auth/pin-credentials.ts`; nothing in the repo imports `node:crypto`.

      PRK        = HKDF-Extract(salt = "flashtap:tab-member-key:v1", ikm = SUPABASE_SERVICE_ROLE_KEY)
      K_tab      = HKDF-Expand(PRK, info = <tab id>, 32 bytes)
      member_key = "mk_" || hex(HMAC-SHA256(K_tab, "<label>|" || session_id)[0..16])

  Requirement 1 (versioned label) at `:55`; requirement 2 (throw, no default) at `:88-98`; requirement 3 (never persisted) is **structural** — the module has zero imports so it has no DB client; requirement 4 (per-tab) at `:127`, with a test that goes red when `info` is made constant.
- NEW `app/api/tabs/[tabId]/view/route.ts` — the seam. Returns `{ display_name, joined_at, member_key }` plus `self_member_keys`. Deliberately **unauthenticated**: putting `loadTab` behind `requireSessionToken` would 410 → `handleSessionExpired` → bounce any guest without a minted token off a live tab on every `/menu` route. It returns a strict subset of what anon can read today.
- NEW `app/api/tabs/active/route.ts` — unauthenticated count route for the QR landing. `{ id, status, total, pin_required, member_count }`. Reproduces v2's 12-hour cutoff and its `table_id`-else-`table_number` branch. **No `.order()`** — v2 had none; adding one changes which tab is picked. Keeps `pin_required !== false` (NOT `Boolean()`), so a null column reads as PIN-required.
- `contexts/tab-context.tsx` and `lib/tab-session.ts` `fetchTabById` both routed through the seam. `TabRow.members` typed `PublicTabMember[]`, so **reaching for `session_id` no longer compiles** — stronger than a test.
- `lib/guest-orders/queries.ts` maps `member_session_id` through the same helper at all four guest read paths, so the client-side join still resolves. Includes `byPaymentRef`, which was actually reading back another diner's session id.
- `GET /api/tabs/[tabId]` — was returning the row VERBATIM; now projected field-by-field.

**NOT DONE — the exposure is STILL LIVE.** Verified against production at the time of writing:

    select id, restaurant_id, table_number, status, members   (public anon key)
    -> 3 rows, session_ids visible

**BLOCKER: the migration cannot be applied.** `npx tsx scripts/safe-supabase-linked.ts <ref> db query --linked -f <file>` fails. The CLI is present (2.113.0), `db query` is a valid subcommand, and the project is linked to **staging** (`supabase/.temp/project-ref` = `mdqjpxwczrhkxkbqatqa`). What is missing is the database password — there is no `SUPABASE_DB_PASSWORD` in `.env.test`, `.env.local` or `.env`. An earlier attempt hung on what looked like a password prompt.

**The migration**, written and correct, on `fix/262-redacting-seam` at `supabase/migrations/20260811120000_tabs_anon_grant_drop_members.sql`:

    REVOKE ALL ON TABLE public.tabs FROM anon;
    GRANT SELECT (
      id, restaurant_id, table_id, table_number, status, settled_type, total,
      payment_preference, ready_to_pay_at, pin_required, session_version,
      created_at, firebase_id, firebase_restaurant_id, settled_at
    ) ON TABLE public.tabs TO anon;

15 columns — `20260726200000`'s 17 minus `members` and `customer_name`. `customer_name` was verified removable: written/read only by `app/api/tabs/route.ts` under service_role, and the one test touching it uses `getSupabaseAdmin()`. `components/orders-dashboard.tsx` reads `members` but as signed-in staff under the `authenticated` role, which this migration does not touch.

The migration's own two tests were split OUT of the code commit and live in `/tmp/mig-tests.txt` and in the git history of `fix/262-redacting-seam` — they read the migration file, so they must land WITH it, not before.

**THE CLOSE CONDITION, unchanged:** `select id, members` against **production** with the public anon key must REFUSE where it currently returns 3 rows. The migration ledger is not evidence — only probing enforced behaviour is.

**Caveat not to overstate:** the count route was verified live on the NEGATIVE path only (`{"tab":null}`, correct — the tab it would have matched is from 17 July and the route reproduces the 12-hour cutoff). Its positive path rests on unit tests, not a live call.

## GATE NOTE — the jest baseline moved tonight

The measured baseline was **15 failed suites / 11 failed tests** for most of the session. Late runs measured 8/18 then 10/32 at the same ref. **Re-measure the baseline at your own base ref before diffing; do not trust an inherited number.** Every failing suite examined was a live-HTTP/staging suite (`permissions`, `realtime`, `authorize-restaurant-roles`, `recipe-deduction`) and each passed when re-run individually. `realtime.test.ts` asserts a raw WebSocket handshake completes within 3s against live Supabase — genuinely timing-flaky.

## QUEUED, in the human's stated order

1. **#262** — apply the migration, then the production probe. Blocked on the DB password.
2. **Staging reconciliation** — push `reconcile/main-to-staging-2` (`c37e5ca`, 31 commits) **then** `-batch2` (`715461f`, 8 stacked). **Batch 1 strictly first — the ordering is measured**, proven by a cherry-pick conflict (`e578bd6` conflicts on raw staging, applies clean on batch 1 because batch 1 supplies `63a09a6`). Closes #254 and #252 in one move, since staging gets main's ref fix. Afterwards confirm staging's `paymentRefOrFilter` matches main's and re-run the injected/benign pair to prove it closed there.
3. **#242** — ship `fix/242-webhook-resolver-eq`. Needs NOTHING from Finatic: `.eq()` carries no parser, so two `.eq()` unioned in JS needs no charset assumption. Measured 213 rows → 0, six real references returning identical id sets, 13 adversarial payloads all 0. **Exploiter runs the ORIGINAL reproduction**, not the implementer's test.
4. **#223/#233/#187** — one unified packet, three sites one ruling. Outstanding since 2026-08-10. Must include the PayCloud webhook as the only unauthenticated external writer.
5. **#265** — recovery packet. Framing already agreed: containment REMOVED the only working recovery path, because that path WAS the hole (the `alreadyMember` branch). Correct trade, deliberate. Options needed for what recovery should be **given staff cannot see the PIN either** — no surface reads `tab_pin`; it is compared at `app/api/tabs/join/route.ts:35,45` and `[tabId]/join/route.ts:86,91`, written at `app/api/tabs/route.ts:100`, and stored only in the creator's `sessionStorage` as `flashtap_creator_tab_pin`, which #220's "View Menu" can destroy.
6. **#127 — DO NOT START WITH THE DELETION.** The human's explicit instruction. **Start with the refund question, which is reads only and is the only part that could bite a customer this week:** two orders share number 420 with different totals (N$34 and N$78). Establish what a refund against order 420 actually does today — which total the system picks, or whether it fails. If a refund is genuinely ambiguous that is an incident to contain, not a migration to run.

   Then, and only then: the 279 fixture pairs are **DELETE**d (restaurants that don't exist, no customer attached, load-test debris — the append-only rule is about business history). **Enumerate dependents first and delete leaves first** — an earlier cleanup left a worse half-state than it started with because audit rows went before the orders they belonged to. The three FNB ChowNow pairs are **NOT renumbered** — those receipts exist and a customer holds them. The unique index then goes on scoped to exclude those three orders, or not at all until they are resolved; report which is possible.

## WHAT THE HUMAN NEEDS TO SET (answered in the final message)

`SUPABASE_DB_PASSWORD`, in `.env.local` (gitignored, and the script's shell inherits it). **Staging and production are separate Supabase projects and have separate database passwords** — one value will not serve both. The CLI is currently linked to staging; switching targets needs `npx supabase link --project-ref ihlmmpmolnpchzgwyhgh` and back. The `safe-supabase-linked.ts` guard takes the expected ref as its first argument and refuses if the link does not match, which is what stops a staging command hitting production.

---
---

# CHECKPOINT — 2026-08-12, fresh session. Two corrections to inherited state, #223 completed, #265 packet.

## STATE, measured this session, not inherited

    origin/main                 3f521498348bce9b4b7c57e0b5515c75c5fae65f   production, cache-busted ×2, matches exactly
    origin/cloudflare-staging   6167f5dc1678d6a8da32ea7df58df8b44ffee5c4
    open issues                 121 (gh issue list, exact count)
    docs/agent-operating-contracts tip                                     9c3c326 — REVISION 2 is what governs; no Revision 3 exists on this branch

**Two things the incoming brief for this session got wrong, both caught by verifying rather than trusting:**

- **The named checkpoint `55e6dac` does not exist.** Not on this branch, not on any branch — `git cat-file -e` fails and `git log --all` finds nothing. Whatever produced that SHA, it never reached `origin`. The real tip is `9c3c326`, five commits ahead of what this file's last checkpoint (`c0dd102`) described.
- **"Revision 3 governs" is false as of this checkout.** `agent-operating-contracts.md` at `9c3c326` contains Revision 1 and Revision 2 only. If a Revision 3 exists somewhere it is not on `origin/docs/agent-operating-contracts`.

**`.env.local` is present but not populated.** One line, 39 bytes, `PAYCLOUD_TERMINAL_SN` only — no `SUPABASE_DB_PASSWORD`, no Supabase keys. Functionally the same blocker this file already named at the previous checkpoint: the #262 migration is still stuck behind it. Treated as a hard stop for anything needing real DB/Supabase credentials (matches the standing instruction); did not block #223 (hermetic tests only) or #265 (a ruling packet, no live query needed).

## #223 — COMPLETE on `fix/223-amount-gates`, NOT pushed

`bcbde10` (shared foundation + cron leg, already on the branch from earlier the same day per its own commit timestamp) + `ee93153` (this session — webhook both paths, `reconcileOrphanPayments`, and the `payments/receipt/route.ts` eighth gate). Ruling applied exactly as given: **Q1:A** integer cents / absent-is-not-agreeing extended to all four sites, **Q2:A** (query Finatic where no amount is present — already the cron leg's shape, unchanged), **Q3: quarantine on the cron only, refuse everywhere else.**

- `app/api/webhooks/paycloud/route.ts` — both paths (signature-valid, signature-fallback) shared one bug: `markOrdersPaidConfirmedByIds` wrote `amount: Number(row.total)`, never comparing it to anything the gateway actually said. Fixed by comparing the gateway's one figure against the **SUM** of every order the webhook event names (not a single row — a webhook can settle several orders at once), before writing anything. Refused: both figures recorded (`payment.verification_uncertain` always, `payment.amount_mismatch` when a figure was actually received — the established #187/#190 two-action split), webhook still ACKs 200 (Finatic will report the same disagreeing amount on every retry; a 503 buys nothing).
- `lib/payments/reconcile-orphan-payments.ts` — same shape, `payment_events.amount` was selected nowhere and never read. Fixed the same way, with one extra trap avoided: the sum has to be over **every** order the event names, not only the currently-unpaid subset, or an already-paid sibling silently shrinks the expected total and manufactures a false mismatch. Covered by a dedicated test (`reconcile-orphan-payments-amount-mismatch.test.ts`, "an already-paid sibling does not shrink the expected total").
- `app/api/payments/receipt/route.ts` — the **eighth gate**, previously unenumerated by either the writer grep or the comparator grep (it isn't a `markOrderPaidConfirmed` call at all — it's the pre-checkout client-amount validation). Two defects in one line: raw-float comparison (`#180`'s shape) and a **NaN passthrough** — `Math.abs(NaN - x) > 0.02` is `false`, so an absent/garbage client amount silently PASSED instead of being refused. Fixed via `amountsMatch` at `PAYMENT_AMOUNT_TOLERANCE_CENTS` (this is a CLIENT leg — nothing has been charged yet at this point in the flow, same shape as `tabs/[tabId]/settle`, not a gateway leg despite sitting inside the same ruling).

**Four pre-existing hermetic tests had their own coverage silently defeated by the new gate** (fixtures with no `amount`/no matching total) and were caught by running them, not assumed clean: `e04111-recovery-reconcile.test.ts` (three fixtures), `e04111-recovery-webhook-route.test.ts` (one case, was reaching 200 instead of the 503 it asserts). Fixed the fixtures, not the assertions. 11 hermetic suites / 67 tests green. `tsc 5.9.3` exit 0.

**Not pushed.** Sitting on local `fix/223-amount-gates`, one commit ahead of `origin/fix/223-amount-gates`. Standing rule: nothing to production without the human's go, and pushing a branch is visible/shared state even short of that — left for the human to say push or not.

## #265 — RULING PACKET, delivered this checkpoint, unruled

```
RULING — #265

FINDING
- The PIN is written once at creation (app/api/tabs/route.ts:100), compared at two join
  routes (join/route.ts:35,45 and [tabId]/join/route.ts:86,91), and displayed exactly
  once — to the creator's own device, stored only in that device's sessionStorage
  (flashtap_creator_tab_pin). No staff surface reads tab_pin; confirmed again this
  session against origin/main.
- Before #262's containment, the ONLY way back in after losing that local value was the
  alreadyMember branch: present a session_id you already held, skip the PIN. That was
  also the vulnerability — session_id was independently readable by ANY anon caller via
  tabs.members (no restaurant scope) and returned verbatim by GET /api/tabs/[tabId].
  Containment made PIN mandatory unconditionally (verified on origin/main this session:
  join/route.ts now reads "if pinRequired { require PIN, member or not }"), closing the
  bypass and the recovery path in the same line, because they were the same line.
- The #262 seam (shipped, on origin/main) has since closed BOTH places that made
  session_id readable at the application layer — confirmed by reading both routes on
  origin/main this session: GET /api/tabs/[tabId] no longer selects session_id at all;
  the new GET /api/tabs/[tabId]/view returns an opaque HKDF-derived member_key in its
  place. NOT yet closed: the underlying Postgres grant. Migration
  20260811120000 (REVOKE members from the anon SELECT list) is written and correct but
  unapplied — blocked on SUPABASE_DB_PASSWORD, confirmed absent from this machine's
  .env.local too. Until the decisive probe (`select id, members` on production refuses)
  passes, a caller with nothing but the public anon key and curl can still read
  session_id directly from Postgres, bypassing the app entirely.
- member_key is NOT a safe substitute credential for a rejoin check: it is served by an
  intentionally UNAUTHENTICATED route to anyone who knows the tabId, by design (mirrors
  the pre-token v2 landing read). Using it the way session_id was used would recreate
  the identical bypass with an opaque value standing in for a raw one.

REFRAMED DECISION
Not "how do we let staff read out a PIN" — no staff surface reads it today and building
one is a new capability, not a restoration. Two questions, because they answer two
different failure shapes: (a) same device, PIN specifically lost, session_id still
valid locally; (b) different device, or local storage wholly cleared.

Q1. Is "no staff surface may ever display tab_pin" a hard requirement going forward, or
    incidental — true today only because nothing needed it yet?
  A. Hard requirement. Every option below must not expose the raw PIN to staff, ever.
  B. Incidental. A staff-visible PIN (e.g. on the table/tab card) is an acceptable
     fourth option.
  RECOMMENDATION: A — nothing about the PIN's role (a same-party gate, not a payment
  credential) argues for widening who can read it, and widening reachable columns has
  already produced #262 once this sprint.

Q2. Failure shape (a) — same device, PIN lost, session_id still valid locally. Restore
    automatic recognition?
  A. Reinstate the alreadyMember bypass (or equivalent), gated on the #262 migration
     being CONFIRMED applied (the decisive probe passing), not merely committed.
  B. Leave it closed permanently; treat every forgotten-PIN case as shape (b).
  RECOMMENDATION: A — the thing that made the bypass dangerous is a closed
  application-layer surface and one migration away from closed at the database layer
  too; once both are true this is an ordinary bearer-token check, and it silently
  resolves most forgotten-PIN cases with zero staff involvement.

Q3. Failure shape (b) — different device, or local storage cleared. What replaces
    "staff settles your tab"?
  A. Staff-triggered re-mint, PIN never staff-visible. A terminal/POS action ("Reset
     PIN for this tab") flags the tab for one re-mint; the customer re-scans the SAME
     static table QR they already have; the flow detects the flag, mints a NEW PIN
     server-side, and displays it ONCE on the customer's own device — reusing the exact
     creation-time UX rather than inventing a new one. Staff's screen never shows the
     value; they only trigger the flag. tab_pin changes; session_version is NOT
     touched, so other members already holding a valid session are undisturbed.
  B. Staff-visible PIN, relayed verbally. Forecloses Q1:A.
  C. No product change; staff continues settling the whole tab. Status quo — the thing
     #265 exists because of.
  RECOMMENDATION: A — the only option that resolves every forgotten-PIN case (device
  changed or not) without reopening what #262 just closed or mooting Q1 before it is
  answered.

CUSTOMER IMPACT
Today: no self-service recovery; staff must settle the whole table's tab, disruptive
mid-meal and does not scale under load — Riviera's own 13:30-16:00 service window is
exactly the case this bites hardest. Q2:A resolves the common case automatically the
moment the migration lands. Q3:A resolves the rest with one staff tap and no verbal PIN
sharing.

BLOCKS
Q2's implementation is blocked on the #262 migration landing and being PROBED, not
assumed — the decisive probe is the only acceptable evidence, per this file's own
standing rule. Q3 has no such dependency and can ship independently, before or after Q2.

CONFIDENCE: high on the finding (read directly from shipped code at origin/main this
session); medium on Q3's exact UX (assumes the landing page can cheaply distinguish
"fresh table, no tab" from "this table's tab flagged for re-mint" — plausible from
v2/page.tsx's existing 12-hour-cutoff lookup shape, not verified against the current
file this session).

COULD NOT DETERMINE
Whether product/support has an operational reason to want a staff-visible PIN for
dispute resolution ("customer says we never got one") — a support-policy question, not
one the code answers. Folded into Q1 rather than assumed either way.

Reply format: #265: Q1:_ Q2:_ Q3:_
```

## Queued rather than idled

`#262`'s migration and everything gated on it (Q2 above, plus the standing decisive-probe requirement) stayed queued behind the missing `SUPABASE_DB_PASSWORD` — not attempted, not worked around. Staging's `#262` third landing intentionally left alone per instruction: Riviera is trading 13:30–16:00 and staging is the fallback environment if anything goes wrong during service.

---
---

# CHECKPOINT — 2026-08-12, same session continued. #265 ruled and Q3 implemented, #223 pushed, Revision 3 written.

## #265 — RULED: Q1:A Q2:A Q3:A. Q3 implemented this checkpoint; Q2 deliberately not.

`fix/265-pin-recovery`, cut from `origin/main` at `3f52149`, commit `7826624`. **Not pushed** —
no instruction to push this one specifically, only `fix/223-amount-gates`.

- Migration `20260812130000_tabs_pin_reset_token.sql` — adds `pin_reset_token` +
  `pin_reset_token_expires_at` to `tabs`. **Not applied anywhere** — same `SUPABASE_DB_PASSWORD`
  gap as `#262`'s migration. Written and reviewed, not run.
- `POST /api/tabs/[tabId]/reset-pin` — new, terminal-auth (staff/POS), mints the token via
  `crypto.randomUUID()` (not `Math.random`, which `#241` already flagged weak for a comparable
  code), 15-minute TTL, returns a recovery URL for staff to render as a QR on their OWN screen.
  Touches neither `tab_pin` nor `session_version`.
- `POST /api/tabs/[tabId]/join` — gained a `resetToken` branch, checked before the ordinary
  `pin_required` gate. A live match mints a NEW `tab_pin` and clears both reset columns in the
  SAME update; verified single-use under a race by checking the update's RETURNED ROW, not just
  the absence of an error — an unchecked update would have let a race loser proceed with a
  `newPin` that was never actually written. New PIN returned only in that response.
- `v2/page.tsx` reads a `pinReset` query param (what the recovery QR encodes) and shows a
  "Get My New PIN" card ahead of the ordinary open-tab branches; on success reuses the EXISTING
  `createdTabPin` "Your tab PIN is" screen rather than a second one. `tab-context.tsx`'s
  `joinExistingTab` carries the token through and stores the returned PIN under the same
  `flashtap_creator_tab_pin` key creation uses.
- **7 new tests** (`tab-pin-reset.test.ts`), plus the pre-existing `#262` PIN-bypass suite and
  the landing/tab-context suites re-run clean — 84 tests / 7 suites, `tsc 5.9.3` exit 0.

**NOT DONE, disclosed:** the migration is unapplied (blocked on the DB password); the frontend
was **not click-tested in a browser** — no populated Supabase credentials on this machine to run
a live dev server against, so this needs the same staging click-test `#214`/`#225` got before it
ships (PROOF CEILING: STAGING, not reached). Q2 (reinstating same-device recognition once the
migration is confirmed applied) is intentionally not implemented here — separate, smaller change,
gated on the decisive probe, not on this commit.

## #223 — pushed to origin

`fix/223-amount-gates` pushed per explicit instruction: `bcbde10..ee93153`. See the prior
checkpoint in this file for what `ee93153` contains (webhook both paths, `reconcileOrphanPayments`,
the `payments/receipt/route.ts` eighth gate).

## Contract corrections — re-derived, not recalled, and pushed

The incoming brief this session cited checkpoint `55e6dac` and "Revision 3 governs" — neither
existed on any branch (`git cat-file -e` / `git log --all` came up empty for the SHA; the docs
branch tip only carried Revision 2). Per instruction, did not try to reconstruct Revision 3 from
memory. Instead re-derived two rules from this session's own verification and added them as
Revision 3, pushed to `origin/docs/agent-operating-contracts` (`9c3c326..3af332b`):

- **Rule 10** — `check-migration-drift.mjs` resolves its migrations directory via `__dirname`,
  not `cwd`. Demonstrated directly, not just reasoned about: two worktrees open this session
  turned out to be carrying genuinely different copies of the file, which is what led to finding
  Rule 11.
- **Rule 11** — that difference is because `76153d8` (#143, environment-scoped migrations, a
  three-state OK/WARNING/FAILED drift check) is reachable from staging and several feature
  branches but **not from `origin/main`**. Verified by reading each environment's own copy of
  the script plus the workflow files that invoke it (`production-worker.yml:138-139`,
  `staging.yml:546-551`): production's actual deploy gate still runs the two-state version.
  Dormant today (no `-- @env:` header on any committed migration on `main`, checked this
  session) but silent the day one lands.

## State at this checkpoint

    origin/main                 3f52149   unchanged this session
    origin/cloudflare-staging   6167f5d   unchanged this session
    fix/223-amount-gates        ee93153   PUSHED
    fix/265-pin-recovery        7826624   NOT pushed
    docs/agent-operating-contracts   3af332b   PUSHED (Revision 3)

Nothing deployed. No migration applied. No production write. `.env.local` held for the
DB/Supabase credentials still incoming — nothing attempted that needed them.

---
---

# CHECKPOINT — 2026-08-12, same session. Two corrections, both from the human, both applied.

## #269 filed. Rule 11 corrected.

The human caught two things in the just-written Revision 3:

1. **`76153d8` not reaching `origin/main` deserved its own issue**, separate from being a
   contract note — it is a live gap in the deploy pipeline, not only a process finding. Filed as
   **#269**.
2. **The human's own instruction that asked for Rule 11 described the three-state drift check
   without saying staging-only** — true of one copy of the script, not of the one that actually
   gates a production deploy. Rule 11 is corrected to lead with "production's gate runs two
   states, staging's runs three" rather than "the drift check has three states," and now records
   that its own first draft repeated the imprecise framing before being corrected — the same
   VERIFY BEFORE TRUSTING rule this document already states, applied to a human's brief instead
   of an agent's, for the first time on record.

Both pushed: `docs/agent-operating-contracts` at `9b9a9c2`.

## fix/265-pin-recovery pushed

Same reason as `#223`: nothing lives on one disk. `origin/fix/265-pin-recovery` now carries
`7826624`.

## HOLD

Per instruction: holding for `.env.local` (DB password, Supabase keys). Neither `#223` nor
`#265`'s Q3 ships to production while Riviera is trading — both need a staging pass first.
Nothing further attempted this session.

---
---

# OVERNIGHT — 2026-08-12/13. Two ships, one stop condition.

## STATE

    production / origin/main   c0bee8b62b18efec979ba0f1c0c376b69b41ec8a   cache-busted x3
    origin/cloudflare-staging  6167f5dc1678d6a8da32ea7df58df8b44ffee5c4   UNCHANGED
    production ledger          128 applied, drift gate green in CI
    open issues                118 (from 121)

Production path tonight, two gated deploys, each verified before the next:

    3f52149 -> 6867ecc   #269 drift-check environment scope
            -> c0bee8b   #223 amount gates, ALONE

## 1. #269 SHIPPED

Ported the environment-scope half of `76153d8` to main. **Not a whole cherry-pick** — that commit
also adds three migration FILES, none applied on production (verified against the live ledger via
`list_applied_migration_versions`: 128 rows, all three absent). Taking it whole would have tripped
`LOCAL_NOT_APPLIED` three times and blocked every production deploy — Rule 12's third row,
self-inflicted by the commit meant to improve the gate.

Two-sided from the tree's own copy (Rule 10): unscoped fake migration -> FAILED naming it; same
file with `-- @env: staging` -> excluded, OK. `targetEnvironment` 0 -> 2 on main.

## 2. #223 SHIPPED, ALONE

Full suite at `origin/main` first, then the branch, same worktree:

    main      8 failed / 108 passed suites · 18 failed / 961 passed tests
    branch    8 failed / 112 passed suites · 18 failed / 983 passed tests

**Identical failing set BY NAME. No green->red.** Branch adds 4 suites / 22 tests, all green.

Exploiter reconstructed #223's ORIGINAL scenario from the issue text, not the branch's tests:
order N$200, Finatic confirms PAID for N$20 -> quarantined, not paid, not cancelled, both figures
in the audit row. Plus a control proving the gate does NOT fire on an agreeing amount — without it
the first assertion would also pass if the gate held every order. Control ceiling disclosed: the
in-memory double cannot carry `markOrderPaidConfirmed` to completion, so it asserts the
discriminating property rather than `payment_status === 'paid'`.

Smoke on production after: webhook 503 on an unknown reference (correct, pre-existing), landing 200,
guest count route serving, by-payment-ref benign 0 / injected 0, `/api/tabs/active` responding,
**#262 still closed (anon `members` -> 401)**. Receipt route's remaining `0.02` hits are both in the
explanatory comment; live code is `amountsMatch(...)`, and it closed a real NaN hole — an ABSENT
client amount used to pass silently because `NaN > 0.02` is false.

Closed, each verified by reading the file AT THE DEPLOYED SHA: **#269, #223, #233, #187, #226**.
**#268 deliberately left open** — the webhook valid-signature path still recorded no amount
historically, so that question stays permanently unanswerable and the fix does not close it.

## 3. #265 — STOP CONDITION, not deployed

`fix/265-pin-recovery` (`7826624`) carries **`20260812130000_tabs_pin_reset_token.sql`** — two
columns plus a partial index on `tabs`. Verified NOT applied on staging (ledger 131 rows, absent).

That is two of the stated stop conditions at once: *a migration you didn't expect*, and
*anything needing a migration applied* on the skip list. Pushing the branch to staging would also
have put an unapplied migration file there and failed staging's own drift gate — taking down the
environment needed if tomorrow goes wrong.

**Nothing deployed, nothing applied.** Note for when it is ruled: the new columns are NOT in
`20260811120000`'s anon grant list, so anon cannot read `pin_reset_token` — the #262 narrowing
protects them by construction, which is the right default and worth keeping.

## 4. Load simulation — harness built and validated, NO latency numbers yet

`scripts/load-sim-qr-staging.ts`, on `test/load-sim-qr-staging`. Staging-only by construction:
refuses unless the Supabase URL carries the staging ref AND the worker host is staging.

**It produced a finding before any measurement: `POST /api/orders` REFUSES an order with no
established table session** — 403 *"This table has been closed. Please scan the QR code to start a
new session."* So the flow cannot be load-tested by posting orders directly; each simulated
customer must first walk the real QR path and hold a session token. **That leg is not implemented,
so there are no latency figures at 400 and none are claimed.**

Also found: the tab-contention phase targeted `tables+1`, which does not exist on the staging test
restaurant, so it returned 404 rather than exercising the index. The staging test restaurant's real
tables are 1, 2, 120, 1001, 5001-5006, 9129, 9137, 9563, 9761, 9895, 9903 — only 120, 1001, 5006,
9761, 9895, 9903 are `active: true`.

## 5. #270 FILED — post-order customer feedback, spec only

Not started, as instructed. The three constraints that make it non-trivial are recorded: there is
no customer identity or address anywhere (#244, zero `customer_email` matches repo-wide); "after
the order is done" has three non-equivalent candidates (`completed` / `paid` / tab `settled`) at two
different grains; and any email-capable answer must land #244's guard in the same change.

---
---

# CHECKPOINT — 2026-08-12 late. Staging cleaned, #265 migration applied, order editing NOT started.

## STATE

    production / origin/main   c0bee8b   unchanged
    origin/cloudflare-staging  6167f5d   unchanged (nothing deployed)
    staging DB                 20260812130000 APPLIED + ledger repaired
    open issues                120  (#270 feedback spec, #271 load results filed)

## 1. STAGING CLEANED

Restaurant-scoped, leaves-first, using the sim's own `ls*` session marker so pre-existing rows were
never in range.

    order_requests   1564 -> 18     (1546 synthetic deleted)
    tabs              137 -> 93     (44 created today, none referenced by an order)
    orders            198 -> 198    UNCHANGED
    tables occupied     - -> 0

## 2. #265 MIGRATION APPLIED TO STAGING, code NOT deployed

`20260812130000_tabs_pin_reset_token.sql` applied via `safe-supabase-linked`, ledger repaired
(`db query` does not write it). **Verified by behaviour, not the ledger:** selecting
`pin_reset_token, pin_reset_token_expires_at` returns HTTP 200.

Note `migration repair` GLOBS THE FILE FROM DISK — it fails with `LegacyMigrationFileNotFoundError`
if the version is not present in `supabase/migrations/`. The file had to be placed in the working
tree for the repair and removed afterwards. Worth knowing before the next repair on a branch that
does not carry the file.

**The deploy did NOT happen.** Cherry-picking `7826624` onto staging conflicts on
`app/api/tabs/[tabId]/join/route.ts` — staging does not have #262's containment (`if (pinRequired)`
at main's `:94`), and #265 edits that same function. So #265 cannot land on staging alone; it needs
the containment commit first, then itself.

Aborted rather than resolved. That file is the PIN gate on an auth path, and resolving a conflict
there thin, late, and unverified is the exact "worse than none" case. Cherry-pick aborted, worktree
clean at `6167f5d`.

**Consequence for the morning: there is no PIN-recovery flow to click-test.** The migration being
applied is harmless on its own — two nullable columns and a partial index, read by no deployed code,
and NOT in #262's anon grant list so anon cannot see them.

## 3. LOAD RESULTS FILED — #271

No breaking point below 400. Flat latency 25->400 (p50 2063 -> 1743ms), 6.5 orders/sec sustained,
zero failures at the top rung, connection ceiling never reached. Baseline **~1.7-2.0s p50 is the
finding** — it is the floor, not congestion.

#127 reframed by measurement: a QR order is an `order_request` with NO order_number; the number is
allocated at staff Accept. **Customer load cannot collide it.** #218 fires **39 of 40** under
simultaneous scans at one table.

Dashboard keep-up NOT measured — the harness queried the wrong table and its own number is an
artifact; said so on the issue rather than reporting it.

## 4. ORDER EDITING — investigated, NOT built. Stopped deliberately.

The human's instruction: *"If you run low on context, STOP and checkpoint rather than half-building
the lock."* Taking it.

**What the investigation established, and it changes the design:**

- **There is no customer-facing edit path today.** No PATCH/PUT on `app/api/orders/[orderId]`; only
  staff `order-requests/[requestId]/{review,accept,decline}`.
- **Two staff devices are ALREADY protected for `status`.**
  `app/api/orders/[orderId]/status/route.ts:115` does `.eq('status', expectedCurrentStatus)` — a
  real database compare-and-set. The loser gets **409 "Order status changed; refresh and try
  again"**, and the dashboard uses this route at all three call sites. **Not last-write-win.** The
  lock has a foundation to extend rather than invent.
- **The gap is real and narrow:** the CAS is applied only when `status` is in the patch. A
  `payment_status`-only patch skips it deliberately (comment at `:105-107`) and IS last-write-win.

**Still open, for whoever picks it up:** the edit lock itself (3-minute expiry, staff-wins on
simultaneous fire), the re-acceptance branch when the total changes, the dashboard indicators, and
the decision on whether `payment_status`-only patches come under the CAS.

---

## FINAL — #272 diagnosis corrected; builds NOT started, stopped on context

**#272's mechanism is a denylist/allowlist mismatch, not a missing filter.** My first diagnosis was
wrong. `isCustomerMenuItemVisible` (`lib/supabase/menu.ts:160-163`) admits everything except
`hidden`; `isChargeableMenuStatus` admits only `available`/`active`. The gap is every other status
(`inactive`, `out_of_stock`, `archived`, and anything added later). Correction posted on the issue.

Right fix: ONE shared predicate used by both sides, not a second copy of the rule in the query.

**Confirmed, not assumed:** `invalidateMenuCache` exists at `lib/cache/menu-cache.ts:35` and the
admin item write path (`app/api/admin/menu/items/route.ts`) NEVER CALLS IT — the cache gotcha is
real. Subcategory grouping already skips empty groups (`if (items.length === 0) continue`); the
CATEGORY list route was not read and still needs checking.

**NOT STARTED, deliberately:** #272 implementation, #273, order editing, unpaid-tab-elsewhere flag.
Stopped on the human's standing instruction rather than half-building the order-status lock. No
uncommitted edits anywhere; nothing half-applied.

---

## #272 SHIPPED TO STAGING — `2d77fe4`, verified two-sided on the deployed worker

**Branch** `fix/272-menu-status-parity` · **commits** `28b5dc1` (fix) + `2d77fe4` (lint) ·
**base** `6167f5d` · staging fast-forwarded, `/api/version` cache-busted reads `2d77fe4`.
Nothing to production.

### The premise was true, and the measurement narrowed it

Cappucinno IS `inactive` on production Riviera — read with the anon key through the same path
a customer's browser uses: `7e70e5cf`, N$45, category **Hot Bevs**, siblings Americano
(`active`) and coffee (`available`). Two corrections to the brief, both measured:

- **The gap holds TWO items on Riviera, not one.** The second is **Duck Confit, `out_of_stock`,
  N$380**. Status distribution across Riviera's 198 items: 193 `active`, 2 `hidden`,
  1 `out_of_stock`, 1 `available`, 1 `inactive`.
- **Cappucinno has `has_sizes: false`.** The size options the brief describes come from the
  legacy `variants` column, not `has_sizes` — consistent with #200's finding that
  `variant_groups` is inert and `variants` is what customers actually see.

### What shipped — three parts, plus one the parts made necessary

1. **`lib/menu/menu-item-status.ts`** — one table, both answers per status. `visible` and
   `chargeable` are declared together, so a new status cannot be given one and silently
   inherit the other. Unknown fails closed on both sides, which matters because
   `menu_items.status` has **no CHECK constraint** (`schema.sql:502`, DB default `'active'`
   while the admin UI writes `'available' | 'out_of_stock' | 'hidden'` — `'inactive'` is not
   in the UI's vocabulary at all, which is why it could only have been set out-of-band).
2. **`invalidateMenuCache` on all five `menu_items` writes** in
   `app/api/admin/menu/items/route.ts` (POST insert, PATCH update, DELETE hard + soft-hide).
   Wrapped so a Redis failure can never lose a saved menu edit.
3. **Category list: checked, and the brief's premise does not fire.** Measured on Riviera:
   **zero categories empty** under the tightened filter, and zero are empty today. See the
   separate finding below — the fix that looks obvious would be a regression.
4. **`handleAddToCart` guard** (`browse/page.tsx`). Not scope creep — it is what makes part 1's
   choice honest. See the ruling below.

### THE ONE DECISION I MADE, AND WHY — `out_of_stock`

A single strict allowlist (`available | active` on both sides) would have deleted a
**deliberate, pre-existing affordance**: three render sites in `browse/page.tsx` give
`out_of_stock` a red "Out of stock" badge and a disabled Add button. Under the contract's
*"a recorded decision is a ruling already made"*, deleting that is not mine to do — so
`out_of_stock` stays **visible and not chargeable**, and Duck Confit keeps its badge.

**But that affordance was advisory only, and that is the part that had to be fixed.** The
disabled Add button is bypassed by any item with sizes/addons, which routes to
`ItemDetailModal` — whose Add button has **no status guard at all**. So the guard went into
`handleAddToCart`, the single funnel both paths pass through. It tests `!isChargeable` rather
than "is display-only" deliberately: for the `TTL.MENU` (600s) window after an edit, a cached
payload can still carry an item that is no longer visible, and that must not be addable either.

**If you want `out_of_stock` hidden from the menu entirely, it is a one-line change** — flip
`out_of_stock` to `visible: false` in the table. That is your call, not mine; it changes what a
customer sees.

### PROOF

**Regression.** `__tests__/menu-item-status-parity.test.ts` drives the **real** menu query and
the **real** pricing function with only Supabase faked, and asserts the relationship between
their two answers — it never restates the rule (the #205 failure mode). Reverting **only** the
browse predicate, keeping the shared module the test imports (the `Tests: 0 total` trap), turns
**12 of 19 red**, including `parity for status "inactive"` **by name**. Restore verified by
**blob identity** `f707ba2c…`, index empty.

**Integration, two-sided, on the deployed worker.** Same URL, same item, same DB row; the only
variable is the deployed commit:

| worker | items served | Cappuccino |
|---|---|---|
| `6167f5d` unfixed | 9 | **`[inactive] Cappuccino` SERVED** |
| `2d77fe4` fixed | 8 | **NOT SERVED** |

**Compiler.** `node node_modules/typescript/bin/tsc --version` = 5.9.3, exit 0 unpiped. Proven
two-sided: a deliberate type error in the new module gives **exit 2** naming
`menu-item-status.ts(101,7)`, and 0 on restore — so the green means something.

**BASELINE — the inherited number was stale.** The contract says staging is 6 suites / 13 tests.
Full serial run at my commit: **7 suites / 14 tests**. Rather than accept the mismatch I
re-measured **at my own base ref** `6167f5d`: the **same 7 suites, same 14 tests**, identical by
name (`apk-terminal`, `payment`, `push-to-terminal-merchant-order`,
`push-to-terminal-race-and-trim`, `schema-constraints`, `supabase-schema`, `web-routing` — all
live-HTTP). **Zero new failures. The true staging baseline at `6167f5d` is 7/14; the contract's
6/13 should be updated.** 19 hermetic suites / 163 tests covering everything touched: all green.

### PROOF CEILING

`STAGING` for the filter — **ACHIEVED**, on the deployed worker.

`STAGING` for the cache invalidation — **NOT achieved. Gap stated rather than papered over.**
The after-probe returned 8 items because the Redis entry had **expired naturally** (>10 min at
TTL 600s), not because invalidation ran. **CEILING BLOCKED BY: obtainable** — it needs one
authenticated menu edit through the admin UI as an owner of the staging fixture restaurant.
`STAGING_TEST_PASSWORD` does not authenticate `flashtap.staging.test@gmail.com` (that account IS
an owner, `5a6406e5`; the password belongs to another account), and I did not guess at
credentials. **This is step 3 of the click-test below** — you are the owner, and it takes 30
seconds.

### SEPARATE FINDINGS — proposed issues, not filed

1. **Category chips render for categories with zero visible items, and the obvious fix is a
   regression.** `browse/page.tsx` gets chips from `getSupabaseCategories`, a **direct anon
   Supabase query from the browser** — not the terminal-auth `categories` route, which has
   **zero callers**. Its embed is `menu_categories -> menu_subcategories -> menu_items`, which
   **structurally cannot see items whose `subcategory_id` is null**. Filtering chips on that
   payload would therefore hide any category whose items are all uncategorized — worse than the
   cosmetic problem it fixes. Tapping an emptied category shows "Menu coming soon!". Blast
   radius today: **zero categories** on Riviera. Family of **#224/#246**.
2. **`getSupabaseCategories` does not filter `active`.** `deleteSupabaseCategory` soft-deletes
   via `active: false` and this query ignores it, so a soft-deleted category still renders a
   chip. Zero on Riviera today (0 of 30 inactive), so latent.
3. **`/api/cache/menu/invalidate` is unreachable for restaurant owners and fails silently.**
   `menu-management-v2.tsx` calls it from 9 sites **with no Authorization header**, and the
   route is gated `requireStagingPlatformAdmin` — 404 in production, 401/403 on staging. The
   `fetch` result is never checked. It has been a no-op for every real user; part 2 of this fix
   is what actually invalidates now.
4. **`getSupabaseMenuItems` (`menu.ts:118`) has zero callers.** Dead.
5. **`ItemDetailModal` has no status guard of its own.** Fixed at the funnel here; the modal is
   still unguarded if another caller is ever added.

### CLICK-TEST — staging, and read this first

**Riviera is a PRODUCTION restaurant. It does not exist on staging, and neither does
Cappucinno.** `.env.test`'s `RIVIERA_URL` points at the staging *worker*, which is what made it
look otherwise. So the pass condition as written — "Cappucinno is gone from Riviera's menu" —
**cannot be observed on staging at all**, and nothing deployable to staging would make it
observable. I seeded the equivalent condition instead: staging's own **Cappuccino**
(`d13186c1`, restaurant "staging test") is now `inactive`, exactly as Cappucinno is on Riviera.

**URL** —
`https://flashtap-staging.llosperofficial.workers.dev/menu/a1999166-ddfa-40d1-ad1f-2f01282a1652/browse?table=1`

1. Tap the **drinks** category.
2. **PASS: "Cappuccino" is not in the list.** You should see 8 drinks — Coke (600ml), Flat
   White, Iced Coffee, Orange Juice, Rock Shandy, Rooibos Tea, Sparkling Water, Still Water.
   Flat White and Iced Coffee are still there, so a blank list means something else broke.
   **FAIL: Cappuccino still listed** — with or without a price, greyed or not. Being refused at
   Add to Tab is also a FAIL; the point is that it must never be offered.
3. **The cache half** (the part I could not prove): sign in as owner, set any drinks item to
   Hidden in the menu editor, then reload the customer menu **immediately**. PASS: it is gone at
   once. FAIL: it lingers for up to 10 minutes — that means `invalidateMenuCache` is not firing
   and part 2 did not land, even though the filter did.

**To revert the staging seed:** set Cappuccino (`d13186c1`) back to `available`. It was
`available` before I touched it; nothing else on staging was changed.

### PRODUCTION — not touched, and what it needs

The fix is on staging only. When it is promoted, the same two production items are what change:
Cappucinno disappears from Hot Bevs, and Duck Confit keeps its "Out of stock" badge but can no
longer be added via the sizes/addons modal.

### NOT STARTED, per instruction

#273, order editing, the unpaid-tab flag. Untouched.

---

## #272 PROMOTED TO PRODUCTION — `9dcf401`, closed on the live close condition

`origin/main` `c0bee8b` → **`9dcf401`**. Production `/api/version` cache-busted, three probes,
all `9dcf401`. #272 CLOSED. New issue **#274** filed.

### Close condition, verified on the live customer endpoint

```
=== Riviera / Hot Bevs — HTTP 200, 2 items ===
   [active] Americano
   [available] coffee
>>> Cappucinno: GONE — PASS <<<
```

Americano and coffee still serve, so the category is intact rather than emptied.

### THE CORRECTION THAT MATTERED — Duck Confit does NOT disappear

The instruction to promote accepted, as a cost, that "Duck Confit (out_of_stock, N$380)
disappears from Riviera's menu under this fix as well." **That is not what the fix does**, and
it was corrected before dispatch rather than after. `out_of_stock` is
`{ visible: true, chargeable: false }` — the ruling recorded in the previous checkpoint.
Confirmed on production after the deploy:

```
   [out_of_stock] Duck Confit      <- still rendered, greyed, as designed
```

So the product outcome the instruction was reluctantly accepting is the one that was already
shipped. The question was filed anyway, reframed to match reality, as **#274** — *should an
out-of-stock item render greyed or disappear?* Option B is a one-line flip plus a test update
plus deleting three render sites; the issue says so.

**Generalisation worth keeping:** a stated willingness to accept a cost is not evidence the cost
exists. Check the shipped table before accepting a consequence attributed to it.

### Promotion method — the gate, in the order it was run

`main` is built by cherry-pick and diverges in both directions, so "it applied cleanly" proves
nothing on its own. What was actually established:

1. **Base parity, per file.** All five files touched are **byte-identical between `6167f5d`
   (my staging base) and `origin/main`** — `menu.ts` `b668131`, `calculate-order-pricing.ts`
   `e9aee19`, admin items route `b001a54`, `browse/page.tsx` `e638209`, `menu-cache.ts`
   `309f61d`. The patch lands on the ground it was written against.
2. **Result parity, per file.** After cherry-pick, all six changed files are **byte-identical to
   `origin/cloudflare-staging`** — the exact tree that was click-tested.
3. **Patch-id.** `e828eb4f6effc3e2df9ed15f167e07b7d65dae65` on both branches.
4. **Base-conditional claims read against `main`**, since no mechanical gate can catch a comment
   that is true on one branch and false on another: `ItemDetailModal` has no status guard on
   main (0 hits), `next.config.mjs` rewrites Riviera to the bare UUID, `schema.sql:502` is
   `"status" "text" DEFAULT 'active'` with **no** `menu_items_status_check`, and
   `renderAddButton` still handles `out_of_stock`. All four hold.
5. **Gate:** `node node_modules/typescript/bin/tsc` 5.9.3 exit 0 unpiped · `npx eslint .
   --max-warnings=0` exit 0 · 15 hermetic suites / 139 tests green · **drift 128/128 OK against
   production**, exit 0 unpiped · no file under `supabase/` touched.

### RULE 11 IS NOW STALE — #269 landed

Rule 11 says `origin/main:scripts/check-migration-drift.mjs` is the TWO-state version and that
porting `76153d8` is an open gap. Measured on `main` today:
`grep -c targetEnvironment scripts/check-migration-drift.mjs` → **2**, and the run self-reports
`target=production`. **Main now has the three-state, environment-scoped version.** The rule's
incident has closed; per the document's own standard ("delete the rule when the incident stops
being possible") Rule 11 should be rewritten as history or removed, not inherited as live
guidance. Rule 10 (invoke the copy inside the worktree you are auditing) is untouched by this
and still bites.

### The one gap, stated again rather than quietly dropped

**Cache invalidation is proven by test and by reading, not by a live invalidation event.** The
staging after-probe returned 8 items because Redis had **expired naturally** at `TTL.MENU` 600s.
Established: five call sites, they compile, and the cache key matches the customer URL's
restaurantId (Riviera rewrites to the bare UUID). Not established: an observed invalidation.
Closing it needs one authenticated admin menu edit plus an immediate customer reload — noted on
#272 rather than left implicit.

### Staging seed — still in place

Staging's Cappuccino (`d13186c1`, restaurant "staging test") remains `inactive` from the
click-test. It was `available` before; revert whenever the fixture is wanted back to normal.
Nothing else on staging was changed.

### State at handover

| | |
|---|---|
| `origin/main` | `9dcf401` |
| production `/api/version` | `9dcf401` (cache-busted ×3) |
| `origin/cloudflare-staging` | `2d77fe4` |
| `origin/docs/agent-operating-contracts` | this commit |
| unpushed, all local branches | zero |
| #272 | CLOSED · #274 filed |

### NOT STARTED

Order editing (next session, brief to follow), #273, the unpaid-tab flag.

---

# CHECKPOINT — 2026-08-13. ORDER EDITING BUILT AND ON STAGING (#276). Written assuming total context loss.

## STATE

    origin/main / production      9dcf401   UNCHANGED (probed cache-busted x2)
    origin/cloudflare-staging     2d77fe4 -> 1b273bd
    staging /api/version          1b273bd   (cache-busted x3)
    staging DB                    20260813120000 APPLIED + ledger repaired
    unpushed, all local branches  zero (positional form, two-sided control: 114)
    worktree                      wt-order-edit, branch feat/order-editing-lock

Three commits: `ae9c65e` the feature, `d3eba56` the four-scenario probe, `1b273bd` the
re-acceptance ruling recorded.

## WHAT IT IS, in one paragraph

A customer may change an order only before preparation starts; once preparing, editing is closed
permanently for that order. The lock is `edit_lock_token` / `edit_lock_session_id` /
`edit_lock_expires_at` on BOTH `orders` and `order_requests` (migration `20260813120000`), 3-minute
TTL. Every write is a conditional UPDATE: acquire is CAS'd on the token observed a moment earlier,
commit is CAS'd on the caller's own token plus the status and payment allowlists. Customer routes
are `POST` / `PATCH` / `DELETE /api/guest/orders/[orderId]/edit`.

## DECISIONS THAT MUST NOT BE RE-DERIVED

**1. STAFF WINS is one line, not a policy.** `PATCH /api/orders/[orderId]/status` NULLS
`edit_lock_token` whenever it moves an order out of `{pending, accepted}`. The customer's commit is
an UPDATE conditioned on that token, so an edit in flight matches zero rows and is refused. Nothing
in any staff path CONSULTS the lock — a staff status change is never blocked, delayed or queued
behind a customer. If you find yourself adding a lock check to a staff route, that is the ruling
being reversed.

**2. Re-acceptance: ANY total movement, and only NOTES are exempt.** RULED by the human 2026-08-13.
The original brief said "removing items or changing notes only — no re-acceptance", which cannot
hold alongside "an edit changing the TOTAL requires staff re-acceptance", because a removal changes
the total. It was surfaced as a contradiction rather than silently resolved, and ruled: a removal
changes what the kitchen makes and what the customer pays, so staff see it before cooking. The
tempting simplification `return nextTotal > previousTotal` in `editRequiresReacceptance` was
CONSIDERED AND REJECTED — there is a named test that fails if it is ever substituted.

**3. order_requests amendments get their OWN columns.** `20260726100000_order_requests.sql` records
in the table definition that `items/subtotal/tax/total` are "never mutated after insert (audit
trail)". That is a recorded decision and it was honoured: the customer's amendment goes to
`items_customer` / `*_customer`. Precedence is `reviewed ?? customer ?? original`, in ONE place —
`lib/orders/order-request-pricing.ts` — imported by the Accept route, the guest query mapper and the
dashboard card, which previously carried three copies of the two-tier version.

**4. A customer edit DOES null a stale staff review** (preserving it in `edit_history` and setting
`requires_reacceptance`). Not an oversight: Accept reads `items_reviewed` FIRST, so leaving a review
of the previous item list in place would silently discard the customer's edit and charge them for an
item they just removed. That is money-facing; a re-review is recoverable, a wrong charge is not.

**5. Reductions are re-summed from the order's OWN priced lines, never repriced against the live
menu** (`lib/orders/reprice-priced-lines.ts`). `calculateOrderPricing` is right everywhere a
customer CHOOSES items, but an edit is not a new order: repricing survivors would move the price of
items the customer is keeping, and would throw `UnmatchedMenuItemError` if any survivor had since
gone `out_of_stock` — refusing a removal for a reason unrelated to the removal. Quantities may only
FALL; raising one is refused because it would route around the stock check, the quantity cap and the
payment-method allowlist that `POST /api/orders` runs. "Order More Items" already places a new order.

**6. Editing is closed while money is settled OR in flight.** The `payment_status` allowlist is
`{pending, cash_pending}` (allowlist, not denylist — #124's shape). A live `payment_checkout_url`
also closes it even though payment_status is still `pending`: that Finatic session was created for
the OLD total, and the webhook is the sole confirmation QR payments have.

**7. `payment_status`-only patches are now under the CAS.** They were last-write-win by explicit
comment. The claim matches the value that was READ, so a repeated Mark-as-Paid still succeeds; only
a payment_status that moved to something DIFFERENT loses, with 409 "Payment status changed". A NULL
payment_status needs `.is('payment_status', null)` — `.eq` never matches NULL, and without that
branch every order with no payment_status would 409 forever.

## THE HOLE THIS FEATURE OPENED, AND CLOSED — read before touching guest reads

`edit_lock_token` is a CAPABILITY: whoever holds it can commit an edit. Every guest read path uses
`select('*')`, and `guestCanAccessOrder` deliberately admits an OPEN order on `table_number` ALONE —
correct for a read on a shared table, and the reason a second diner could otherwise fetch someone
else's order, read the token out of the JSON, and edit their order despite the edit route's own
session check.

`redactGuestOrderRow` (in `lib/guest-orders/validation.ts`, NOT queries.ts) strips it at all five
row exits and substitutes `edit_lock_held: boolean`. It lives in validation.ts because queries.ts
builds a Supabase client at import time, which turns any hermetic suite importing it into
`Tests: 0 total`. The staging probe asserts the token never appears in a read body.

The edit route's own auth is the session id matched against `session_id` OR `member_session_id` —
deliberately NOT `guestCanAccessOrder`, because table-number binding is wrong for a WRITE. A
non-owner gets 404, not 403, so the response cannot confirm an order exists at that id.

## PROOF

- `node node_modules/typescript/bin/tsc` 5.9.3 exit 0 unpiped · `npx eslint . --max-warnings=0`
  exit 0 · `npx tsx scripts/check-migration-inline-check.ts` exit 0 (the BLOCKING gate)
- 3 new suites, 74 tests. 7 suites / 102 tests green including the 4 pre-existing suites covering
  the Accept precedence refactor. **No new failure by name.**
- **Three two-sided probes, each restored and re-verified green:** removing
  `.eq('edit_lock_token', ...)` from the commit → 1 test red; disabling the lock-nulling in the
  status route → 2 red; substituting the rejected `nextTotal > previousTotal` → 2 red. Each
  substitution was ECHOED before the run (a probe that silently matches nothing looks exactly like a
  fix that works).
- **`scripts/probe-order-edit-lock-race-staging.ts`, exit 0 against the DEPLOYED worker.** Four
  scenarios. A: staff-first → commit refused 409 `preparation_started`, items UNCHANGED (2 lines,
  N$225), `customer_edit_count` 0, lock cleared, re-open refused. B: customer-first → N$225→200, back
  to `pending`, `requires_reacceptance`, `total_before_edit` 225, then re-accept→start works and the
  edit record SURVIVES it. C: true race → forbidden state (preparing AND edited) asserted impossible.
  D: two sessions → 409 `locked_by_other`, holder can renew, lock passes on after release.

**Why the probe has deliberately-ordered scenarios and not just a race.** Its first version raced
and passed, having fallen customer-first — so it never touched the direction the ruling is about. A
nondeterministic test of an asymmetric rule proves the asymmetry only half the time. Scenario C still
falls whichever way it falls; A is what proves STAFF WINS.

**Scenario B corrected a wrong ASSERTION, not a wrong behaviour.** After a total-changing edit the
order is `pending`, so staff get **400 "Invalid transition: pending → preparing"** — pending→preparing
was never legal in `isValidStaffStatusTransition`. Staff must Accept the new figure first. That is the
re-acceptance requirement being enforced by the existing transition table rather than by anything this
feature added.

## STAGING DRIFT IS RED, AND WAS BEFORE THIS WORK — do not attribute it here

    132 local / 133 applied     both counts moved by exactly ONE
    LOCAL_NOT_APPLIED   20260811120000   (restaurant_terminals_status_check live vocabulary)
    APPLIED_NOT_LOCAL   20260809120000
    APPLIED_NOT_LOCAL   20260812130000   (#265 PIN reset token — expected, see prior checkpoint)

`20260813120000` is in NEITHER failure list. Staging's gate is `continue-on-error: true`
(`.github/workflows/staging.yml`), so it did not block; production's is BLOCKING, which matters
whenever this is promoted. The three above were left alone deliberately — `20260811120000` is a CHECK
constraint on the table that gates terminal authentication, and applying it is a separate task.

**"Drift clean" was NOT claimed and must not be recorded as claimed.** What was established is that
this migration contributes zero drift.

Two tooling notes earned here. `node scripts/check-migration-drift.mjs` under Git Bash dies with a
libuv assertion at exit and returns a garbage code (`-1073740791`, `127`) — run it from PowerShell if
the exit code matters; the TEXT is what counts either way. And the CLI needs more than `project-ref`
to work in a fresh worktree: copy `linked-project.json`, `pooler-url`, `postgres-version`,
`rest-version`, `gotrue-version`, `storage-version`, `storage-migration`, `cli-latest` from the main
checkout's `supabase/.temp/`, or `db query --linked` fails with `LegacyDbConfigIpv6Error`.

## OPEN, and owned by the human

- **COPY IS PLACEHOLDER.** 17 strings, ALL in `EDIT_COPY_PENDING` (`lib/orders/edit-lock.ts`), each
  prefixed `PENDING COPY — `. Nothing else in the feature holds copy. The human has asked NOT to have
  copy drafted until they have seen the placeholders on a real screen. Do not draft it.
- **~~NO GITHUB ISSUE EXISTS for order editing.~~ CORRECTED, same session: #276 FILED.** All 200
  issues plus a full-text search had confirmed none existed — the feature was built from a chat brief
  directly. The human's instruction on being told: *"Built from a chat brief with no tracker entry is
  the same shape as work living on one disk."* **#276** now carries the whole feature scope (lock
  columns, staff-wins, the 3-minute expiry, the re-acceptance rule with removals NOT exempt, the
  hole-that-was-closed, the proof, and the 17 copy strings). **#275** filed alongside it for the raw
  `Invalid transition: pending → preparing` staff string — predates this work, refusal is correct,
  only the wording is wrong, and it is deliberately a separate issue so nobody "fixes" it by relaxing
  `isValidStaffStatusTransition`. Cross-linked both ways.
- **`staging.yml` wiring NOT done, deliberately** — the human wants to see the feature behave before
  the probe becomes a gate. When it is wanted, the existing race-probe jobs are the pattern
  (commit-message trigger).
- **Click-test in progress by the human:** scenarios 1, 2, 4, 6, 7 of the step list (pre-Accept edit,
  post-Accept edit + re-accept, closed-once-preparing, the two-device collision, two phones one
  table). 3 (notes-only), 5 (expiry) and 8 (money) deferred unless something looks off.
- Staging's Cappuccino (`d13186c1`) is STILL `inactive` from the #272 click-test.

## WHAT WAS NOT TOUCHED

Production. `origin/main` is `9dcf401` and was probed cache-busted twice after the work. No file
under `.github/` changed. #273, #274, the unpaid-tab flag, and the three pre-existing drift entries
are all untouched.

---

# CHECKPOINT — 2026-08-14. Autonomous run: 19 commits, staging drift CLEAN, #262 closed on staging.

## STATE

    origin/main / production      9dcf401   UNCHANGED (probed cache-busted)
    origin/cloudflare-staging     1b273bd -> b3d5c6d   (19 commits)
    staging /api/version          b3d5c6d   (cache-busted x3)
    staging DB drift              135 local / 135 applied — OK, CLEAN
    unpushed, all local branches  zero (positional form; control: main-not-on-staging 114)
    dirty worktrees               ov-i-179 only (2 files, another session's, untouched)

## THE HEADLINE: STAGING DRIFT IS CLEAN

Red all day and for weeks before that — long enough that `.github/workflows/staging.yml`
made the check `continue-on-error: true` to work around it. Three entries, each resolved
differently:

| version | was | resolved by |
|---|---|---|
| `20260812130000` | APPLIED_NOT_LOCAL | the #265 cherry-pick brought the file |
| `20260811120000` | LOCAL_NOT_APPLIED **and a version collision** | mirroring `a6bb436`, then landing #262's migration at the freed version |
| `20260809120000` | APPLIED_NOT_LOCAL | committing #127's index with `-- @env: staging` |

**Production's gate is BLOCKING where staging's is not**, so this matters for any promotion.

## #262 IS CLOSED ON STAGING — the exposure is gone

Four commits, in the order main used: containment → anon-count → seam → migration.

Decisive probe, live staging DB with the PUBLISHED anon key:

    BEFORE  select id,members  -> 200, real session ids incl. session_1782915071979_mo80796cpyk
    AFTER   select id,members  -> 401 42501 permission denied
            select customer_name -> 401 42501
            select id,status,table_number -> 200 (still works)

The third probe matters as much as the first: the grant is NARROWED, not revoked.

## THE SEAM CONFLICT — resolved, and it corrected a false comment

`9fcb147` conflicted in `lib/guest-orders/queries.ts` (4 regions) because that file had changed
three times the same day. Both sides were read-time redactions and **neither replaced the other**:

    redactGuestOrderRow        strips edit_lock_token — a CAPABILITY (commit an edit)
    redactGuestOrderMemberIds  substitutes member_session_id with an opaque per-tab key

Resolution: `mergeById` → `redactGuestOrderRow` per row → `await redactGuestOrderMemberIds`.

**The seam's own comment was corrected rather than inherited.** It claimed the redaction stopped a
known payment reference reading back "another diner's session id". It does not: it rewrites
`member_session_id` ONLY, and skips rows with no `tab_id` — measured, **104 of 213 staging orders
(49%)**. Since the cart writes one value into both columns, the raw value still leaves in
`session_id`. Filed as **#282**.

## THE SESSION-ID CLASS — root fixed, all ~12 sites converted

Three bugs in one day from one cause. Now: **one helper, one predicate, no site restating either.**

    heldSessionIds()   lib/tab-storage.ts   every id THIS BROWSER holds; read-only, never mints
    ownsOrder(row,ids) lib/guest-orders/validation.ts   every id x BOTH placer columns

`guestCanAccessOrder` — the root, which compared one id against one column and never looked at
`member_session_id` — now delegates. Widening measured before shipping: **0 of 213 staging / 0 of
1000 production** rows have a differing `member_session_id`.

Converted: the by-id read (client + route + query), by-session (both row paths, both tables),
active-table (client + route + query), the confirmation page, kiosk-success, ActiveOrderBanner,
menu-order-status-tracker (which had a FOURTH private copy), useActiveOrders, useActiveTableOrders.

**Two `.in()` merged in JS, never `.or()`** — client ids in a parsed filter string is #242/#254.
`countOnly` stays single-column with the measurement recorded beside it, because counts return a
number with no ids and summing double-counts.

**THE CANARY.** `order-confirmation/[orderId]:118` only resolved via the table_number branch. Before
shipping, against the deployed worker: session id alone with NO table_number **resolves**; wrong
session with no table is **refused**. So the session branch carries real traffic on its own — the
measurement #279's narrowing needed.

## CSPRNG (#277)

`ensureTabSessionId` minted `session_${Date.now()}_${Math.random().toString(36).slice(2)}` — and
`ownsOrder` makes knowing that id the whole authorisation. Now `crypto.randomUUID()`, prefix kept,
**new mints only**. It does NOT silently degrade: `getRandomValues` is the fallback and with neither
it THROWS, because a security fix quietly falling back to Math.random would reintroduce the defect
invisibly. Human's rulings recorded on the issue: age out don't rotate · no format refusal in
ownsOrder · second factor for edit-acquire later.

## ALSO SHIPPED

- **#273** — the pricer names the item, not its UUID; two distinct refusals; all offending lines at
  once; a CODE so the two verification scripts stop matching on prose.
- **My Orders was unreachable.** The button labelled "My Orders" pointed at `/cart` and always had;
  nothing navigated to `/menu/[id]/my-orders`. Button is now **Cart** (keeping its badge), with a
  separate **My Orders** entry on the browse header and on the cart's empty state — the screen a
  customer lands on right after ordering.
- **#211** landing fix cherry-picked (patch-id SAME).
- **Unpaid-tab-elsewhere flag** — migration `20260814090000`, link recorded and VALIDATED at
  creation, staff-only by construction (anon gets 42501 since #262's migration), and it clears on
  settle **without a write**: the column is a pointer and the flag renders only while the linked tab
  is still unpaid.
- **#265's PIN recovery** and **#262's containment** landed earlier in the run; the join route is
  byte-identical to `origin/main`.

## ISSUES FILED THIS RUN

**#280** drift check keys on the numeric prefix alone — two files sharing a version silence each
other; this was LIVE on two branches for three days · **#281** a migration applied to staging while
its file lived only on `wave3/payment-seq` · **#282** `session_id` leaves on guest reads and is now a
capability (design question, ruled: mitigate elsewhere) · earlier: **#277** CSPRNG · **#278** the
session-id pattern · **#279** the table_number branch.

## OPEN / NOT DONE

- **PENDING COPY**: 17 in `lib/orders/edit-lock.ts`, 2 in `lib/orders/calculate-order-pricing.ts`,
  1 in `lib/tabs/tab-flag-copy.ts`. `git grep "PENDING COPY"` returns only these.
- **#279's narrowing** is ruled but SEQUENCED — prerequisite (the consolidation) is now done and the
  canary measurement exists, so it is unblocked.
- **Nothing promoted to production.** `origin/main` is `9dcf401`, untouched all run.
- The `git checkout <ref> -- .` trap fired once mid-run and was caught by ancestry+blob comparison;
  the contract was updated (`8aafd4b`) with the reason it evades `git status`.
