# Production scripts — run by the owner, with production credentials

Nothing in this directory has been run. This worktree has no production credentials, so every script
here is **prepared and unverified against production**. Each was smoke-tested against staging where
that was possible without changing anything; where it was not, the script says so and refuses rather
than guessing.

## The contract every script in here keeps

1. **It says what it is about to do, and against which database, before doing it.**
2. **It refuses rather than guesses.** Any precondition that cannot be established is a refusal, not
   a default.
3. **Read-only unless its name begins `apply-` or `delete-`.** The two that write say so in their
   first line of output and require an explicit `--confirm`.
4. **It prints the production project ref it connected to**, so a misconfigured env is visible in the
   first two lines rather than in the results.

## Credentials

Every script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment, and **refuses
unless the URL contains the production ref `ihlmmpmolnpchzgwyhgh`.** That guard is inverted from the
staging scripts on purpose: a staging script refusing to touch production and a production script
refusing to touch staging are different mistakes, and both are worth preventing.

```bash
# PowerShell
$env:SUPABASE_URL = "https://ihlmmpmolnpchzgwyhgh.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<production service role key>"

# bash
export SUPABASE_URL="https://ihlmmpmolnpchzgwyhgh.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<production service role key>"
```

Run every command from the repository root.

## The five, in the order worth running them

| # | script | writes? | what it answers |
|---|---|---|---|
| 5 | `probe-duplicate-charges.ts` | no | has a double charge already happened |
| 4 | `probe-terminal-versions.ts` | no | the production APK spread |
| 1 | `probe-324-orphan-orders.ts` | no | #324's three abort conditions |
| 2 | `delete-324-orphan-orders.ts` | **YES** | the delete, refused if any condition trips |
| 3 | `probe-333-abandoned-tabs.ts` | no | #333's production backlog |
| 6 | `apply-is-counter-service.ts` | **YES** | the two counter-service venues |
| 7 | `probe-127-duplicate-order-numbers.mjs` | no | what actually blocks the unique order-number index |
| 8 | `renumber-127-duplicate-orders.ts` | **YES** | the four real duplicate order numbers |

**5 and 4 first**, because they bear on the terminal decision and neither changes anything.

## #127 and #324 are one sequence, and the order is not the one the issues record

`probe-127-duplicate-order-numbers.mjs` uses direct Postgres rather than the service-role client
the rest of this directory shares — the split it measures is a single `GROUP BY … HAVING` with
three `FILTER` clauses, and paging 3520 rows into JavaScript to re-derive it would be a second
implementation of the thing being checked.

Measured on production 2026-08-26. The unique index is blocked by **945 rows**, and they separate
cleanly: **279 groups are entirely #324 stress fixtures (941 rows), 4 groups are entirely real
orders (4 rows), and NO group is mixed.** The zero is the safety argument for the delete — no
group holds a fixture and a real order, so removing the fixtures cannot strand a real order or
half-resolve a collision.

The order to run them in:

1. **Deploy `lib/orders/order-number.ts`** — the allocator change. First, not last. With the index
   in place, the old `count(*)+1` raises the same 23505 forever at a venue that has ever had a row
   deleted; `max+1` cannot.
2. `delete-324-orphan-orders.ts` — clears 941 of the 945. Measured not to move any real venue's
   allocation: the fixtures carry their own `restaurant_test_NN` firebase ids, so no real venue's
   count changes (probe section 11).
3. `renumber-127-duplicate-orders.ts` — the remaining 4. **Dry run first; it refuses by default.**
4. Only then can `20260826107000_orders_unique_order_number_production.sql` be applied.

Step 2 is only required because the index is scoped by `firebase_restaurant_id`. On
`(restaurant_id, order_number)` the fixtures do not collide at all — they hold a NULL
`restaurant_id` and Postgres treats NULLs as distinct — so that scope would need only step 3. The
probe prints both, and the migration header records the choice.
