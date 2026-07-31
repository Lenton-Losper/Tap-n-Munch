# Recipe-tracking fix — handover for 2026-08-01

Deferred from the night of 2026-07-31. Everything below is measured from production
read-only, not estimated. Re-run `scripts/scope-recipe-tracking-20260731.ts` to refresh.

---

## ⚠️ Correction to figures in circulation

Tonight's brief referred to **"8 restaurants, 47 recipes, N$770 measured impact."** Those
numbers do not come from any measurement I took, and they don't match production. The real
figures, measured at 2026-07-31 ~17:00Z:

| | Stated | **Actually measured** |
|---|---|---|
| Restaurants | 8 | **10** (3 with any recipes at all) |
| Recipes | 47 | **23** total, all active |
| Recipe items | — | 27 |
| Affected recipes | — | **2 of 23** |
| Currently sellable | — | **0** |
| Monetary impact | N$770 | **no N$ figure was ever measured** — see below |

If the 8/47/N$770 figures come from another source, reconcile before planning against them.
Do not carry them forward from here.

---

## The bug

`deduct_recipe_stock` (`supabase/migrations/20260719200000_deduct_recipe_stock_advisory_lock.sql`)
selects recipes on `recipes.is_active` alone. It never reads `menu_items.track_inventory`.

So switching "Track inventory" off does **not** stop stock being deducted. The item reads as
untracked on every screen while its stock keeps draining. There is also no UI path that
deactivates a recipe, and no way to remove a link once made — unticking the toggle is the only
lever a merchant has, and it doesn't do what it says.

Tracking state is split across two sources of truth that nothing keeps in sync:
`menu_items.track_inventory` (what every UI reads) versus `recipes.is_active` + `recipe_items`
(what deduction keys on).

## Exactly what is affected

**2 of 23 active recipes**, both at **FNB ChowNow** (`b161c758-582d-4dfa-839a-9fa35c492a49`):

| Menu item | `menu_item_id` | `recipe_id` | Ingredients | Status |
|---|---|---|---|---|
| Beef Stew | `29a3b17e-3777-4038-9f27-0338f0fbb219` | `40335ad4-d2d3-4c39-a757-516f39285010` | 1 | `hidden` |
| Lamb Chop | `b8734716-2683-4dba-8037-7965273049c4` | `f5b508f9-4764-48d3-927e-caf8d386c2bb` | 1 | `hidden` |

Per restaurant (active recipes / affected): **FNB ChowNow 6/2**, Mingle Brew & Pour 15/0,
Digi Cofee 2/0. No other restaurant has recipes.

**Both are `hidden`, so 0 are currently sellable — nothing is draining right now.** Un-hiding
either one starts it again. That is why this was safe to defer.

## Measured impact

Sale-driven movements on the two linked stock items:

| Stock item | Sale movements | Units drained |
|---|---|---|
| Beef Stew | 22 | −22 |
| Lamb chop | 28 | −33 |

**Caveat that matters:** these are all sale movements on those stock items, not only the ones
caused by the untracked link. Attributing precisely is not currently possible, because
Movement History records no order reference for sale movements (see "related" below). So treat
−22 / −33 as an upper bound on drift, not a confirmed figure.

**No monetary impact was measured.** Deriving one would need per-unit cost and an
order-attributed split of those movements, and the second half isn't available today.

## Regression risk — checked, and it's clear

The real danger in honouring the flag is the *opposite* of the bug: an item that currently
deducts could silently **stop**, letting stock drift high with nobody noticing.

Measured: **21 active recipes have `track_inventory = true`, 2 have `false`, and 0 are NULL.**

Because there are no NULLs, honouring the flag stops deduction only for the two explicitly
false items above — which is the intended outcome. **No data migration or backfill is needed.**
Re-confirm this before shipping; if a NULL appears, decide explicitly whether to backfill to
`true` rather than letting it change behaviour by accident.

## Proposed implementation

### Part 1 — make deduction honour the flag

Migration replacing `deduct_recipe_stock` so the recipe lookup joins `menu_items` and requires
`track_inventory = true` alongside `recipes.is_active`.

Verification must use **real recipe data, not unit tests** — assert against actual
`stock_movements` rows and before/after balances on staging:

1. tracked + linked item → still deducts, correct quantity, one movement per ingredient
2. untracked + linked item → **zero** movements, balance unchanged
3. re-ticking tracking → deduction resumes
4. multi-ingredient recipe → every ingredient still deducted
5. the existing advisory-lock concurrency behaviour is unchanged

Ship migration-first, then verify the function definition and grants in production, then repair
the migration ledger (`db query -f` applies SQL but does **not** record it; the deploy's drift
guard will fail otherwise — see the ops memory).

### Part 2 — real link removal

A distinct "Remove link" action that deactivates the recipe and clears `recipe_items`,
separate from the tracking toggle. Today unticking is overloaded: it has to mean both "pause"
and "undo", which is why the inconsistent state exists at all.

Ship as a **second, separate deploy**. Do not combine a UI change with a stock-behaviour
migration.

### Consequence for the badge

The loud 🔴 "Linked · not tracked" badge (shipped tonight, `4d7693b`) exists because the state
is currently dangerous. Once Part 1 lands, "tracking off" genuinely stops deduction, and the
badge should soften to a neutral "Tracking paused". No separate work — it follows from Part 1.

## Related, still open (not part of this)

- **Movement History shows every non-GRV movement as "Manual"** with no order reference
  (`lib/stock/queries.ts:336-340`). This is why the impact above can't be attributed precisely,
  and why stock problems are hard for merchants to diagnose. Highest leverage small fix.
- Recipe units are never converted — a 2 kg recipe on a gram-tracked item deducts 2, not 2000.
  0 of 27 recipe items mismatched today; only Digi Cofee (g/kg) can hit it.
- Clearing the last variant silently fails — 12 of 374 menu items exposed.
- Sales deduct with no sufficiency check by design; several production items sit negative
  (Mingle: Croissant −80, Sparkling water −47, Coke −3).

## Verification standard that caught two of my own bugs tonight

A permission- or privilege-sensitive change must be exercised **by the role that actually
fails**. Reproducing with the service-role client proves the data model and can never catch a
`42501`. Twice tonight a fix looked verified and wasn't. Grants and function security are all
readable per-environment without any write: `information_schema.role_table_grants`,
`role_routine_grants`, `pg_proc.prosecdef`, `pg_get_functiondef`.
