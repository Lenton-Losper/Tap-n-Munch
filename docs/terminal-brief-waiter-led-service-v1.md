# Terminal brief — waiter-led service v1

For the session working in `D:\RN\FlashTapTerminal`.

This is a complete specification of the four screens and every endpoint behind
them. It is written to be built from without asking questions. Where something
is genuinely undecided it says so and gives you the safe default.

**Server side is done.** The endpoints described here are implemented, typechecked,
linted and unit-tested on branch `feat/service-operations-v1` in the web repo.
The migrations are written but **must be applied to staging before any of this
responds usefully** — see *Before you can test anything*.

Design authority: `docs/adr/005-waiter-led-service.md`. Evidence:
`docs/discovery-waiter-led-service-v2.md`. Read neither to build this; read them
when you want to know why something is the way it is.

---

## 1. What you are building

A waiter, on a P5, takes an order at a table. That is the whole deliverable.

Four screens:

1. **Floor grid** — every table, open or free, who owns it, how long it has been open.
2. **Open table** — pick a waiter, enter PIN, table becomes theirs.
3. **Add Round** — categories, search, running basket, **one** review screen.
4. **Send** — commits the round, returns to the grid, drops the PIN session.

## What is NOT in this build

Do not build these. They are ruled out for this milestone, not forgotten.

- **Tips.** Ship alone, later, after the service flow works.
- **Kitchen and bar screens.** A separate session owns them. They read the rows
  you write; you never render them.
- **Station auth.** Blocked on an unresolved ruling.
- **Payment or settlement changes.** A round is unpaid and accumulates on the tab.
  Settlement is the existing flow, untouched.

---

## 2. Before you can test anything

Two preconditions. Both will silently produce empty screens if missed, so check
them first rather than debugging your own code.

**a. The migrations must be applied to staging.** Four of them, in
`supabase/migrations/`: `20260827131000_order_lines`,
`20260827131100_order_line_events`, `20260827131200_table_assignments`,
`20260827131300_tabs_opened_by_user_id`. Until they run, `POST /rounds` will
fail on the line write and `?view=floor` will return owners as `null` for
everything.

**b. Every waiter needs a PIN *and* the `orders:update` permission.**

`GET /api/terminal/authorized-users?purpose=service_session` returns only users
who hold **both**:

- a PIN credential row in `terminal_authorization_credentials`, and
- the `orders:update` permission at that restaurant.

A waiter missing either is **invisible to the open-table screen** and cannot be
selected. If that list comes back empty, nothing is broken in your code — the
venue's staff PINs and roles are not set up. Raise it rather than working around it.

---

## 3. Authentication model — read this before writing any request

### The terminal token
Every request below carries the existing terminal JWT:
`Authorization: Bearer <terminal access token>`. Nothing changes here. It expires
in **one hour** and `terminalFetch` already refreshes on 401 and retries.

### The PIN authorization is a *different* thing
Opening a table needs a human to prove who they are. That uses the existing
privileged-authorization flow: authorize with a PIN, get a single-use token,
spend it on the open call.

### The 401 rule, which matters more than it looks

> **Never treat a 401 from `/tables/{id}/open` or `/rounds` as a PIN problem.**
> Those endpoints return **403** for every authorization failure, with a `code`
> you branch on. A 401 from them means the *terminal token* aged out, and
> `terminalFetch`'s existing refresh-and-retry is correct.

This is deliberate. Answering 401 for an expired PIN would send the device into a
refresh-and-retry loop that can never succeed, because refreshing the terminal
token does nothing about a PIN. That is the failure class that produced #327.

**One exception, and it is pre-existing:** `POST /api/terminal/authorize` itself
returns **401** with `code: "PIN_MISMATCH"` for a wrong PIN, and **429** with
`code: "PIN_LOCKED"` when locked out. Special-case `/authorize` — a 401 from *that
one endpoint* means "wrong PIN, ask again", never "refresh the token".

---

## 4. Screen 1 — Floor grid

