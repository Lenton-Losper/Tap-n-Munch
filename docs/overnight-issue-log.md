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
