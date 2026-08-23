# Production ledger vs schema, and the inventory's dead ends re-opened

2026-08-21. Read-only throughout: GETs and one `STABLE`, `SELECT`-only RPC. No insert, update,
delete, DDL or migration application; nothing wrote to `supabase_migrations`.

Two re-runnable scripts:
`scripts/audit-production-ledger-vs-schema.mjs` and
`scripts/audit-inventory-dead-ends-production-readonly.mjs`. Both refuse to run unless
`.env.local` names the production project.

---

## Why these were "unanswerable"

`docs/staging-backlog-inventory.md` closes several questions with *"production cannot be linked
from this environment"*, on the belief that the production service-role key existed only as a
GitHub secret. **It is in `.env.local`**, which points at `ihlmmpmolnpchzgwyhgh` — production. Every
conclusion below was blocked on that belief.

Not everything opens up. PostgREST exposes tables, views and columns; it does **not** expose
`pg_constraint` or `pg_proc` — both measured returning `HTTP 404 PGRST205`. So indexes, CHECK
constraints, RLS policies, grants, triggers and function bodies stay out of reach by reading alone.

## Every conclusion that was blocked, and where it stands now

| # | inventory said | now |
|---|---|---|
| 1 | `generate_document_number()` — **UNKNOWN**, "treat as unknown until read from `pg_proc`" | **STILL UNESTABLISHED** — but for a different reason than the inventory gives. See below. |
| 2 | `orders_unique_order_number` applied? — **UNKNOWN** | **NOT APPLIED.** The ledger holds 132 versions and does not include `20260809120000`. |
| 3 | Does production's ledger match its actual schema? — never audited | **AUDITED.** Ledger↔files exact; schema probe found **one** mismatch. |
| 4 | `restaurants.short_code` — ABSENT (probed) | **CONFIRMED ABSENT** — `42703 column restaurants.short_code does not exist`. |
| 5 | `refund_events` — ABSENT | **CONFIRMED ABSENT** — `PGRST205`. |
| 6 | `seed_whatsapp_account_staging` row — absent, "and it must stay that way" | **CONFIRMED ABSENT**, and so is the restaurant it seeds for. |
| 7 | §1.4 duplicate count — *"do not promote it without first counting duplicates in production"* | **RUN. 282 duplicate pairs. The index cannot be created.** See below — this is the finding. |

## 1. Ledger vs committed files — exact

```
production ledger rows           : 132
committed migrations on main     : 132
applied with no committed file   : 0
committed on main but not applied: 0
duplicate versions in the ledger : 0
```

Read against the staging checkout (136 files) the only difference is the four known gap files —
`post_payment_order_lifecycle`, `refund_events`, `seed_whatsapp_account_staging`,
`orders_unique_order_number` — which is the inventory's §1, confirmed independently and from the
ledger side rather than by inference.

**Production's ledger has not drifted from its committed files in either direction.** That was the
open question, and it is the prerequisite the inventory named for trusting any applied/not-applied
answer.

## 2. Ledger vs actual schema — one mismatch

Every applied migration was parsed for the objects it claims to create, and every claim PostgREST
can see was probed.

```
distinct tables/views claimed : 63   ->  62 PRESENT, 1 NOT_VISIBLE
distinct columns claimed      : 110  -> 110 PRESENT
objects PostgREST cannot see  : 462  (INDEX 130, CONSTRAINT 142, POLICY 131, FUNCTION 48, TRIGGER 11)
```

**The mismatch: `terminal_activation_codes`.**

| | |
|---|---|
| claimed by | `00000000000000_baseline.sql` and `20260628140000_add_terminal_activation_codes.sql` |
| both migrations | recorded **applied** in production's ledger |
| production | `HTTP 404 PGRST205` |
| staging (control) | `HTTP 200`, empty array |
| control on production | `restaurant_terminals` → `HTTP 200`, so PostgREST and its schema cache are working |

The ledger says two migrations that create this table ran. Production does not serve it; staging
does. **That is ledger-vs-schema drift, and it is exactly the class the inventory said had never
been checked on production.**