### What it shows

Every active table as a card, sorted by table number:

- **Table number** (and `table_name` if present).
- **State** — open or free. Drive the card's colour from this.
- **Owner** — the waiter's name, or nothing if unowned.
- **Time open** — from `seconds_open`, rendered as `1h 15m` / `20m`. Blank when free.
- **Tab total** when open.

Tapping a **free** table → screen 2. Tapping an **open** table → screen 3.

### Request

```
GET /api/terminal/tables?view=floor
Authorization: Bearer <terminal token>
```

`?view=floor` is **required**. Without it you get the legacy response — occupied
tables only, different shape — which is what the current production build uses
and which is unchanged.

### Response `200`

```json
{
  "tables": [
    {
      "id": "8f14e45f-ceea-467a-9f6a-1c2d3e4f5a6b",
      "table_number": 12,
      "table_name": "Patio 3",
      "state": "open",
      "owner": {
        "user_id": "c9b1a2d3-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
        "name": "Ana",
        "assigned_at": "2026-08-27T18:04:11.221Z"
      },
      "opened_at": "2026-08-27T18:04:10.980Z",
      "seconds_open": 4512,
      "tab": {
        "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        "status": "open",
        "total": 430.0,
        "opened_by_user_id": "c9b1a2d3-4e5f-4a7b-8c9d-0e1f2a3b4c5d"
      },
      "table_status": "occupied"
    },
    {
      "id": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      "table_number": 13,
      "table_name": null,
      "state": "free",
      "owner": null,
      "opened_at": null,
      "seconds_open": null,
      "tab": null,
      "table_status": "available"
    }
  ],
  "server_time": "2026-08-27T19:19:22.980Z"
}
```

### Field notes you need

- **`state` is computed from the live tab, not from `table_status`.** Those two
  disagree in production in both directions (#216, and the abandoned-tab reaper).
  **Render `state`. Ignore `table_status`** — it is returned for diagnosis only.
- **`seconds_open` is server-computed.** Use it rather than subtracting
  `opened_at` from the device clock: a terminal that has been on a shelf for a
  week does not have a trustworthy clock. `server_time` is there if you want to
  tick the counter locally between refreshes.
- **`owner` can be `null` on an open table.** Legitimate — a QR-opened tab, or an
  assignment that failed while the tab succeeded. Show the table as open with no
  name. Never block on it.
- **`owner` is the table's *current* owner; `tab.opened_by_user_id` is who opened
  the tab.** They can differ after a handover, and that is correct, not a bug.

### Errors

| Status | Meaning | What the device does |
|---|---|---|
| `401` | Terminal token expired/invalid | Refresh and retry (existing behaviour) |
| `403` | `{"error":"Missing permission"}` — token lacks `orders:read` | Show a hard error; not recoverable on device |
| `500` | `{"error":"Failed to load tables"}` | Retry with backoff; keep showing the last good grid |

---

## 5. Screen 2 — Open a table

Reached by tapping a **free** table.

### What it shows

1. A list of waiters to pick from.
2. A 4-digit PIN pad for the chosen waiter.
3. On success → straight into screen 3 for that table.

### Step 2a — list the waiters

```
GET /api/terminal/authorized-users?purpose=service_session
Authorization: Bearer <terminal token>
```

`200`:
```json
{ "users": [ { "user_id": "c9b1a2d3-...", "name": "Ana" } ] }
```

Sorted by name already. **An empty array is an operational problem, not a code
problem** — see *Before you can test anything*. Say so on screen: "No staff are
set up to take orders on this terminal."

### Step 2b — authorize the PIN

```
POST /api/terminal/authorize
Authorization: Bearer <terminal token>
Content-Type: application/json

{ "user_id": "c9b1a2d3-...", "pin": "4913", "purpose": "service_session" }
```

`200`:
```json
{ "token_id": "7e8f9a0b-...", "expires_at": "2026-08-27T19:21:00.000Z" }
```

**The token is single-use and lives 90 seconds.** Spend it immediately on step 2c.
Do not cache it, do not reuse it, do not fetch it in advance.

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"PIN must be exactly 4 digits (0-9)"}` | Validate client-side first |
| `400` | `{"error":"user_id must be a valid UUID"}` | Programming error |
| `401` | `{"code":"PIN_MISMATCH","attempts_remaining":3}` | **Wrong PIN.** Re-prompt. Show attempts remaining. **Do not refresh the terminal token.** |
| `429` | `{"code":"PIN_LOCKED","retry_after_seconds":300}` | Locked out. Show the countdown; the pad stays disabled. |
| `403` | `{"error":"Authorization denied"}` | Not a member, no permission, or no PIN set. Same message to the user: "This staff member cannot open tables." |

### Step 2c — open the table

```
POST /api/terminal/tables/{tableId}/open
Authorization: Bearer <terminal token>
Content-Type: application/json

