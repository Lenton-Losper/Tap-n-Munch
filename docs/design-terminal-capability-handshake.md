# Design: terminal capability handshake — design only, not built

**Filed:** 2026-08-28. Two real instances of the same gap inside one evening — `ready_to_run` (a
client guessed a write-side vocabulary the server never accepted) and `collected` (the server grew
a value two terminal-facing routes hadn't been told about; one exposure was cosmetic, one was a
live "FOOD UP never clears" bug that shipped invisibly until a handover surfaced it by hand). Both
were found by someone reading code after a symptom appeared. This design is the answer to "make
the next one show up as a number on a dashboard, not as a symptom at a venue."

## What already exists, tonight

| Piece | State today | Where |
|---|---|---|
| Per-terminal version | `restaurant_terminals.app_version`, written by every heartbeat | `app/api/terminal/heartbeat/route.ts` |
| A per-request terminal lookup | `validateTerminalRecord()` runs once per request on every terminal route already, but selects only `id, status, restaurant_id, device_serial`, and most callers discard the row it returns | `lib/terminal-auth.ts` |
| A non-blocking, queryable event log | `audit_logs(restaurant_id, entity_type, entity_id, action, metadata)`, with a proven rate-limit idiom already in this codebase — the most recent row of a given `action` IS the "last checked" marker, no new column | `lib/orders/auto-cancel-stale-pos-orders.ts`'s `SKIP_REPROBE_INTERVAL_MS` |

Nothing in this table needs a migration. The handshake is mostly wiring three things that already
exist together, not inventing new storage.

## The three pieces

1. **A capability registry — one file, one source of truth.**
   `lib/terminal-compat/capabilities.ts`, shape `Record<CapabilityName, MinVersion>` — e.g.
   `{ collected_state: '2.14' }`. Every entry carries the same kind of dated, signed docblock
   every other constant table in this repo already carries (`STATION_COPY`,
   `LEGACY_STATE_ALIASES`): what it gates, which commit introduced the server-side vocabulary it
   depends on, and — mirroring the removal criterion this session was asked to write on the
   `collected` shim itself — the retirement condition for the REGISTRY ENTRY, not just the shim
   behind it.

   **Open question this repo cannot answer for itself:** what an `app_version` string actually
   looks like in the field. "2.13" is a fact this session was given; whether it is strictly
   `major.minor`, ever carries a patch or a build suffix, is something only the terminal team's
   real release process can answer, and a comparator written against a guessed format is the same
   mistake this whole handshake exists to stop making.

2. **The route's own answer to "how old is the thing asking me this."**
   `validateTerminalRecord` already runs once per request — add `app_version` to its existing
   `select(...)` (zero new queries) and let callers that care read it off the row they already
   get back. A pure, testable helper, `capabilityGap(terminal, capability): { gap: boolean;
   required: string; actual: string | null }`, exactly the shape `bucketForLine` took tonight. A
   null or unparseable `app_version` (never heartbeated, or sends garbage) is treated as "assume
   old" — the same safer-default direction every shim tonight already took.

3. **What a route does with a gap — three tiers, not one.**
   - **Safe translate** (what shipped tonight, twice): the route can produce a truthful
     backward-compatible response cheaply. Apply automatically and silently, exactly as
     `serializeStateForLegacyTerminal` and `bucketForLine` do now — the registry just gives the
     shim a NAMED reason instead of a hardcoded literal.
   - **Visible, not blocking** — the actual answer to "visible rather than discovered": record one
     `audit_logs` row (`action: 'terminal_capability_gap'`, `entity_type: 'terminal'`,
     `entity_id: terminal.terminalId`, `metadata: { capability, requiredVersion, actualVersion,
     restaurantId }`), rate-limited with the same most-recent-row-is-the-marker idiom the sweep
     already uses — once per terminal per capability per day, not once per request. A query
     against `audit_logs` for the last 7 days, grouped by capability and restaurant, is then a
     dashboard answering "who is still running something that doesn't know about X" — the exact
     question that took a handover and a manual code read tonight.
   - **Hard block** — reserved for a gap that cannot be safely translated at all: a write the
     route cannot safely guess the old client's intent for. Refuse with a distinct code
     (`CLIENT_OUTDATED`, capability name, min version) rather than doing something wrong quietly.
     Not needed for `collected` — both directions were safely translatable — but the mechanism
     should have this tier from the start so the next gap does not have to invent it under
     pressure.

## Where the registry and the write-side alias meet

`LEGACY_STATE_ALIASES` (the bump route's `done` → `ready` translation) and
`serializeStateForLegacyTerminal` (this evening's `collected` → `ready`) are currently two
hand-written shims with an undated removal criterion living in two files. Once the registry
exists, both could be expressed AS capability-gated translations instead of bare literals — not
required for v1, but it is the same shape, and it is where "a shim nobody can date is a shim
nobody removes" stops being a comment a human has to remember and becomes a fact the registry can
answer.

## What this explicitly does not attempt to solve

- Retrofitting `LEGACY_STATE_ALIASES` or the two shims that shipped tonight onto the registry —
  they work today, on comments, and moving them is a refactor with no urgency of its own.
- A terminal-side per-request version header. Heartbeat cadence is good-enough freshness for a
  value that cannot change mid-shift; a header is more coordination cost on the terminal side for
  no real gain in accuracy.
- An automated gate (`check-no-pending-copy.mjs`-style) that fails a PR introducing a new
  `LineState` value or terminal-facing contract field without a matching capability entry. Worth
  doing later; not this design's job to build.

## Not attempted here

No schema change beyond noting `app_version` already exists, no route, no registry file, no audit
action wired up. Shape only, per the instruction that this item is design, not build.