**Blast radius: none found.** `terminal_activation_codes` is referenced by **no TypeScript anywhere
in this repository** — not in `app/`, `lib/`, `components/`, `workers/` or `scripts/`. The terminal
activation route `app/api/terminals/activate/route.ts` uses `restaurant_terminals` instead. Nothing
reads the missing table, so nothing is broken by its absence.

**What I cannot say:** whether the table is genuinely absent or merely not exposed to PostgREST.
Both read `PGRST205`, and separating them needs `pg_tables`, which is not readable. Reported as
NOT_VISIBLE rather than ABSENT for that reason.

## 3. `generate_document_number()` — still unestablished, and two wrong answers avoided

Worth stating precisely, because both tempting answers are wrong:

- **A direct call is inconclusive — but not because the grants are revoked.** The inventory
  attributes it to `20260727140000_revoke_stray_grants...`. The actual reason a no-argument call
  returns `PGRST202` is that PostgREST resolves overloads **by argument name**, and this function
  takes `p_prefix` and `p_sequence_name` (`lib/receipts/issueReceipt.ts:177`). A `{}` body cannot
  match it whether or not it exists. Calling it correctly *would* settle it — and would also consume
  a sequence value, which is a write, so it was not called.
- **"`business_documents` has numbered rows, so it ran" is a false positive.** `issueReceipt.ts`
  asks for prefix `RCT` from sequence `rct_number_seq`. Production's three rows are
  `document_type: 'invoice'` numbered `"1"`, `"2"`, `"1"` — bare, and restarting per restaurant.
  They come from the admin documents routes via `document_sequences`, not from this function.
  Evidence of a different path is not evidence of this one.

**It needs a write to establish. Left unestablished.**

## 4. The §1.4 duplicate count — and a live production defect

The inventory says: *"Do not promote it without first counting duplicates in production."* Run,
paginated (an unpaginated read stops at 1000 and would have under-reported — #323's exact failure):

```
orders with both columns non-null : 2809
distinct (firebase_restaurant_id, order_number) pairs : 1865
duplicate pairs : 282        ->  CREATE UNIQUE INDEX WOULD ABORT
```

**279 are legacy `restaurant_test_*` Firebase data — #324's territory. Three are FNB ChowNow, which
is trading.**

| order_number | id | placed_at | status | payment | total |
|---|---|---|---|---|---|
| 314 | `627be032` | 2026-07-23 10:44:11 | completed | paid | 40 |
| 314 | `4f86d3bd` | 2026-07-23 10:44:11 | completed | paid | 40 |
| **420** | `4517ee94` | 2026-07-24 06:40:10 | completed | paid | **34** |
| **420** | `295b2965` | 2026-07-24 06:40:10 | completed | paid | **78** |
| **448** | `509ba89d` | 2026-07-24 07:08:04 | completed | paid | **26** |
| **448** | `43e584b2` | 2026-07-24 07:08:05 | completed | paid | **46** |

**420 and 448 are not double-submits — the totals differ.** Two different sales, both paid, both
completed, sharing one number. This is #127's mechanism (`count(*)+1`, no unique constraint) firing
on two POS writes inside one second. Evidence filed on
[#127](https://github.com/Lenton-Losper/Tap-n-Munch/issues/127).

**Sequencing this implies**, and it is not what the inventory assumed:

1. #324 clears the legacy rows → removes 279 of 282.
2. **Somebody rules on the three real pairs** — renumber one of each, or scope the index so it
   cannot bind them. A decision about live financial records, not a cleanup.
3. Only then can `orders_unique_order_number` be applied.

The inventory treats §1.4 as "unknown, run the query". The query is now run, and the answer is that
the migration is blocked behind a ruling on customer data.

## What remains unestablished, and exactly why

- **Whether `terminal_activation_codes` is absent or merely unexposed.** Needs `pg_tables`.
- **Whether the unique index itself exists**, independently of the ledger. Indexes are invisible to
  PostgREST; proving it needs a duplicate insert, which is a write.
- **Every CHECK constraint, RLS policy, grant and trigger — 462 objects.** `pg_constraint` and
  `pg_proc` both return `PGRST205`. A clean run above says nothing about any of them, and #245 is
  blocked on the same wall.
- **`generate_document_number()`** — needs a call, and a call is a write.

All four would be answered by the read-only probe role being built this week. None of them is
answerable by reading harder.
