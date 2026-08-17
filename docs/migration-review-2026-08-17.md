# Production migration review — 2026-08-17

Read before authorising. Nothing has been applied. Production is `de1fd04`, Deploys 1 and 2 live.

## Summary

**Eight** migrations exist on `cloudflare-staging` and not on `main`. **Two must never reach
production** and are excluded below. **Six** are up for authorisation.

**Five of the six are cleanly additive.** The sixth — `20260705210000` — is not, in three separate
ways, and I would not apply it without you reading §1.

| # | migration | verdict |
| --- | --- | --- |
| 1 | `20260705210000_post_payment_order_lifecycle` | **NOT purely additive.** Data backfill, non-idempotent policies, two `CREATE OR REPLACE FUNCTION`. See §1. |
| 2 | `20260705220000_refund_events` | additive; new table only |
| 3 | `20260812130000_tabs_pin_reset_token` | additive; 2 nullable columns + partial index |
| 4 | `20260813120000_order_editing_lock` | additive; 20 columns across 2 tables, 6 with `NOT NULL DEFAULT` |
| 5 | `20260814090000_tabs_linked_unpaid_tab` | additive; 1 nullable column + partial index |
| 6 | `20260816090000_orders_source_request_id` | additive; 1 nullable column + FK + partial index |

### Excluded, and why

**`20260717120000_seed_whatsapp_account_staging.sql`** — a staging data seed. Never production.

**`20260809120000_orders_unique_order_number.sql`** — carries `-- @env: staging` and its own header
forbids it. **I verified the reason rather than trusting it.** Paginated read of all 2,677
production `orders` rows with both columns set:

```
distinct colliding (firebase_restaurant_id, order_number) pairs : 282
rows involved in a collision                                    : 1226
worst pair                                                      : x5
=> CREATE UNIQUE INDEX FAILS on the first collision
```

282 matches the header's figure exactly. Applying it aborts, and the de-duplication is its own
piece of work. **Excluded.**

## Measured production volumes

```
orders            2678        order_requests       8
tabs                26        restaurants         10
payments            10        staff_members       11
audit_logs        1919
```

Small. Every lock below is milliseconds on this data — the risk is contention, not duration.

## Prerequisites, probed

```
user_restaurant_ids()        EXISTS      (migration 1's RLS policies depend on it)
restaurants.short_code       ABSENT      (migration 1 adds it)
document_sequences           EXISTS, has rows   <-- see §1
invoice_requests             ABSENT (PGRST205)
order_revisions              ABSENT (PGRST205)
refund_events                ABSENT (PGRST205)
restaurant 01bf27f1 (RIV)    EXISTS: "Riviera"
restaurant b161c758 (FNB)    EXISTS: "FNB ChowNow"
```

All ten columns the redesign reads are absent from production — that is why this is needed at all:
`orders.edit_lock_token`, `edit_lock_session_id`, `edit_lock_expires_at`, `customer_edit_count`,
`customer_edited_at`, `edit_history`, `total_before_edit`, `source_request_id`,
`tabs.pin_reset_token`, `tabs.linked_unpaid_tab_id`.

---

## §1 — `20260705210000_post_payment_order_lifecycle` — NOT purely additive

