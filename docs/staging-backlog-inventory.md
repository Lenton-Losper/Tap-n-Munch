# Staging backlog inventory — 2026-08-20

What sits on `cloudflare-staging` and has never reached `main`, and in what order it can safely be
promoted. Produced after the resolver deploy (`13ca90d`); nothing here has been merged,
cherry-picked or deployed.

**Baselines:** `origin/main` = `13ca90d` · `origin/cloudflare-staging` = `0e7800a`

## Method, and what it corrects

Raw `git rev-list origin/main..origin/cloudflare-staging` reports **381** commits. That number is
wrong for this purpose: much of the backlog has already reached `main` as cherry-picks with
different SHAs, so reachability counts them as absent. `git cherry` compares **patch-ids**:

| | |
|---|---|
| commits examined | 326 |
| already on `main`, patch-equivalent | 127 |
| **genuine backlog** | **199** |

Date span **2026-08-05 → 2026-08-19**. This is two weeks of work, not years of drift.

Two figures quoted earlier in this work were wrong and are corrected here: "143 unrelated commits"
was a keyword filter, not a patch-id result; the true figure is 199. And the reverse gap —
commits on `main` absent from staging — is **zero migrations**, so staging is a superset
schema-wise.

---

## 1. Migrations — the gating list

Migration files on `main`: **132**. On `cloudflare-staging`: **136**. The gap is **four files**,
introduced by just **two** commits.

Six further migrations were *touched* by backlog commits but are byte-identical on both branches —
they reached `main` by other routes and are **not** part of the gap:
`20260806000000_restaurant_tables_unique_table_number`, `20260811120000_tabs_anon_grant_drop_members`,
`20260812130000_tabs_pin_reset_token`, `20260813120000_order_editing_lock`,
`20260814090000_tabs_linked_unpaid_tab`, `20260816090000_orders_source_request_id`.

### 1.1 `20260705210000_post_payment_order_lifecycle.sql`
*Arrives via `76153d8` — "reconcile staging migration ledger".*

Adds `restaurants.short_code` (+ seeds `RIV`/`FNB`), creates `document_sequences`, creates
`generate_document_number()`.

**Production state, probed read-only:**

| object | production |
|---|---|
| `restaurants.short_code` | **ABSENT** |
| `document_sequences` | PRESENT — but created by a **`main`** migration (`20260705280000_business_documents.sql`), not this one |
| `generate_document_number()` | **UNKNOWN** — see below |

The function probe returned "absent", and that is **not trustworthy**. Six `main` migrations
reference the function, and `20260727140000_revoke_stray_grants_security_definer_functions.sql`
explicitly revokes its grants — so PostgREST cannot see or call it whether or not it exists. Treat
as unknown until read from `pg_proc` via the guarded CLI wrapper.

**Backward-compatible with `26acbda`-era code: yes, trivially.** `short_code` is referenced by **no
application code on either branch** — grep of `app/`, `lib/`, `components/` returns nothing. The
column is inert. `ON CONFLICT`/`IF NOT EXISTS` throughout.

**Real gap: the `short_code` column only.**

### 1.2 `20260705220000_refund_events.sql`
*Arrives via `76153d8`.*

Creates `refund_events` (FKs to `restaurants`, `orders`, `payments`, `staff_members`), two indexes,
RLS enabled, two staff policies keyed on `user_restaurant_ids()`.

**Production state: table ABSENT.**

**Backward-compatible: yes.** Additive only; touches no existing table. Referenced by exactly one
file on either branch — `lib/supabase/schema-probe.ts`, a diagnostic — so no feature depends on it.

### 1.3 `20260717120000_seed_whatsapp_account_staging.sql`
*Arrives via `76153d8`.*

**MUST NEVER BE PROMOTED.** It inserts a WhatsApp account row for restaurant
`a1999166-ddfa-40d1-ad1f-2f01282a1652` — that is **"staging test"**, a staging-only restaurant that
does not exist in production. It is staging seed data that was committed retroactively by the
ledger reconciliation.

Verified: the row (`phone_number_id 1273668565820748`) is **absent from production**. Correct, and
it must stay that way. Any promotion of `76153d8` must exclude this file explicitly.

### 1.4 `20260809120000_orders_unique_order_number.sql`
*Arrives via `9d7d81e` — "commit the order-number unique index to staging, **scoped**".*

Creates a **partial** unique index on `orders (firebase_restaurant_id, order_number)` where both are
non-null.

**Production state: UNKNOWN.** A partial index is not visible through PostgREST and production
cannot be linked from this environment. `orders.firebase_restaurant_id` **is populated** in
production, so the index would bind to real rows.

**This is the only migration in the gap that can fail on apply.** `CREATE UNIQUE INDEX` aborts if
duplicates already exist. Its own commit message says "scoped", implying it was applied narrowly.
**Do not promote it without first counting duplicates in production**:

```sql
SELECT firebase_restaurant_id, order_number, count(*)
FROM public.orders
WHERE firebase_restaurant_id IS NOT NULL AND order_number IS NOT NULL
GROUP BY 1,2 HAVING count(*) > 1;
```

### Migration verdict

| file | prod state | back-compat | risk |
|---|---|---|---|
| `post_payment_order_lifecycle` | partial (`short_code` missing) | yes — column unused | low |
| `refund_events` | absent | yes — additive, unused | low |
| `seed_whatsapp_account_staging` | absent (correct) | **n/a — never promote** | — |
| `orders_unique_order_number` | **unknown** | conditional | **can fail on apply** |

