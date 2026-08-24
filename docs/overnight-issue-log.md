# Overnight log — 2026-08-24

Bookmarks for decisions I would not make at 3am. Each says what is needed and what I did instead.

---

## STOP 1 — waves 4, 5 and 7 are blocked on one promotion-scope decision

**Wave 4 cannot ship alone.** It fails the production deploy gate:

```
PENDING COPY CHECK: 1 placeholder string(s) found
  lib/customer-copy/qr-redesign-copy.ts
    :146  tabBackToMenu: 'PENDING COPY - back to the menu',
```

`cd2802e` (wave 4) introduces `tabBackToMenu` **as a placeholder**. The signed wording —
`tabBackToMenu: 'Back to menu'` — arrives in **`5bc1499`, which is wave 5** ("the five rulings of
2026-08-21"). So wave 4 depends on wave 5 for its own copy sign-off.

Its held-back test says the same thing independently: 14 of 15 pass, and the one failure is
`carries the signed-off label, and names the destination`, which asserts
`tabBackToMenu:\s*'Back to menu'`.

### Why I did not just combine them

**The string is not awaiting your decision — you signed it on 2026-08-21.** So sending you the
strings, as the standing rule says to do for unsigned copy, would be asking for a ruling you have
already made. But shipping waves 4 and 5 as one promotion changes the order you gave
(`3 → 4 → 5 → 7`), and that is a promotion-scope decision about customer-facing copy. Under the
"stop and document on any ambiguity" rule, that is yours.

### What I did not do, and why

- **Did not split `5bc1499` by hunk** to lift just the sign-off line. You authorised splitting
  `cddeb78` *by file*; splitting a commit by hunk to satisfy a gate is a different and riskier act,
  and it would put wave 5's copy ruling on production ahead of wave 5.
- **Did not ship wave 7 out of order.** Wave 7 is genuinely independent of 4 and 5 — reporting files
  plus `cddeb78`'s `order-history-content` / `reporting-copy` half — and its copy is now signed, so
  it *could* go. But you specified an order, and reordering unilaterally overnight is the same class
  of decision.

### The decision I need

**One of:**

1. **Ship 4 and 5 as a single promotion.** Nothing unsigned reaches production; wave 4's content
   still lands before wave 5's in the same deploy. Simplest, and the coupling is real.
2. **Ship 7 first**, then 4+5 together when you confirm. Gets the reporting wave out tonight.
3. **Hold all three** until you look at them.

I have prepared nothing on a branch beyond the verification above — `prod/wave4` exists locally with
`cd2802e` picked and verified (both file deltas identical to the source commit), and has not been
pushed.

### State at the stop

| | |
|---|---|
| production `main` | `f3711fb` (wave 3) |
| staging | `cddeb78` |
| shipped tonight | End Session removal `0e771de`, wave 3 `f3711fb` |
| still on staging | waves 4, 5, 7, and `939af4b` (comment-only, was to ride with the last wave) |

`939af4b` was to ship with the last wave. With the waves held, it is held too — it is comment-only
and carries no urgency.


---

## Issues skipped, and why

Worked in the triage's ranked LIVE DEFECT order. Two fixed, four skipped. **No three consecutive
skips shared a reason**, so the stop condition did not fire.

| issue | outcome |
|---|---|
| #107 | already closed earlier tonight — no key exists |
| #236 | fixed previously, on production |
| #279 | fixed previously, on production |
| **#127** duplicate order numbers | **SKIPPED — needs a ruling.** The unique index cannot be added while 3 real FNB ChowNow duplicates exist on live financial records. Renumber, partial index, or defer. |
| **#170** `document_sequences` defined twice | **SKIPPED — needs a migration.** Hard rule: no migrations tonight. Also one of the two files with no `@env:` header that blocks every production deploy. |
| **#325** Table renders 0 | **FIXED on staging.** 1640 of 2992 production orders affected. |
| **#324** 1315 NULL `restaurant_id` | **SKIPPED — needs a ruling** on live financial records: delete, backfill, or leave and exclude from reporting. |
| **#284 / #262** anon `tabs` exposure | **SKIPPED — needs a ruling.** `tabs/active` is a *recorded decision* with a written rationale; overturning it is yours, not mine. |
| **#260** citation to a non-existent doc | **FIXED on staging.** The claim was sound; re-cited to production audit rows that can be re-queried. |

### Decisions waiting in this set

1. **#127** — renumber the 3 real duplicates, use a partial index, or defer.
2. **#324** — what happens to 1315 legacy `restaurant_id = NULL` rows in a financial table.
3. **#284 / #262** — whether an unscoped anon `SELECT` on `tabs`, protected only by a column grant,
   stays as ruled.

### One thing found while fixing #325, not fixed

A single order with `channel = 'table'` and `table_number = 0`. POS legitimately has no table;
a table-channel order should not. One row, unrelated to #325's display bug, and the fix now renders
it as `—` rather than `0` — which hides it rather than surfacing it. Noted on #325.


---

## RETRACTED — the stale link is UNEXPLAINED, not fixed

I reported that `browse/page.tsx` and `tab/page.tsx` place orders without persisting
`last_order_id`, and that this caused the confirmation link to carry an older order's id.

**That is wrong.** Neither file places an order; neither even contains an `orderId`. I inferred it
from a list of write sites without checking whether those screens were writers at all.

The client-side order creators are **three**, and all three persist: `cart/page.tsx` (two sites) and
`order-secure/page.tsx`. The fourth apparent creator, `createOrder` in `lib/supabase/orders.ts:401`,
is called only by server routes.

**`lib/orders/last-placed-order.ts` is kept**, because the duplicated two-key convention was real and
a fifth screen will appear. **It is not the fix for the stale link.** The cause is open — see the
investigation below.


---

## #333 — built, with two gaps recorded rather than papered over

### 1. Not measured on production. NOT AN ABORT — the item shipped.

This worktree has **no production credentials**. `.env.local` and `.env.test` both point at the
staging ref (`mdqjpxwczrhkxkbqatqa`); the production ref is `ihlmmpmolnpchzgwyhgh`, and no key for it
is reachable here. A lookup in sibling checkouts was denied by the permission classifier and I did
not work around it.

So `scripts/probe-333-abandoned-sessions.ts` reports staging only. **The production backlog size is
unknown.** It has a production branch that runs automatically if `SUPABASE_URL` ever resolves to a
non-staging ref, so it needs no edit — only credentials.

This does not weaken the fix: the design is safe at any count, because `reap_abandoned_tab` re-derives
inactivity and refuses on money per tab rather than relying on the population looking like staging's.
What it means is that **the first production run's audit rows are the measurement** — read
`tab.reaped_abandoned` and `tab.abandoned_needs_attention` after the first hour rather than assuming
the 6/4 split carries over.

Supersedes the memory note claiming the production service-role key is in `.env.local`. It is not, in
this worktree.

### 2. `customer_sessions.last_seen_at` is a decoy column. Filed here, not fixed.

The column exists, defaults to `now()`, and is **never written by anything**. Every `last_seen_at`
hit in application code is the `restaurant_terminals` table. Verified on staging: **0 of 8** session
rows on open tabs differ from their own `created_at`.

It is exactly the column that would make "inactivity" mean what a reader assumes it means — real
customer presence rather than the last thing that left a row somewhere. Without it, **browsing is
invisible**: opening the menu, scrolling, filling a cart and not submitting leave no trace at all.

Not fixed here because touching it means **writing on a read path** — every guest GET would become a
write — and that is a decision with its own performance and contention shape, not a detail to smuggle
into a reaper. The 4h threshold and the money guard were both chosen to be safe *without* it.

This is the same class as `written-columns-are-not-selected-columns`, inverted: not a column written
and never read, but one **read as evidence and never written**. A `SELECT last_seen_at` looks
authoritative and returns the insert time.
