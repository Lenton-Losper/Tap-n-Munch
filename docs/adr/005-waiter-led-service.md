# ADR-005: Waiter-led service

**Status:** Proposed
**Date:** 2026-08-27

Absorbs ADR-004 (`004-order-service-architecture.md`), a reserved slot that
never carried a decision.

Evidence base: `docs/discovery-waiter-led-service-v2.md`. Every production
count quoted below comes from that note. Nothing here was re-measured.

## Context

Riviera will not start on QR. They want the flow they run on paper: a waiter
takes the order at the table, the kitchen sees it on a screen, the bar sees
its own part, the bill accumulates on a tab, and a tip is added at settle.

All three existing ordering channels — QR, kiosk, POS — assume the person
ordering is the person paying. Waiter-led service breaks that assumption, and
in breaking it exposes three things the codebase has never decided:

- **Where line state lives.** `orders.items` is JSONB, 17 keys per item, not
  one of them a status, a flag or a timestamp. There is no `order_items`
  table.
- **What a station is.** `menu_categories.route_to` exists, is populated
  (kitchen 2,823 / bar 492 / both 1,274 / null 4), and has never routed
  anything.
- **Who owns a table.** No column, no concept, anywhere.

And one hazard that constrains all three: **`orders.status = 'completed'`
means PAID, not made.** 2,035 completed orders, ~99.5% with
`completed_at == paid_at` to the instant; 6 orders currently in `ready`, 1 in
`preparing`. `markOrderPaidConfirmed` writes `completed` from any prior
status and the table-close route bulk-stamps it. The kitchen state vocabulary
exists in the schema and the kitchen has never driven it.

Any design that reads `completed` as "the food happened" is reading a payment
event. This ADR therefore does not read it, write it, or depend on it.

## Decision

### 1. Line state lives in its own table. `orders.items` is not touched.

A new `order_lines` table holds one row per **fulfilment** line.

`orders.items` stays exactly as it is — the historical record and the
**billing** record. The existing orders (2,260, of which 2,035 are
`completed`, i.e. paid) keep it as their only record. **There is no
backfill.** New orders write lines; old orders never gain them.

Shape:

```
order_lines
  id                 uuid pk
  restaurant_id      uuid not null      -- tenant scope, RLS
  order_id           uuid not null      -> orders(id)
  tab_id             uuid null          -> tabs(id)
  source_item_index  int  not null      -- position in orders.items
  menu_item_id       uuid null          -> menu_items(id)
  name_snapshot      text not null
  quantity           numeric not null
  line_note          text null          -- "medium", "well done"
  station            text not null      -- 'kitchen' | 'bar' | 'unrouted'
  state              text not null      -- 'outstanding' | 'done' | 'voided'
  created_at         timestamptz not null default now()
```

**`order_lines` carries no monetary column.** Not price, not subtotal, not
tax. This is deliberate and load-bearing — see §2. If there is no money on
the table, nobody can sum money from it.

`orders.status` is neither read nor written by station bumping. A line's
state is a property of the line.

Every state transition is recorded in an append-only companion, as real
columns, not JSON:

```
order_line_events
  id               uuid pk
  restaurant_id    uuid not null
  order_line_id    uuid not null -> order_lines(id)
  from_state       text null      -- null on creation
  to_state         text not null
  actor_kind       text not null  -- 'station' | 'terminal' | 'system'
  actor_user_id   uuid null      -> users(id)
  occurred_at      timestamptz not null default now()
```

Why an events table rather than `done_at` / `done_by` columns on the line:
event Q. Someone in the kitchen will press the wrong thing, so undo has to
exist; undo makes `outstanding -> done -> outstanding` a real sequence, and a
single pair of columns can only record one of the two. `order_lines.state` is
the denormalised current value for query speed. `order_line_events` is the
truth.

### 2. Station is resolved at write time and frozen on the line.

`route_to` is read from `menu_categories` **once**, when the line is created,
and the result is stored on the line. It is never re-derived at read time.

Three reasons: a category's `route_to` can be edited while food is on the
pass, and a line already sent to the kitchen must not silently move to the
bar; two screens resolving independently can disagree with each other; and a
frozen station is the only thing that makes the pre-launch report below mean
anything.

**`both` fans out into two rows.** One with `station = 'kitchen'`, one with
`station = 'bar'`, each with its own independent state. This is the only
reading of the ruling that actually delivers it — for two stations to bump
independently there must be two states, and one row cannot hold two.

