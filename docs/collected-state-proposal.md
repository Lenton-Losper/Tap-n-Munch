# Proposal: a `collected` transition on order lines

**Status: DESIGN ONLY. Nothing here is built, and the runner screen is explicitly not approved.**
The owner ruled that the state comes first and the screen comes after. This document exists to be
argued with, not to be implemented from.

Written from the terminal repo. The server changes it describes live in the web repo, which this
session must not touch and which another session currently owns. No server code was written.

---

## 1. The fact nobody writes down

A line becomes `ready` when every station that owns it has bumped it. Nothing after that is ever
recorded. **A line that is ready stays ready forever.** There is no event, column, or timestamp
anywhere in the system that says a waiter picked the food up and took it to the table.

The owner's framing: *"That is the same shape as paid-is-not-closed. Food leaving the pass is a real
business event and nobody writes it down."*

This is not a cosmetic gap. Three things are impossible without it, and the first two are already
biting:

1. **The floor badge cannot clear itself.** The badge shipped in this branch says READY with a count
   against a table. It means "food has been up as of the last refresh" — it cannot mean "food is
   still sitting there", because the device has no way to learn that the plates were run. A waiter
   who has already collected keeps seeing the badge until the rest of the tab lands. That is a badge
   that cries wolf, and a badge that cries wolf gets ignored, which is how the WAITING badge got
   into the state this branch just fixed.
2. **A ready list would never empty.** Every "ready to collect" design — the owner's Option 2 —
   accumulates all night. This is why the fix shipped as a badge on a table rather than a work list.
3. **Nobody can measure pass-to-table time.** How long food actually sits under the lamp is the
   number this whole feature is about, and it is currently unmeasurable. Note the second-order cost:
   `OUTSTANDING_ATTENTION_SECONDS` in `src/lib/tabLines.ts` is an admittedly uncalibrated 20-minute
   guess, *because* nothing recorded when a line was placed against when it went out. `collected`
   is the missing half of that measurement.

## 2. The schema as it stands

Verified by the coordinator; treated as given here.

| Where | Column | Allowed values |
|---|---|---|
| `order_line_events` | `from_state`, `to_state` | `outstanding, done, cooked, ready, voided` (CHECK, migration `20260828235900`) |
| `order_lines` | `kitchen_state`, `bar_state` | `outstanding, cooked, ready, voided` (separate CHECK) |

Marking a line ready writes **only** `order_lines` and `order_line_events`. It never touches
`orders`. That is precisely why nothing reaches the terminal today: the terminal's live SSE stream
carries order-level events, and the ready transition never produces one.

### `collected` is not a station state

**The station columns are the wrong home for it, and this is the load-bearing point of the design.**

`kitchen_state` and `bar_state` are per-station: they record what *that station* did to *its half* of
the line. Collection is not something a station does. It is something a waiter does to the line as a
whole, once, after every station has finished. A both-routed item — food from the kitchen, a drink
from the bar, one fulfilment line — has two station columns and exactly one collection. Writing
`collected` into either column forces the question "which one?", and there is no correct answer.

So the proposal does **not** widen the `order_lines` station CHECK. Whatever is stored, if anything,
is stored in its own column.

## 3. The question the owner asked: event-only, or event plus column?

### Option A — event only

`collected` becomes a legal `to_state` on `order_line_events` and nothing else changes.

- **Server cost:** one migration widening both CHECKs. One insert path. No new column, no backfill.
- **Read cost:** every "is this line collected?" is a query against the events table. For the tab
  lines endpoint that is a correlated lookup per line, on the hot path the floor grid already hits
  once per open table every 15 seconds.
- **The real risk, and it has a precedent in this codebase.** An event-only model means the fact
  exists but no payload carries it. That is exactly what happened with the cooked timestamp: the
  transition was recorded in `order_line_events` all along, no payload surfaced it, and the board
  keyed its escalation on the wrong clock for weeks. Nobody noticed because the data was *there* —
  it just was not anywhere a screen could reach. An event-only `collected` sets that trap again, and
  the trap is silent by construction.

### Option B — event plus a per-line column

`collected` becomes a legal `to_state`, **and** `order_lines` gains its own nullable column.

- **Server cost:** one migration widening both event CHECKs and adding the column, plus the write
  path setting both together. Existing rows are `NULL`, which reads correctly as "not collected" and
  needs no backfill.
- **Read cost:** free. The line is already selected; the field rides along.
- **Payload cost:** one field on `GET /api/terminal/tabs/{tabId}/lines`, alongside `is_ready`.
- **Why the redundancy is correct here.** The events table stays the audit trail — who, when, from
  what — and the column is the current-state cache the read path uses. That is the same split the
  system already runs for readiness: `order_line_events` records the transition, `kitchen_state` /
  `bar_state` hold the state, and `is_ready` is computed from the latter. `collected` should look
  like the thing it sits next to.

### Recommendation: Option B

Option A is cheaper by one column and more expensive by one silent failure mode that this codebase
has already paid for once. The cooked-timestamp incident is the argument: a fact that exists only in
an events table is a fact no screen will reliably show, and the way you find out is weeks of wrong
behaviour that never errored.