{
  "user_id": "c9b1a2d3-...",
  "authorization_token_id": "7e8f9a0b-..."
}
```

`200`:
```json
{
  "already_open": false,
  "table": { "id": "2b3c4d5e-...", "table_number": 13 },
  "tab": {
    "id": "9f8e7d6c-...",
    "status": "open",
    "total": 0,
    "opened_at": "2026-08-27T19:20:05.114Z",
    "opened_by_user_id": "c9b1a2d3-..."
  },
  "owner": { "user_id": "c9b1a2d3-...", "name": "Ana", "assigned_at": "2026-08-27T19:20:05.180Z" }
}
```

**`already_open: true` is a success, not an error.** It means the table already
had a live tab and you are being handed it. Proceed to screen 3 exactly as if you
had just opened it. This happens when two waiters tap the same table at once, and
when a grid refresh was slightly stale.

| Status | Body | What the device does |
|---|---|---|
| `400` | `{"error":"tableId must be a valid UUID"}` etc. | Programming error |
| `403` | `{"code":"AUTHORIZATION_EXPIRED"}` | The 90s ran out. Re-prompt for the PIN. |
| `403` | `{"code":"AUTHORIZATION_ALREADY_USED"}` | Token already spent. Re-prompt for the PIN. |
| `403` | `{"code":"AUTHORIZATION_NOT_FOUND"}` / `{"code":"AUTHORIZATION_MISMATCH"}` | Re-prompt for the PIN. |
| `403` | `{"error":"Missing permission"}` | Terminal token lacks `orders:update`. Hard error. |
| `404` | `{"error":"Table not found"}` | Stale grid. Refresh the grid, return to screen 1. |
| `409` | `{"error":"Table is not active"}` | The table was deactivated. Refresh the grid. |

**The table is validated before the token is consumed**, so a 404 or 409 here has
*not* burned the waiter's PIN entry. Every `403 AUTHORIZATION_*` has.

---

## 6. Screen 3 — Add Round

### What it shows

- A category strip across the top.
- A search field filtering items by name across all categories.
- A grid of items; tapping one adds it to the basket.
- A **running basket** — always visible, with a count and a running total, and
  per-line quantity adjust and remove.
- A per-line **note** field ("medium", "well done"). This is the one the kitchen
  reads; it rides with the line.
- A single button through to the review screen.

### Getting the menu

Both endpoints already exist and the current APK already calls them. Nothing new.

```
GET /api/menu/{restaurantId}/categories
Authorization: Bearer <terminal token>
```
`200`: `{ "categories": [ { "id": "...", "name": "Mains", "sort_order": 1, "is_active": true } ] }`

Terminal-scoped: a `restaurantId` that is not the token's restaurant returns `403`.

```
GET /api/menu/{restaurantId}/category/{categoryId}
```
Returns the items for one category, grouped by subcategory. This is the same
payload the customer browse screen uses, and it is cached server-side.

Fetch the categories once when the screen opens and each category's items lazily
on first tap. Build the search index from what you have loaded.

### The ONE review screen

The brief is explicit: **one** review screen, not a chain of confirmations. It shows
the basket in final form — every line, its quantity, its note, and the round total
— with **Send** and **Back**. Editing goes back to the basket; there is no second
"are you sure".

---

## 7. Screen 4 — Send

### Request

```
POST /api/terminal/rounds
Authorization: Bearer <terminal token>
Content-Type: application/json
x-idempotency-key: <uuid you generate per round>