**The consequence that must never be lost: `order_lines` is a fulfilment
record, not a billing record.** One `both` item is one billed item and two
fulfilment lines. This is precisely why §1 gives the table no money column.

`null` resolves to `station = 'unrouted'` and appears on **both** screens
under a visible "unrouted" heading. It is not silently defaulted to kitchen.
A null that defaults silently is food nobody sees; a null that appears twice
under a loud heading is a waiter asking why. That is a visible failure, not a
silent correction.

**A discrepancy to surface, not to fix.** As declared,
`menu_categories.route_to` is `text NOT NULL DEFAULT 'kitchen'` with
`CHECK (route_to IN ('kitchen','bar','both'))`. The discovery note measured 4
nulls and describes `both` as "a category default nobody changed". Those two
statements cannot both be true of the column as declared — a NOT NULL column
defaulting to `kitchen` yields neither. Something differs between the schema
doc, the admin UI default, the item-snapshot path, and what production
actually holds. **Production has not been probed and will not be.** The
report below must show this rather than resolve it.

### 3. Assignment is table-scoped with history; the tab snapshots its owner.

```
table_assignments
  id            uuid pk
  restaurant_id uuid not null
  table_id      uuid not null -> restaurant_tables(id)
  waiter_user_id uuid not null -> users(id)  -- the PIN identity
  assigned_at   timestamptz not null default now()
  released_at   timestamptz null
  assigned_by_user_id uuid null -> users(id)
```

Current owner is the row with `released_at IS NULL`. The history answers "who
had table 12 last Tuesday" the first time anyone asks.

```
tabs.opened_by_user_id  uuid null -> users(id)
```

Snapshotted when a waiter opens the tab, and immutable thereafter. This is
the tip-attribution anchor. A later reassignment cannot retroactively move a
tip that was already earned.

Two anchors rather than one, because they answer different questions: who is
responsible for this table right now (operations), and who served this tab
(money). Collapsing them into one is what makes a shift change steal a tip.

### 4. A tab created by a waiter has no customer session.

No customer scanned, so there is no session token. `orders.session_id` and
`orders.member_session_id` are null on these orders.

Anything that authorises by session token therefore cannot read this tab.
Authority is the terminal JWT. This is the existing direction of travel, not
a departure — anon SELECT on `tabs` was revoked in
`20260825020000_tabs_revoke_anon_select.sql`.

Whether a customer can later join a waiter-opened tab by PIN is out of scope
for v1. Riviera's flow does not need it.

### 5. The stations are pages, and the screen is the risk.

`/kitchen` and `/bar`, restaurant-scoped, listing lines where `station`
matches (plus `unrouted`) and `state = 'outstanding'`.

Realtime is reused wholesale from #350 — connection-state handling, refetch
on reconnect, visibility listener, 60s polling fallback. It is live on
production and it already solves event O (wifi drops for two minutes).

It does not solve the other two:

- **Event N (open and untouched for a week).** Terminal auth is a 1h JWT. A
  wall-mounted monitor that nobody logs into will be dead an hour after
  someone opens it. Blocking ruling question — §8.1.
- **Event P (power loss, screen returns to the right page untouched).** This
  is Chrome kiosk-mode / startup-URL configuration at the venue. It is not
  application code. Per §7 of the discovery note, that is a behaviour change
  at the venue, and unless it is written into the launch checklist, event P
  does not pass — it fails quietly on the first outage.

Event handling on these pages:

- **J** (last outstanding line done): the card leaves the screen. It does
  **not** write `orders.status`.
- **I** (kitchen bumps, bar unaffected): falls out of the §2 fan-out for
  free.
- **L / M** (amended or cancelled after the kitchen started): amend voids the
  affected lines and writes new ones; cancel voids all outstanding lines.
  Voided lines stay visible, struck through, for a short window — a line that
  vanishes silently is food that gets made anyway.
- **Q** (wrong thing pressed): undo, which is why §1 uses an events table.

### 6. Tips: one row on the tab, the opening owner, surviving the retry.

```
tab_tips
  id            uuid pk
  restaurant_id uuid not null
  tab_id        uuid not null -> tabs(id)
  amount        numeric not null
  user_id       uuid not null -> users(id)  -- snapshot of
                               -- tabs.opened_by_user_id at creation
  state         text not null  -- 'intended' | 'captured' | 'abandoned'
  created_at    timestamptz not null default now()
  created_by    uuid null -> users(id)
  captured_at   timestamptz null
```