**Shape, for argument:**

- `order_lines.collected_at timestamptz NULL` — the timestamp *is* the boolean, and it is the
  measurement that makes pass-to-table time computable. A separate `is_collected boolean` would be a
  second source of truth for the same fact.
- `order_lines.collected_by uuid NULL` referencing the staff user.
- Payload adds `collected_at` and a server-computed `is_collected`, mirroring how `is_ready` is
  already served rather than making the device derive it. **The device must not compute readiness or
  collection itself** — one definition, server-side, is the rule `src/lib/tabLines.ts` already
  documents at length.

## 4. Migration ordering — load-bearing

**Widen the CHECK constraints before anything writes the new value.** A CHECK is enforced at write
time: deploy a writer against the old constraint and the insert is refused outright. The transition
is silently unrecordable, and the failure surfaces as a runtime error on a waiter's device mid-
service rather than at deploy time.

Order:

1. Migration widening `order_line_events.from_state` and `to_state` to include `collected`, and
   adding `order_lines.collected_at` / `collected_by`. Ships alone, writes nothing.
2. Server write path, once (1) is live everywhere.
3. Payload field on the tab-lines route.
4. Terminal reads the field. **Fails closed**: an absent or unreadable `is_collected` means *not*
   collected, never collected — the same defaulting rule `getTabLines` already applies to `is_ready`
   (`api.ts`: *"Defaulted FALSE, never true. An unreadable flag must not assert that food is
   ready."*). A terminal on an older build simply behaves as it does today.

Rolling back (1) after (2) has written any `collected` row will fail: the tightened CHECK cannot be
re-applied over existing data. Rollback means widening stays and the writer reverts.

## 5. The remaining questions, answered

**Per-line or per-table?** **Per-line.** Collection is per-plate: a table's starters get run while
its mains cook, and that is the exact case this whole branch exists to handle. A per-table flag
could not represent it and would recreate the all-or-nothing failure of the old `all_ready` gate.
A per-table view is a *derivation* — "every ready line on this tab is collected" — not a stored
fact.

**Who can record it?** Any authenticated staff member on a terminal scoped to the restaurant. Two
reasons not to restrict it to the table's owner: terminals are shared and pass hand to hand mid-
service (the floor screen drops the held waiter on every arrival for exactly this reason), and a
runner collecting for a colleague is normal service, not an exception. `collected_by` records who,
which is the accountability that matters; refusing the write is not. **It should not require a PIN.**
The PIN in this app is spent on attributable acts that move money or ownership. Making a waiter type
four digits to say "I picked up a plate" guarantees the state is never recorded, and an unrecorded
state is worse than an imprecisely attributed one.

**Is it reversible?** **Yes, and it must be** — a mis-tap is inevitable on a P5 held one-handed, and
an irreversible mis-tap hides food. Reversal is a *new event* (`collected` → `ready`), never a
deletion or an in-place edit of the original; the events table stays append-only. Clearing
`collected_at` back to `NULL` is the column-side effect. Worth deciding, and I have not: whether
reversal is time-bounded, and whether the terminal exposes it at all in v1 or leaves it to a manager.

**What happens to a line voided after it was collected?** This is the sharp one, because it is a
real-money case: the food left the pass and the customer is now not being charged for it. Proposal:
**`voided` wins for billing, and `collected_at` is preserved, not cleared.** The two facts are not in
conflict — the plate genuinely was collected, and the line genuinely is not chargeable — and erasing
the collection destroys the only evidence that food left the kitchen and was never paid for. That is
precisely the wastage signal a venue wants. A void after collection should be visible as its own
thing rather than laundered into an ordinary void. Whether it needs a distinct reason code is a
product question I am not answering here.

**Does `collected` belong in `order_line_events` at all, given it is not a station transition?**
Yes. The table records line lifecycle transitions with `occurred_at` and `station`; collection is a
lifecycle transition. `station` should be `NULL` for it — it is the honest value, and it is what
distinguishes a collection from a station bump when reading the trail. Confirm the column is
nullable; I could not check.

## 6. Explicitly not proposed

- **The runner screen.** Not approved. The owner wants the state first.
- **Any auto-collection heuristic** — inferring collection from elapsed time, from a settle, or from
  the tab closing. All three would write a business fact the system did not observe. A guessed
  `collected_at` is worse than a missing one, because it looks like a measurement.
- **Any change to how `ready` is computed.** Untouched.

## 7. What I could not verify

Read from the terminal repo only; the web repo was off-limits.

- Whether `order_line_events.station` is nullable.
- Whether anything else already reads `order_line_events` in a way a new `to_state` value would
  break — a switch without a default, a status rollup, an analytics view. **A new enum value in a
  shared table is a compatibility change for every existing reader**, and that sweep has not been
  done. It should be, before the migration.
- Whether the SSE stream could carry a line-level event at all, which decides whether the terminal
  ever learns about a collection made on another device without polling for it.
- The actual shape of the tab-lines route's SQL, and therefore the true cost of the Option A
  per-render lookup. The Option A read cost above is reasoned, not measured.
