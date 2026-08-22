# Where everything stands — read this one, Monday

Covers 2026-08-20 → 2026-08-22. Written to replace nine documents. Where it summarises something
with its own file, the file is named.

**Current heads:** production `main` = `9dd2d3b` · staging `cloudflare-staging` = `d0295ea`
**Gap:** 122 files, of which **19 are runtime**.

---

## 1. What reached production

Two deploys in three days. Nothing else.

### Wave 1 — infra, CI, docs, probes (`1811b0e`)

76 commits, selected by patch-id and verified **inert**: no runtime file, no migration, no workflow
affecting production. The file gap dropped 115 → 77.

The method is written up in `docs/promotion-runbook.md`, and it now carries two traps that cost real
time to find:

- **Verify by CONTENT, not commit count.** The backlog dropped 74, not the 76 promoted, because one
  commit applied partially and one applied empty. The count was the wrong instrument.
- **A clean cherry-pick is not a correct one.** Measured: `e304ddc` picks onto bare `main` with
  **zero conflicts** and lands a file **113 insertions short** of staging. Git's silence is evidence
  about textual overlap, not about dependency. Fix: compare blobs per touched file at assembly time.

### 2026-08-22 — every cancel path writes an audit row (`9dd2d3b`)

Shipped alone, ahead of waves 2–8. `bbce8cb → 9dd2d3b`, **zero migrations**, **20/20** on
`flashtap.app`, `www.flashtap.app`, `riviera.flashtap.app`.

**Why:** measured on production, paginated, with a positive control (177 of 272 cancelled orders DO
carry a row, so the absence is real) — **95 of 272 cancelled orders had no audit row of any kind**, 90
of them from the stale-order cron. The automated path was the largest single source of untracked
cancellation in the system, and it was accruing daily.

**One thing to know about it.** It was **authored directly on main, not promoted.** Staging's version
of those files also carries waves 6 and 8 — the terminal success contract, the unrecognised-status
guard, the amount-gate inversion — which change money *decisions* and are not ruled for production.
Promoting the file would have shipped them as a side effect. So the `cancelByIds` hunks **will
conflict when waves 6 and 8 land: resolve toward staging, which is a superset.** Full record in
`docs/deploy-2026-08-22-cancel-audit.md`.

**What was not proved:** that a cancellation now writes its row *on production*. There was none to
observe and none was manufactured — all 7 pending POS orders carry a gateway reference, so every one
routes to Finatic, answers E04111, and is skipped. Zero reach the cancel path. Behaviour is proved on
staging, two-sided, mutation-verified.

> **Do not read silence as failure.** The 90 rows came from orders with *no* gateway reference and
> there are currently none of those. If no new audit rows appear this week, check whether any
> cancellation happened at all before concluding anything.

---

## 2. On staging, awaiting promotion

19 runtime files. Agent D's wave plan, verified by blob-compare against `origin/main`:

**Recommended order: 2 → 3 → 4 → 5 → 6 → 8, then 7 when signed.**

| wave | what | self-contained | note |
|---|---|---|---|
| **2** | 79 test/script/doc files, **zero runtime** | yes | Cheapest win. Dissolves every test-file conflict in waves 3 and 5 before they happen. Unblocks #314 and #169. |
| **3** | #303 tab-not-open | needs wave 2 | Do not split across its two files — allowlist-without-route is the hazard. |
| **4** | Tab screen exit | yes | Purely additive. |
| **5** | five rulings + #311 copy | needs 3 and 4 | Standalone it conflicts; in order the conflicts vanish. |
| **6** | terminal success contract (#327) | yes | Largest single runtime change. Its revert restores a known-wrong contract — revert only for a NEW fault. |
| **8** | E04111 payments | **must follow 6** | Picks clean and lands wrong content alone. This is the trap above. |
| **7** | pre-launch reporting (Riviera) | yes | **Copy-blocked. Do not land on main unsigned — it blocks every production deploy.** |

**Two migrations must stay out of every wave:** `20260705210000_post_payment_order_lifecycle.sql` and
`20260705220000_refund_events.sql` carry no `@env:` header, which the drift check resolves to scope
`both` → expected on production → not applied → `exit(1)`. Committing either blocks all deploys.

**Also on staging, not in a wave yet:** today's `0d828a6` (terminal pre-gateway cancel audit — already
on production too), the `#328` staging proof, and the PayCloud key documentation.

**In the terminal repo** (`D:/RN/FlashTapTerminal`, `feat/terminal-reconciled` @ `2300402`): the
`#328` idempotency-key client change. Proved two-sided against staging — same key twice returns ONE
order, different keys return two, with both controls. **It ships only in a new APK**, which needs the
version bump (`versionCode`/`versionName`/`APP_VERSION` in step).

---

## 3. Blocked on you

### Two rulings I am holding