Against the four rulings:

1. **One tip per tab, not per payment leg.** A tip is for the service, not
   for a payment method. Split settlement divides the *bill*; the tip stays
   whole and attached to the tab. Apportioning it across legs for a card
   receipt is done at render time and never stored.
2. **`user_id` is the tab's opening owner, snapshotted.** A shift change
   mid-meal does not hand the tip to whoever is standing there at settle.
3. **`intended` exists before the payment succeeds.** The tip is part of the
   settlement *intent*, not of its outcome, so a failed payment retries
   against the same tip row. The customer cannot be charged a tip they did
   not agree to, and the retry loop has nothing to diverge on.
4. **A row, not a column on the settlement**, because reporting is per waiter
   per shift and a column cannot be grouped by a person.

**Not revenue, not VAT-able.** `tab_tips` is excluded from every revenue and
VAT aggregation. It must not enter `orders.subtotal`, `orders.tax` or
`orders.total`, and must not reach `daily_analytics` revenue. It appears as
its own labelled line on the bill and on the receipt.

**Build order: last, and alone**, after the service flow works end to end.

### 7. Recipe stock deduction is inherited unchanged.

A waiter round deducts exactly the way a POS order does today: the same path,
no fork, no copy, no new behaviour. The parallel inventory workstream owns
and is rewriting that surface; waiter rounds are a new *caller* of it, not a
new code path. If the signature or semantics of that path change, this ADR's
assumptions change with it.

## Consequences

**Intended**

- The kitchen and bar finally receive orders, using routing data that has
  existed and gone unused since
  `20260624120000_menu_categories_route_to.sql`.
- Line state is queryable, per line, with an actor and a timestamp on every
  transition — none of which `orders.items` could ever express.
- Tips become attributable, which is the difference between a tip report and
  an argument.
- `orders.items` is untouched, so nothing that reads billing today changes.

**Unintended, and accepted**

- **The screens are blind to the 2,260 existing orders, by design.** No
  backfill means no lines, and no lines means nothing to show. Correct —
  those orders are history, and most of them mean *paid*.
- **Two order-state vocabularies now coexist**: `orders.status`, which means
  paid, and `order_lines.state`, which means made. This ADR does not
  reconcile them. `orders.preparing_at` and `orders.ready_at` stay unused.
  That inconsistency is deliberate and should be named in the code, not
  quietly tolerated.
- **Every order is now two writes** — the order and its lines. They must
  share one transaction, or a station will display half an order.
- `order_lines` cannot be summed for money. By construction, permanently.

**What remains open** — §8.

## 8. Open questions requiring a ruling

1. **Station screen credential lifetime — blocking.** Terminal auth is a 1h
   JWT; event N needs a week of unattended uptime. Long-lived station token,
   silent refresh, or a device-bound credential? Nothing on the screen can be
   built until this is answered.
2. **Do QR and kiosk orders also write `order_lines` in v1?**
   Recommendation: **yes**. If only waiter-led orders write lines, the
   kitchen screen sees exactly one channel, and Riviera's eventual QR rollout
   silently bypasses the kitchen entirely. This widens v1 beyond the waiter
   path, so it needs sign-off rather than assumption.
3. **Event F** — a waiter adds to a table assigned to someone else.
   Recommendation: **soft** — allow it, record the actual actor on the line
   event, and show whose table it is. A hard block strands a table when a
   waiter is on break. Tip attribution is unaffected either way, because it
   follows the tab's opening owner and not the actor.
4. **Event K** — kitchen line done, bar line still outstanding. Does the
   runner get a view of their own, or does each station screen show the
   other's outstanding lines greyed out?
5. **"Per shift" has no referent.** There is no shift concept in the schema.
   Define a shift as a staff PIN session, or as a venue daypart boundary?

## Report owed before launch (not a decision)

A read-only report of what would land where under §2: per menu item, the
station it resolves to, with the 1,274 `both` and the 4 nulls called out
individually, and the §2 schema discrepancy shown rather than smoothed over.
Riviera verifies their own menu against it before launch. It is not verified
here, and nothing in it is silently corrected.

## Mentor sign-off

Pending. §8.1 and §8.2 block implementation; §8.3–§8.5 block only the
surfaces they name.
