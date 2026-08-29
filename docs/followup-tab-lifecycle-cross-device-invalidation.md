# Follow-up: tab lifecycle (close/settle/payment) has no cross-device invalidation

**Filed 2026-08-29, as part of the P5 terminal realtime sync work
(`lib/stations/realtime-invalidate.ts`). Not built in that release, deliberately — recorded here
per explicit instruction rather than folded into `line_changed`.**

## The finding

`restaurant-lines:{restaurantId}` / `line_changed` (added this release) tells a terminal or
station board "an `order_lines.kitchen_state`/`bar_state` changed here, go re-ask the server." It
fires from exactly one place — `app/api/station/order-lines/[lineId]/state/route.ts` — after Out,
Cooked, Collected, Undo, a voided/replaced line from an amend, or a new round's lines landing.

Nothing plays the same role for **tab lifecycle**: closing a table
(`app/api/terminal/tables/[tableId]/close/route.ts`), settling a bill
(`app/api/terminal/tabs/[tabId]/settle/route.ts`, `.../settle-allocations/route.ts`), and anything
else that writes `tabs.status` rather than `order_lines.kitchen_state`/`bar_state`. Two concrete
places this is visible today:

- **`ServiceFloorScreen`**'s open/free grid only learns a table closed on its own 45s safety-net
  poll (or the next time a waiter navigates there) — never pushed.
- **Two terminals on the same tab** (a genuine case — ADR-005 §3's handover/adoption flow exists
  precisely because two waiters can both reach one table): if Waiter A closes or settles a table
  Waiter B still has open, B's screen has no way to find out except its own poll or the next
  action they take against a tab that may already be gone.

## Why this was deliberately not fixed by extending `line_changed`

`line_changed`'s entire contract, documented in `lib/stations/realtime-invalidate.ts`, is "an
`order_lines` state changed, come re-ask `GET /api/terminal/tabs/{tabId}/lines`." A tab closing or
settling is a different fact about a different table (`tabs`, not `order_lines`) that the
*current* open-table screen's own `GET .../lines` call cannot even answer — that route 404s or
serves stale data for a tab that no longer accepts activity, it does not say "and by the way this
tab is now closed." Firing the same event name for both would mean either:

- every `line_changed` listener has to re-fetch BOTH `.../lines` and the tab/tables endpoint on
  every invalidation, even though the overwhelming majority of real events are pure readiness
  bumps that have nothing to do with tab lifecycle — pure waste, working against the whole point
  of moving off a blind poll; or
- the event carries a `reason` field distinguishing the two cases, which is a real design
  decision (does a subscriber filter on it? what do old listeners do with a reason they don't
  recognise?) that deserves its own review, not a smallest-fix addition riding along on this
  release's mutation-audit pass.

## The follow-up, not built here

A second, narrowly-scoped invalidation signal for tab lifecycle — likely its own event name on the
**same** restaurant-scoped broadcast channel (`restaurant-lines:{restaurantId}`) rather than a
second channel, e.g. `tab_changed`, sent from the close and settle routes after a successful
status write. `ServiceFloorScreen` already holds the one reusable subscription
(`subscribeLineChangeInvalidation`) this would extend, and `ServiceTableScreen` would use it to
know when the tab it has open should stop accepting activity. Same debounce ceiling
(`MIN_INVALIDATE_INTERVAL_MS`) applies for the same amplification reason documented in
`realtimeInvalidation.ts`.

Worth doing once two-waiters-one-table is an observed real scenario rather than a documented
possibility, or once a venue reports the floor grid staying "occupied" past a table that actually
closed for long enough to matter — not before.