{
  "tab_id": "9f8e7d6c-...",
  "items": [
    { "menuItemId": "m-1111-...", "name": "Ribeye", "quantity": 2, "note": "medium" },
    { "menuItemId": "m-2222-...", "name": "Coke",   "quantity": 1 }
  ],
  "subtotal": 428.0,
  "total": 428.0,
  "order_instructions": "allergy: shellfish"
}
```

**Notes on the body, each of which will bite you if ignored:**

- **`tab_id`, not `table_id`.** The tab is the authority. It is where the table,
  the waiter and the attribution are read from, so a device cannot attribute a
  round to somebody else by sending different ids.
- **`menuItemId` is required for routing.** An item without one is still accepted
  and still appears — as `unrouted`, on both screens. Do not send items without it.
- **`note` is the per-line note.** `note` is the key to send. (`notes`,
  `specialInstructions` and a few others are also accepted, because the cart, the
  kiosk and the terminal each grew their own spelling — but send `note`.)
- **`subtotal` and `total` are advisory.** The server **re-prices from the catalog**
  and ignores them. That is the anti-tampering control on the terminal path and it
  is not negotiable. Show the customer your computed total, but expect the
  authoritative figure to come from the tab.
- **`order_instructions`** is order-level free text. It is *not* a substitute for
  per-line notes — it cannot say which of three steaks is the rare one.
- **`x-idempotency-key` is MANDATORY.** A request without it is rejected `400`
  with `{"code":"IDEMPOTENCY_KEY_REQUIRED"}`. Generate **one** UUID per round
  attempt and **reuse the same value across every retry of that round** — a fresh
  UUID per retry defeats the entire mechanism. A replayed key returns the original
  round with `duplicate: true` and `200`; treat that as success and return to the
  grid, do not create a second round and do not show an error.

  It is mandatory here because on the POS path it is optional and consequently
  absent: 0 of 1,545 orders carry one, which is exactly why every failed retry
  there stranded a duplicate order. A mechanism callers may opt out of is off.

### Response `200`

```json
{
  "success": true,
  "duplicate": false,
  "order_id": "3c4d5e6f-...",
  "order_number": 1043,
  "tab_id": "9f8e7d6c-...",
  "lines_written": true,
  "line_count": 3,
  "station_counts": { "kitchen": 2, "bar": 1, "unrouted": 1 }
}
```

`duplicate: true` means this exact round was already sent and you are being handed
the original. Success. Return to the grid.

`station_counts` is worth showing on the confirmation toast — "2 to kitchen,
1 to bar". **If `unrouted` is greater than zero, say so visibly**: it means an item
had no usable routing and both stations will see it flagged. That is a menu
problem someone needs to fix, and the waiter is the first person in a position to
notice.

`line_count` is exactly the number of items you sent — one line per item, always.
An item routed to both stations is still one line; it carries a separate state per
station so each can mark its own done.

### Errors

| Status | Body | What the device does |
|---|---|---|
| `400` | `{"error":"items are required"}` | Programming error |
| `400` | `{"code":"IDEMPOTENCY_KEY_REQUIRED"}` | You omitted `x-idempotency-key`. Not retryable without one. |
| `403` | `{"error":"Missing permission"}` | Terminal token lacks `orders:update` |
| `404` | `{"error":"Tab not found"}` | Tab vanished. Return to the grid and refresh. |
| `409` | `{"code":"TAB_NOT_OPEN"}` | The tab was settled or closed while the waiter was building the round. **Do not silently discard the basket** — tell them the table was closed and offer to re-open it. |
| `409` | `{"code":"OUT_OF_STOCK","outOfStock":[{"item":"Ribeye","ingredient":"Beef"}]}` | Highlight **every** listed item at once in the basket. Do not make them discover one refusal at a time. |
| `502` | `{"code":"LINES_NOT_WRITTEN","order_id":"...","lines_written":false}` | **See below. This one is important.** |
| `500` | `{"error":"..."}` | Retryable with the same idempotency key |

### The `502 LINES_NOT_WRITTEN` case

This means **the round was recorded on the tab, but the kitchen and bar were not
notified.** The customer will be billed for food nobody has been told to cook.

Do not retry it silently and do not show a generic error. Show the message the
server sends, prominently, and keep the `order_number` on screen:

> The round was recorded on the tab but the kitchen and bar were not notified.
> Tell a manager before serving this table.

This exists because the order row and its lines are two separate writes and cannot
currently be one transaction. It is a known gap, tracked for a follow-up that moves
both into a single RPC. Until then, a loud failure is the correct behaviour — a
silent 200 would be worse.

---

## 8. The Send-drops-the-PIN-session rule

**On any 2xx from `POST /rounds`: clear the held waiter identity, return to the
floor grid.**

The next action on the device — opening another table — must require a PIN again.

Things to understand so you do not build the wrong thing:

- **There is no logout endpoint, and you do not need one.** The server holds no
  waiter session. The PIN token was single-use and was already consumed when the
  table was opened. The only thing that persists between open and Send is the
  identity *your app is holding in memory*, and dropping it is entirely device-side.
- **Adding a round does not require a PIN.** `POST /rounds` takes no `user_id`.
  Attribution comes from the tab's `opened_by_user_id`, server-side, and cannot be
  overridden by the request. This matches the existing POS, where ringing up an
  order needs no PIN either. **Do not invent a PIN prompt at Send.**
- **Attribution is therefore safe even if someone else picks up the device.** The
  round is credited to whoever opened the tab, not to whoever is holding the P5.
  Dropping the session at Send is about the *next table*, not about this round.
- **Also drop it** on returning to the grid by any other route: Back from the
  round screen, a cancel, or the app being backgrounded past your normal timeout.

---

## 9. Two behaviours that will look like bugs and are not

**A `both` item counts toward both station totals from a single line.** One item
routed to both stations is ONE line carrying two independent states, so
`station_counts.kitchen` and `station_counts.bar` can add up to more than
`line_count`. That is correct: both screens show the line, each marks its own half
done, and the bill still counts the item once.

**A null route becomes `unrouted`, not `kitchen`.** Items whose category has no
usable routing are deliberately *not* defaulted to the kitchen. They are marked
`unrouted` and shown on both screens under a visible heading. Routing data is not
trusted, is not silently corrected, and Riviera verifies their own menu before
launch. Surface the `unrouted` count; do not hide it.

---

## 10. Open questions that do not block you

Build the safe default given for each; none of these stop screens 1–4.

1. **Two waiters, one table (event E).** Handled: the second `open` gets
   `already_open: true` and the existing tab. No lock, no error.
2. **A waiter adds to someone else's table (event F).** Not ruled. **Default:
   allow it.** Show whose table it is; do not block. A hard block strands a table
   when a waiter is on break. Attribution is unaffected either way.
3. **Amend or cancel a round after Send.** Not in this build. There is no
   amend endpoint yet.
4. **Which waiter is "on" the device between tables.** Nothing persists. Every
   open is its own PIN entry, by design.

---

## 11. Who to tell what

- **Endpoint shape wrong, or a field missing** → the web repo session, branch
  `feat/service-operations-v1`.
- **Waiter list empty, PINs unset, permissions missing** → operational, needs the
  venue's staff setup, not a code change.
- **The kitchen/bar screens** → a separate session owns them. They consume
  `order_lines` and `order_line_events`; you produce them. You never render them.