**1. The kiosk channel filter.** The terminal order list filters by restaurant and status only, so
kiosk and customer-placed orders appear on the till with Decline live on them — that is how Digi
Cofee #9 was cancelled. *Options: filter kiosk out of the till list / keep visible but read-only /
leave as-is.*

**2. The RLS `WITH CHECK` proof — RULED, closed.** You ruled: do not touch a real order to prove it.
It stays **closed-as-written, not as-deployed**, and is recorded that way. The column-GRANT half *is*
proven live (`total` → `42501 permission denied`; `status` accepted, exactly as the migration reads).

### Ruled and queued for next session — top of the staging queue

**Decline must not be live on a paid order — server-side refusal as well as the button.** Recorded
2026-08-22. This is the mechanism behind #456/#500/#546: Decline renders on `status === 'pending'`
and never consults `payment_status`, so it was on screen for orders the webhook had already settled.
Not started, by instruction.

### Copy awaiting sign-off — blocks wave 7 only

> `preLaunchTitle` — **PENDING COPY - figures withheld until this location opens**
> `preLaunchBody` — **PENDING COPY - orders below are test data and are not counted as revenue. Nothing has been changed or deleted.**

The constraint: a rendered `0.00` is indistinguishable from a real week with no sales, so it must say
**withheld and why**, never zero. House precedent is the last string you signed — `waiting {minutes}
min`: lowercase, terse, no full stop.

### Rulings in the issue backlog

The full set is in `docs/issue-triage-2026-08-22.md` §5. The ones that gate other work: **#324**
(1315 `restaurant_id = NULL` rows in a financial table), **#127** (the unique index cannot be added
while 3 real duplicates exist), **#289** (browse copy during a total outage).

---

## 4. Blocked on Finatic

**#107 — and it is not fixable by us.** Measured 2026-08-22 against live production `order.query`:
every response failed verification with `Encryption block is invalid.`, in an environment whose keys
are correctly *distinct*. **No key we hold verifies a production response**, including the deployed
one. The response does carry a genuine 344-character RSA-2048 signature, so there IS something to
verify — this is a wrong-key problem, not a canonicalisation problem.

**The ask is drafted and ready to send to Sedrick:** `docs/finatic-ask-trans-status-semantics.md`. It
names the artefact three ways so it cannot be misread — the **production response-signing public key
for `order.query` on merchant `342600131153`** — and includes one redacted real response.

**What follows while it stays open:** `fallback_verified_paid` is the **primary** settlement path,
indefinitely. That path needs per-restaurant credentials, so **a venue with NULL
`finatic_merchant_no` / `finatic_store_no` has no settlement path at all** — the card clears, the
signature check fails, the fallback throws, and the order shows unpaid. **Chownow Nedbank and Digi
Cofee are both in that state.** The gate is in `docs/promotion-runbook.md`.

**Also with Finatic:** whether the **N$201** on the three cancelled orders (#456/#500/#546) was
refunded or retained. Their side, not ours.

The standing note is `docs/paycloud-gateway-public-key.md`. It supersedes the old "Finatic cannot
supply it, closed as unavailable" — that framing read as *there is nothing to verify* and stopped
people looking.

---

## 5. Money moved, and money at risk

| | |
|---|---|
| **N$1106** | Nine FNB ChowNow pending orders cancelled on your direct Finatic confirmation, with fresh pre-write queries and 3/3 live controls. Re-queried afterwards — all still E04111, nothing changed. |
| **N$33** | #868 — food released against an order that never cleared. **Recorded as a write-off** in the audit metadata. |
| **N$201** | #456/#500/#546 — charged at Finatic on three cancelled orders. Refunded-or-retained **unestablished**. |

---

## 6. Test-suite health

A vacuous-test sweep ran over all 202 suites: **0 vacuous out of 164 stub-testable.** The suite
quality is genuinely good.

Three gaps filed, none fixed: **#330** (14 source-text suites unverifiable by stubbing — 9 done, all
9 caught their mutation, including all six security gates), **#331** (13 suites red at baseline, so
protecting nothing — `e04111-recovery` and `resolve-order-by-merchant-order-injection` are on the
money path), **#332** (`realtime.test.ts` is a service liveness check filed as a unit test —
recommend removing rather than repairing).

---

## 7. Open, and staying open

Recorded so they are not quietly promoted to settled facts.

- **When #456/#500/#546 and Digi Cofee #9 were flipped is unrecoverable.** No `cancelled_at`, no audit
  row, and `orders.updated_at` is NULL on all 2992 production orders.
- **Who tapped Decline was never recorded.** The pre-`c1471a7` route stored no terminal id, no staff
  id, no audit row.
- **The anon RLS `WITH CHECK` half is closed-as-written, not as-deployed** — by your ruling, and it
  stays that way.
- **106 open issues, not 109.** If you are counting 109, three are closed or live elsewhere.
- **Roughly forty issues are marked NOT VERIFIED THIS PASS** in the triage. They carry provisional
  verdicts from their titles. Do not act on them as triaged.