**Nothing in the application backlog depends on any of these four.** The schema gap and the code
backlog are effectively independent, which is the single most useful finding in this document.

---

## 2. The remaining commits, by domain

199 total, classified by subject. Counts are first-match, so a commit appears once.

| group | commits | depends on a §1 migration? | ships independently? |
|---|---|---|---|
| infra/CI, docs, probes | 40 | no | **yes** — inert at runtime |
| guest/QR (cart, my-orders, browse, menu) | 34 | no | yes, but see coupling below |
| tabs (PIN, membership, join, settlement) | 30 | no | **entangled** with guest/QR |
| security-labelled | 28 | no | see §3 — mostly already on main |
| payments (PayCloud, settle, terminal, reconcile) | 16 | no | **entangled** with tabs |
| orders (numbering, refusal copy, source_request_id) | 14 | `9d7d81e` carries §1.4 | yes if §1.4 held back |
| UI/copy (30 signed-off strings, toasts, render) | 9 | no | **yes** — lowest risk in the set |
| order-editing (customer edits, edit lock, re-acceptance) | 8 | no (its migration is already on main) | yes — self-contained feature |
| other | 20 | `76153d8` carries §1.1–1.3 | mixed |
| stock | 0 | — | — |

**Coupling that matters:** guest/QR + tabs + payments (80 commits) repeatedly touch the same files —
`lib/guest-orders/queries.ts`, `lib/tab-session.ts`, the tab routes. Six commits in guest/QR are
successive fixes to one thread ("the by-session lookup matches BOTH placer columns" → "the by-id read
carries every session id" → "the last six call sites carry every session id"). Promoting a subset of
that thread ships a half-applied fix. **Treat those three groups as one unit.**

---

## 3. Security — the expected answer is wrong

28 commits classify as security by subject. **Most are not fixes.** Roughly 18 are CI marker commits
of the form *"probe: re-verify the production redaction after `<sha>` [probe-302-305-production]"* —
empty commits whose only job is to trigger a workflow.

The genuine security fixes are six:

| commit | fix |
|---|---|
| `9b529be` | #122 — authenticate the by-payment-ref lookup (order enumeration) |
| `22bd729` | #122 — CSPRNG payment references, not `Math.random` |
| `6167f5d` | #254 — `?ref=` injection (unauthenticated order disclosure) |
| `23bb150` | one ownership predicate, CSPRNG for the id it authorises on |
| `2417411` | #262 — anon-grant migration |
| `8392da8` | a session ended by Close Table is over, enforced server-side |

**Every one of them already has its runtime code on `main`.** Checked file by file, excluding tests,
scripts and docs: all six show zero differing runtime or migration files. What is missing from `main`
is their **test coverage and CI probes**, not their protection.

I checked this specifically because a prior session's note recorded the `?ref=` injection as an open
production gap. **That note is stale** — `lib/guest-orders/queries.ts` and
`lib/guest-orders/validation.ts` are byte-identical on both branches. Production is protected.

One apparent gap — `hooks/useSessionTokenGuard.ts` missing from `main` — was a **false positive** in
my own comparison (`git rev-parse` echoes the ref on failure instead of returning empty). The file
exists on **neither** branch; it was added and removed within the same change.

**There is no security promotion track, because there is no security gap.** Those commits promote as
ordinary test/CI backfill, at normal priority.

---

## 4. Promotion order

Nothing here is urgent. The one production defect this exercise found —
Order History returning an empty 500 on wide date ranges — is **not** in the backlog; it is present
on `main` and filed separately.

**Wave 1 — inert, no runtime effect, no migration.**
docs, probe scripts, CI workflow steps (~40 commits). Ship together, verify only that CI still
passes. Reduces the backlog by a fifth and makes every later diff readable.

**Wave 2 — UI/copy (9).**
The 30 signed-off strings and the placeholder removals. No schema, no shared logic. Lowest-risk
runtime change in the set. Independent.

**Wave 3 — order-editing (8).**
Self-contained feature; its migration (`20260813120000_order_editing_lock`) is *already* on `main`,
so this is code-only. Independent of waves 1–2.

**Wave 4 — security test/CI backfill (~10 real, minus markers).**
No protection changes, so this is coverage, not risk reduction. Worth doing before wave 5, because
those tests cover the files wave 5 edits.

**Wave 5 — guest/QR + tabs + payments as ONE unit (80).**
The entangled core. Do not split. Needs its own staging soak and a click-test of the full customer
path plus a real settlement, because it touches the money path and the session-boundary code. This
is the wave that deserves an out-of-hours window.

**Wave 6 — orders (14), excluding `9d7d81e`.**
Hold `9d7d81e` back until the duplicate count in §1.4 is run.

**Separately, and not in any wave — the four migrations.**
- `refund_events` and the `short_code` column can be applied at any time; both are additive and
  unused. Neither unblocks anything, so there is no reason to hurry them.
- `orders_unique_order_number` only after the duplicate count.
- `seed_whatsapp_account_staging` **never**.

## What this document does not establish

- Whether `generate_document_number()` exists in production. Needs a `pg_proc` read through
  `scripts/safe-supabase-linked.ts` with production linked; linking is blocked in this environment.
- Whether `orders_unique_order_number` is applied. Same limitation.
- Whether production's **migration ledger** matches its actual schema. `76153d8` exists precisely
  because staging's ledger had drifted from its schema; production has never had the same audit.
  That audit is the natural next task, and it is a prerequisite for trusting any "applied/not
  applied" answer above beyond the four files checked here.
- Group classification is by commit subject, not by diff analysis. The counts are sound; an
  individual commit may sit in the wrong group.