Recovered from the staging ledger (#143) and never applied to production. Three problems:

**(a) It writes data to a live table.**

```sql
UPDATE public.restaurants SET short_code = 'RIV' WHERE id = '01bf27f1-…';
UPDATE public.restaurants SET short_code = 'FNB' WHERE id = 'b161c758-…';
```

Both rows exist on production ("Riviera", "FNB ChowNow"). This is a backfill, not a schema change.
Harmless in itself — the column is new, so it overwrites nothing — but it is a **write to
production data**, which your standing rule prohibits, and it should be an explicit decision
rather than something that rides in inside a migration.

**(b) `CREATE POLICY` is not idempotent.** Postgres has no `CREATE POLICY IF NOT EXISTS`. The
migration creates five policies. The three target tables are absent, so a **first** run succeeds —
but this file is not safe to re-run, unlike every other one here. If it half-applies, the retry
fails on the first existing policy.

**(c) Two `CREATE OR REPLACE FUNCTION`, and one has an existing footprint.**

- `generate_document_number(...)` — `document_sequences` **already exists on production with
  rows**, so something is using per-restaurant numbering there already (the file's own comment
  says the pattern was "already established for GRV-000001 in Stock Control"). `CREATE OR REPLACE`
  would **redefine** that function if it exists under this signature.
- `touch_updated_at()` — a generic name. If production already has it, `CREATE OR REPLACE`
  silently changes the function **every trigger using it** calls.

**I could not measure either one.** They are trigger/plpgsql functions and PostgREST does not
expose them for an existence probe; `pg_proc` is not readable with the access I have. This is an
**unmeasured risk**, stated as such rather than assumed away.

**Nothing in Deploy 3 or Deploy 4 needs this migration.** It supplies invoicing, revisions and
`short_code` — none of which the QR redesign reads. **My recommendation: exclude it too, and
review it separately.** That takes the authorisation down to five clean additive migrations.

---

## §2–§6 — the five clean ones

### `20260705220000_refund_events`
- **Creates:** table `refund_events` (absent on production). FKs to `restaurants`, `orders`,
  `payments`, `staff_members` — all present. Two indexes, RLS enabled, two policies.
- **Nullable/defaults:** `reason` nullable; `status` NOT NULL DEFAULT `'completed'` with a CHECK;
  `created_at` NOT NULL DEFAULT `now()`. All on a new empty table.
- **Backfill:** none. **Existing rows touched:** none.
- **Locks:** none on any live table. FK creation takes a brief `ShareRowExclusiveLock` on
  `orders`, `payments`, `restaurants`, `staff_members` — milliseconds at these volumes.
- **Additive:** yes. No drops, no type changes, no `NOT NULL` on an existing column.
- **Rollback:** `DROP TABLE refund_events;` — clean, it holds no data.
- **Live-traffic conflict:** none. Nothing writes to a table that does not exist.
- **Not needed by Deploy 3 or 4** — include only if you want it.

### `20260812130000_tabs_pin_reset_token`
- **Adds:** `tabs.pin_reset_token text`, `tabs.pin_reset_token_expires_at timestamptz`. Both
  **nullable, no default.** Two column comments. One partial index
  `WHERE pin_reset_token IS NOT NULL`.
- **Backfill:** none. 26 rows, all left `NULL`.
- **Locks:** `ACCESS EXCLUSIVE` on `tabs` for the ALTER — blocks reads and writes while held.
  Nullable-no-default columns are metadata-only, so microseconds on 26 rows. The index is
  `CREATE INDEX` (not `CONCURRENTLY`): `ShareLock`, blocks **writes** only, and the partial
  predicate means it indexes zero rows.
- **Additive:** yes.
- **Rollback:** `DROP INDEX tabs_pin_reset_token_idx; ALTER TABLE tabs DROP COLUMN pin_reset_token,
  DROP COLUMN pin_reset_token_expires_at;` — reversible, no data loss (columns are empty).
- **Live-traffic conflict:** `tabs` is written during a live visit (join, rename, ready-to-pay).
  The ALTER takes an exclusive lock, so a write arriving in that window **waits**, it does not
  fail. It also queues behind any open long transaction on `tabs` — the real risk, and the reason
  to apply during quiet hours.

### `20260813120000_order_editing_lock` — the one Deploy 3 needs
- **Adds 8 columns to `orders`:** `edit_lock_token uuid`, `edit_lock_session_id text`,
  `edit_lock_expires_at timestamptz`, `customer_edited_at timestamptz`, `total_before_edit numeric`
  — all **nullable, no default**; plus `customer_edit_count integer NOT NULL DEFAULT 0`,
  `requires_reacceptance boolean NOT NULL DEFAULT false`, `edit_history jsonb NOT NULL DEFAULT
  '[]'::jsonb`.
- **Adds 12 columns to `order_requests`:** the same eight plus `items_customer jsonb`,
  `subtotal_customer numeric`, `tax_customer numeric`, `total_customer numeric` — all nullable.
- **Backfill:** none written by hand. The three `NOT NULL DEFAULT` columns give every existing row
  a value, but **PostgreSQL 11+ stores a non-volatile default as catalog metadata and does not
  rewrite the table**, so 2,678 `orders` rows are not touched on disk.
- **Locks:** `ACCESS EXCLUSIVE` on `orders`, then on `order_requests`. Metadata-only, so
  milliseconds — but `orders` is the busiest table in the system and this blocks reads *and*
  writes while held.
- **Additive:** yes. `NOT NULL` appears only on **new** columns, each with a default; no existing
  column's nullability changes, no type changes, no drops.
- **Rollback:** `ALTER TABLE orders DROP COLUMN edit_lock_token, … ;` and the same for
  `order_requests`. Fully reversible — every column is empty immediately after the migration.
  **Not reversible after the editor has run**, because `edit_history` then holds the only record of
  what a customer originally ordered.
- **Live-traffic conflict:** it adds columns to `orders`, which live traffic writes to constantly
  (order placement, status changes, payment confirmation). It does **not** modify any column live
  traffic writes — every one is new. A concurrent write waits for the lock rather than failing.

### `20260814090000_tabs_linked_unpaid_tab`
- **Adds:** `tabs.linked_unpaid_tab_id uuid`, **nullable, no default**, no FK. One comment, one
  partial index.
- **Backfill:** none. 26 rows left `NULL`.
- **Locks:** `ACCESS EXCLUSIVE` on `tabs` (metadata-only), then `ShareLock` for the index.
- **Additive:** yes. **Rollback:** drop the index, drop the column. Reversible, no data loss.
- **Live-traffic conflict:** same as §3 — `tabs` is live, the lock is brief, writes wait.

### `20260816090000_orders_source_request_id`
- **Adds:** `orders.source_request_id uuid REFERENCES public.order_requests(id)`, **nullable, no
  default.** One comment, one partial index.
- **Backfill:** none. All 2,678 rows left `NULL` — the comment is explicit that NULL means "did not
  come from a request", never "the link is missing".
- **Locks:** `ACCESS EXCLUSIVE` on `orders` for the ALTER. The FK also takes
  `ShareRowExclusiveLock` on `order_requests` (8 rows) and validates the new constraint — trivial,
  because every value is `NULL`.
- **Additive:** yes.
- **Rollback:** `DROP INDEX orders_source_request_id_idx; ALTER TABLE orders DROP COLUMN
  source_request_id;` — this drops the FK with the column. Reversible, no data loss.
- **Live-traffic conflict:** adds a column to `orders`; modifies none. The FK means an `orders`
  insert now also touches `order_requests` for validation — no behaviour change while the column
  is `NULL`, which it is for every write until Deploy 4 ships.

---

## Is anything irreversible?

**No, at the moment of application.** Every one of the five is reversible by dropping what it
created, and no existing row is modified by any of them.

**Two become irreversible later, once code writes to them:**

- `orders.edit_history` / `order_requests.edit_history` — after the editor runs, this JSONB is the
  only record of what the customer originally ordered. Dropping the column destroys that history.
- `refund_events` — an append-only ledger, if you include it and anything writes to it.

`20260705210000` is the exception even at application time: its two `UPDATE`s and its
`CREATE OR REPLACE FUNCTION` are not undone by dropping the tables it creates.

## Recommended authorisation

Apply **four**, in this order, and only these:

```
1. 20260812130000_tabs_pin_reset_token.sql        tabs: 2 nullable cols + partial index
2. 20260813120000_order_editing_lock.sql          orders + order_requests: 20 cols   <- Deploy 3 needs this
3. 20260814090000_tabs_linked_unpaid_tab.sql      tabs: 1 nullable col + partial index
4. 20260816090000_orders_source_request_id.sql    orders: 1 nullable col + FK + index
```

Hold `20260705210000` (not additive, and nothing needs it) and `20260705220000` (nothing needs it).
Exclude the staging seed and the unique index permanently as above.

**How I would run them:** one at a time through `scripts/safe-supabase-linked.ts`, project ref
asserted before each, a read-only column probe after each to confirm the columns landed, and the
`orders` ones during quiet hours because they take a brief exclusive lock on the busiest table.
Migrations are applied but **not recorded in the ledger** by `db query` — the production deploy's
drift guard will report them as undocumented until `migration repair` is run, which is a known
follow-up and not a failure.
