# Overnight issue log — 2026-08-21

Task 5. Open issues walked newest first from **#324**. 102 open at the start.

**Stopped at #250** on your rule: `#259`, `#258`, `#251`, `#250` are four consecutive skips for the
same reason — *payments / the money path*. That is the pattern, and it is worth seeing rather than
grinding through: see [The shape of what is left](#the-shape-of-what-is-left).

**30 triaged · 1 attempted · 29 skipped.** Nothing from this task touched `main`.

---

| # | title | | why |
|---|---|---|---|
| 324 | 1315 orders rows with `restaurant_id = NULL` | **SKIPPED** | Excluded by you — a delete in a production financial table is not an overnight job. |
| 323 | Report totals truncate above 1000 orders | **SKIPPED** | Already fixed (`62b3575`, `d061682`) and deployed. **Cannot be proven on production:** no restaurant-month exceeds the cap — FNB ChowNow's worst is 695, all-time 849 — so every window returns a true count either way. Making one exceed 1000 is a write. |
| 320 | Two restaurants in one organisation | **SKIPPED** | Excluded by you — leave for a human to exercise. |
| 319 | Terminal and web app share one git remote | **SKIPPED** | **Decision needed:** split the remote, or record that they share it. The fix differs completely by answer. |
| 318 | [terminal] Ready to Pay disappears after first partial settle | **SKIPPED** | Render change in the React Native app; needs an APK build and release. Server half already live (`1f47752`). |
| 314 | 3 Playwright specs run nothing on staging | **SKIPPED** | **Needs `STAGING_TEST_PASSWORD` as a GitHub secret** — only you can create it. No code change closes this. |
| 311 | Customer waiting on an unanswered request is never told | **SKIPPED** | Needs a product ruling (what timeout, what escalation) and customer-facing copy. |
| 304 | Receipt email: caller-supplied address, no session token | **SKIPPED** | Auth — excluded. |
| 303 | The `ready_to_pay` refusal is unreachable | **SKIPPED** | **Already fixed on staging** (`d55f3a9`) and one of the four runtime files in the main↔staging gap. Promoting it is wave work, not issue work. |
| 301 | Additions bypass the `ready_to_pay` guard | **SKIPPED** | Money path — an addition landing on a tab being settled. Partly addressed on staging (`e28ff969`). |
| 298 | `basePrice` null on customer-added lines | **SKIPPED** | Money path — the receipt's fallback chain. Investigation only upstream too. |
| 289 | Ruling: "No items found" during a total menu outage | **SKIPPED** | Ruling needed, and the fix is customer-facing copy. |
| 285 | Accepted `order_request` with NULL `accepted_order_id` | **SKIPPED** | Needs a migration (the preventing CHECK), and production's state is unverified. |
| 284 | anon SELECT on `public.tabs` has no restaurant scope | **SKIPPED** | Auth + needs a migration. |
| 282 | Design question: redact `session_id` on guest reads? | **SKIPPED** | Design question, already ruled 2026-08-13. Nothing to do. |
| 281 | Migration applied to staging from an unmerged branch | **SKIPPED** | Migration/ledger. |
| **280** | **Migration drift check identifies migrations by prefix alone** | **ATTEMPTED** | **Option A was already implemented on BOTH branches** (`a507b93`); the file is byte-identical on `main` and `cloudflare-staging`. I did not take that on trust — see below. Evidence commented, left open, because **Option C is still the open half**. |
| 279 | `guestCanAccessOrder` releases an open order by table number | **SKIPPED** | Auth — excluded. |
| 274 | Out-of-stock item: greyed or gone? | **SKIPPED** | Product decision, stated as such in the title. |
| 270 | Post-order customer feedback spec | **SKIPPED** | Spec with open questions; product. |
| 268 | Webhook valid-signature path records no gateway amount | **SKIPPED** | Payments. |
| 263 | Production RLS state cannot be established from the ledger | **SKIPPED** | Migration/ledger, and production. |
| 262 | `tabs.members` publishes session_id to anon on PRODUCTION | **SKIPPED** | Auth + migration + production. |
| 260 | `docs/finatic-questions-for-vernon.md` exists on no ref | **SKIPPED** | The file's content came from Vernon; recreating it is not something I can do correctly. |
| 259 | Webhook writes unvalidated gateway text into lookup columns | **SKIPPED** | Payments. |
| 258 | QR/hosted payment with no webhook has no recovery path | **SKIPPED** | Payments. |
| 251 | `ReceiptLineItem` stores one VAT basis | **SKIPPED** | Money path. |
| 250 | Sale receipt and tax invoice disagree on VAT basis | **SKIPPED** | Money path. **← four in a row, stopped here.** |
| 247 | Category-path total failure renders a permanent spinner | **SKIPPED** | *(looked at while scanning for candidates)* Lives only on `sprint/browse-states @ 909967e`, which is **on no remote**. Nothing to fix on a branch that does not exist. |
| 245 | Verify the five inline-CHECK constraints exist | **SKIPPED** | *(looked at while scanning for candidates)* **Measured, not assumed:** `GET /rest/v1/pg_constraint` → `HTTP 404 PGRST205`. PostgREST cannot expose it, so the read-only route is closed. The alternative is a behavioural probe, which needs writes — excluded on production tonight. |

---

## #280 — the one attempt, and how it was proved

Option A (fail on duplicate versions) is implemented in `scripts/check-migration-drift.mjs` and
present on `main`, so the production deploy gate carries it. A green check is indistinguishable
from a check that never ran, so it was proved by breaking it:

- **Control** — real tree against the staging DB: `136 local, 136 expected, 136 applied` → `OK`,
  exit 0.
- **Subject** — a second file added at the existing prefix `20260811120000`, then deleted:
  `MIGRATION DRIFT CHECK: FAILED — duplicate migration version(s)`, both filenames named, exit
  non-zero. It fires *before* any count is printed, which is the point — every number below it is
  computed from a `Set` that has already dropped one of the duplicates.

Neither branch has a duplicate today: 136 distinct prefixes on staging, 132 on `main`.

**Two things it does not settle**, both in the issue comment: Option C (collision prevention at
creation) is untouched and duplicates on *different* branches stay invisible until a cherry-pick
brings them together; and on Windows the failing path aborts via a libuv assertion
(`src\win\async.c`) rather than exiting 1 cleanly — non-zero either way, so CI is unaffected.

## The shape of what is left

The skip reasons are not spread evenly, and the count is the finding:

| reason | issues |
|---|---|
| payments / money path | 301, 298, 268, 259, 258, 251, 250 |
| auth | 304, 279, 284, 262 |
| needs a migration | 285, 284, 281, 263 |
| needs a ruling or copy from you | 319, 311, 289, 274, 270 |
| needs something only you can provide | 314 (a secret), 260 (Vernon's answers), 319 |
| already fixed, waiting on promotion | 303, 323 |
| terminal / needs an APK | 318 |

**Of the 30 newest open issues, one was actionable under tonight's rules.** That is not a triage
failure — it is what the rules select for. The exclusions (payments, auth, migrations, product
rulings, copy, the promotion backlog, terminal builds) cover almost the whole live backlog, because
almost the whole live backlog is about money, permissions, or schema.

If you want more than one issue moved per night, the constraint to relax is not the issue list — it
is one of the exclusions, and the cheapest one to relax is **rulings**. Five issues (319, 311, 289,
274, 270) are blocked on a decision that would each take you a minute and none of which I can make.

## Not opened, and why

I did not walk below #250. The stop rule fired, and the band below it (#247 → #9) is dominated by
the same three categories: terminal work needing an APK (#164, #163, #162, #161, #148, #137, #136),
payments and the ledger (#268 down through #107), and launch-blockers that are already tracked
(#121, #120, #119, #117).

**No live production defect was found tonight.** Nothing in the morning report's top slot from this
task.
