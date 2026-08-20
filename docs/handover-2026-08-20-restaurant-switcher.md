# Handover — the restaurant switcher, 2026-08-20

Branch `fix/sidebar-restaurant-switcher`, off `cloudflare-staging` (`d913a34`).
Five commits: `e4c1d26` the switcher, `54bbdd4` the probe, `fca64ba` the resolver convergence and
the scan, `b6facea` / `9f908e2` this document.

## What the defect actually was, in three layers

The brief was "createLocation creates a restaurant nobody can enter — it never writes a
`restaurant_users` row". That premise is false and was false when filed.

1. **The row was always written.** `createLocationAction` does not insert anything itself; it calls
   `create_organization_location`, a `SECURITY DEFINER` plpgsql RPC, whose body inserts the
   restaurant, seeds roles, and inserts `restaurant_users (…, 'owner')` in one transaction. Proof on
   production: Chownow Nedbank's restaurant row and its membership row share the timestamp
   `2026-08-19T13:08:38.455036` to the microsecond — one `now()`, one transaction. Backfill count of
   restaurants with no live membership: **0 on production**, 3 on staging (all `organization_id IS
   NULL` test-harness leftovers, none from Add Location).

2. **The access existed and was unreachable.** `/api/auth/role` resolved the session's restaurant as
   `getRestaurantIdsForUser()[0]`, and the owner-first tie-break does not disambiguate two `owner`
   rows. `app/choose-context` had always written `user_active_context`, but nothing read it when
   resolving the session. **#321 (`26acbda`) fixed this on 2026-08-19** — `pickSessionRestaurant`,
   stored choice re-validated against current memberships on every call.

3. **#321 left the choice unmakeable.** Rule 3 of `resolveLoginDestination` re-validates the stored
   context and resolves past the picker for anyone who has one, so `/choose-context` is reachable
   only by typing the URL. There was no control anywhere in the product. That is what this branch
   builds.

## What shipped here

| file | change |
|---|---|
| `lib/auth/restaurant-switcher-options.ts` | new — pure view-model builder; the visibility rule and the "cannot offer a non-membership" rule live here |
| `components/dashboard/restaurant-switcher.tsx` | new — the control; renders `null` below 2 restaurants |
| `components/dashboard/dashboard-sidebar.tsx` | renders it under the restaurant name |
| `lib/settings/auth.ts` | now resolves through `pickSessionRestaurant` instead of `.limit(1)` with no `ORDER BY` |
| `__tests__/restaurant-switcher-options.test.ts` | new — 10 tests |
| `scripts/probe-switcher-staging-*.ts` | new — the live probe |

**No new endpoint, no new table, no new storage.** The choice has had somewhere to live since
`20260725120000_user_active_context.sql`; selecting POSTs to the existing `/api/auth/select-context`,
which re-derives the caller's real contexts and 403s anything not among them. That is why the
security control came free.

`lib/settings/auth.ts` mattered more than it looks: Settings is where Business & Locations lives, so a
divergent resolver there was the first place a successful switch would appear not to have worked.

Copy ships as `SWITCHER_COPY_PENDING`, five strings, each prefixed `PENDING COPY — `. Not drafted.

## Proof

`tsc --noEmit` exit 0 (tsc 5.9.3 — checked, not the `npx` 2.0.4 false-green; no `@ts-nocheck` in any
touched file). 17 unit tests pass across the new suite and #321's.

**Failing-first:** relaxing `visible: options.length > 1` to `> 0` fails 3 of the positive-control
tests. The suite notices when the load-bearing rule is removed.

**Live probe**, 17/17, against a local dev server running this branch pointed at staging — never a
deployed URL, which would exercise whatever is deployed there rather than the code under test:

- two-restaurant account: switcher visible, one entry marked current, switch accepted, session moves,
  and **the choice survives a brand-new sign-in**
- one-restaurant account: **no switcher**, and it is never offered the location it holds no row on
- that same account POSTing that location to `/api/auth/select-context`: **403**, session unmoved
- and the same endpoint accepts a legitimate switch in the same run, so the 403 is a gate, not a
  dead endpoint

## Not done

- **No screenshot.** The Chrome extension was not connected. `/dashboard` compiles and returns 200
  with the new import, but nobody has looked at the rendered control. Worth one glance before
  production.
- **Not deployed.** Branch is local. `main` and `cloudflare-staging` are identical across every file
  this touches, so it cherry-picks cleanly either way.
- **Staging debris, deliberate:** users `switcher-probe-multi@flashtap-test.invalid` and
  `switcher-probe-single@flashtap-test.invalid`, and restaurant `Switcher Probe Location`
  (`1c0b95dc-7880-41c0-a2fa-580eaa0bfc9d`) in org `1851cf3a…`. The probe is idempotent and reuses
  them. Not real data.
- **The FNB ChowNow backfill was not run** and is not needed for this. `flashtapapp2@gmail.com` holds
  no row on FNB ChowNow; that is a separate access question, and adding one grants a live restaurant
  with an external manager on it.

## Second pass — the 13 call sites, and a scan to hold them

The switcher alone would have shipped a worse bug than the one it fixed. **Thirteen** call sites
answered "which restaurant is this user on?" independently, and my first commit converged exactly
one of them.

Nine were byte-identical copies of `resolveStaffRestaurantId` in
`lib/{analytics,documents,menu,orders,recipes,settings,staff,stock,tables}/auth.ts`. Four more lived
in `app/api/auth/role`, `app/api/admin/setup-status`, `app/api/bug-reports` and
`app/api/auth/create-restaurant`. All now call `resolveSessionRestaurantId`.

**Two were already broken in production, not merely divergent.** `setup-status` and
`create-restaurant` used a bare `.maybeSingle()`, which raises PGRST116 for any account holding two
memberships. Proved by reintroducing the old shape against a live server:

```
multi   HTTP 500  {"error":"Failed to load setup status"}
single  HTTP 200  {"hasRestaurant":true,...}
```

`SetupChecklistBanner` renders on every staff page through `DashboardShell`, so
`flashtapapp2@gmail.com` — two memberships since 2026-08-19 — is hitting that 500 on every page load
on production right now. It is invisible because the banner fails quietly.

`bug-reports` attributed a report to the first membership, so a bug filed while working at one
location was filed against another.

### The scan

`scripts/check-session-restaurant-resolver.ts`, blocking in both workflows beside the order-number
guard. Two findable shapes:

- **A** — a `restaurant_users` read filtered by `user_id` alone and narrowed with `.limit(1)` /
  `.maybeSingle()`. Filtering by `user_id` **and** `restaurant_id` is an authorization check and is
  not flagged; selecting every membership without narrowing is an enumeration and is not flagged.
- **B** — `.eq('owner_id', <user id>)`, the legacy pre-`restaurant_users` provisioning column.

It **found the thirteenth site itself**, after I had enumerated twelve by hand — which is the whole
argument for it existing.

Two properties beyond matching:

- **It self-tests before it reports.** Four fixtures — two that must be caught, two that must be
  ignored — checked on every run. A detector whose regex has rotted reports `OK` over a codebase
  full of offenders, and that green is indistinguishable from a real one. Proved: renaming the table
  in the regex makes the run fail with `SELF-TEST FAILED`, not pass.
- **A stale `ALLOWED_FILES` entry is itself a failure.** An allowance guarding something that has
  moved would wave through the next real offender in that file.

Verified exit codes directly, not through a pipe: clean tree `0`, planted offender `1`, restored `0`.

### Where the stored selection lives, and what happens when it goes stale

`public.user_active_context` — a table row, `user_id` PRIMARY KEY. **Not a cookie and not the JWT**,
so it cannot be forged client-side and needs no re-issuing. RLS allows a user to `SELECT` only their
own row, and there is **no authenticated INSERT/UPDATE policy at all** — writes happen solely through
`/api/auth/select-context`, which re-derives the caller's real contexts first.

| what happens | where it is handled | result |
|---|---|---|
| restaurant deleted | FK `ON DELETE CASCADE` | context row goes with it |
| membership revoked | FK knows nothing of `restaurant_users` — row survives | re-derived every call, stored id discarded |
| membership soft-deleted | membership query filters `deleted_at IS NULL` | stops matching |
| user deleted | `ON DELETE CASCADE` from `auth.users` | row gone |
| the read itself fails | caught and logged | treated as "no preference" |

In every case it falls back to `memberRestaurantIds[0]`, then legacy `owner_id`, then null. The
stored value can only **narrow** among current memberships — never widen, so it cannot fail open;
never the sole candidate, so it cannot strand anyone on a site they cannot use.

Nine tests in `__tests__/resolve-session-restaurant.test.ts` cover exactly those rows, including the
strongest form: memberships empty but a stored row still present must return `null`, not the stored
restaurant. Failing-first — relaxing the re-validation fails 6 of them.

### The scan was written in the wrong order, and here is the payment

The rule is: write the scan, watch it fail on every offender, then convert until it passes. I did
the opposite — converted twelve by hand, then wrote the scan, which found the thirteenth. That
leaves a check which has only ever failed on one shape in one file, and a check that has barely
failed is the position the order-number helper was in before it became a script.

Reconstructed rather than claimed. A detached worktree at `54bbdd4` (the tree *before* the
conversion), with only the scan file copied in:

```
$ npx tsx scripts/check-session-restaurant-resolver.ts
check-session-restaurant-resolver: 22 finding(s).
EXIT=1
```

22 findings across all 13 offender files, both shapes, every one named:

| file | A: first-membership pick | B: legacy owner_id |
|---|---|---|
| `app/api/admin/setup-status/route.ts` | :30 | :44 |
| `app/api/auth/create-restaurant/route.ts` | :42 | — |
| `app/api/auth/role/route.ts` | — | :59 |
| `app/api/bug-reports/route.ts` | :17 | — |
| `lib/analytics/auth.ts` | :17 | :32 |
| `lib/documents/auth.ts` | :17 | :32 |
| `lib/menu/auth.ts` | :17 | :32 |
| `lib/orders/auth.ts` | :17 | :32 |
| `lib/recipes/auth.ts` | :17 | :32 |
| `lib/settings/auth.ts` | — (already part-converted at this commit) | :64 |
| `lib/staff/auth.ts` | :17 | :32 |
| `lib/stock/auth.ts` | :17 | :32 |
| `lib/tables/auth.ts` | :17 | :32 |

The same run also reported one **stale allowance** — `lib/auth/resolve-session-restaurant.ts` is in
`ALLOWED_FILES` and does not exist on that tree — which is the stale-allowance guard doing its job
unprompted.

### Two-sided on the scan itself, against a real call site

Not a synthetic fixture: `lib/orders/auth.ts` re-inlined with exactly the resolver it used to hold.

```
lib/orders/auth.ts:12   A: picks a FIRST restaurant_users row for a user
lib/orders/auth.ts:27   B: resolves a restaurant via the legacy owner_id fallback
check-session-restaurant-resolver: 2 finding(s).   EXIT=1
```

Restored: `EXIT=0`, tree clean. Red on re-inline, green on restore, correct line numbers, both
shapes.

---

# INSTRUMENT — *an affordance you did not grep is a test whose inputs never arrive*

**I recommended clicking through a picker without confirming the product could reach it, and I
described production behaviour from a working tree I had not confirmed was the deployed branch.**

Precisely what happened, because the precise version is the useful one:

- I correctly reported there was no sidebar switcher — I grepped for that.
- I then said the sign-in picker was "cosmetic" and that `/api/auth/role` "never reads
  `user_active_context`", and prescribed a soft-delete of a live Riviera membership as the way in
  today. **All three were wrong.** They were read off the primary checkout, which sits on
  `docs/agent-operating-contracts` — a branch that predates #321. `origin/main` had honoured the
  stored context since the previous day, production had been serving it for hours, and
  `https://flashtap.app/choose-context` returns 200. The human could have walked in through the front
  door. I sent them to run destructive SQL instead.

Both failures are one shape, and it is the shape the human named: **a green result from a path that
never executes.** A test whose inputs never arrive passes. A guard on a column nobody selects passes.
A recommendation to click a control that does not exist reads exactly like a recommendation to click
one that does — and an assertion about production read off a stale branch reads exactly like an
assertion about production.

The common failure is *asserting a property of a running system from a model of it*.

## The checks

1. **Before recommending a user action, grep for the control.** Its file, its render site, its
   conditional. "The app has a picker" is a claim about a component tree, and component trees are
   greppable. If it renders under a condition, evaluate the condition against the real account.
2. **Before describing runtime behaviour, establish which ref is running.** `/api/version`, 20
   samples, 20/20 (rollout is gradual). Then `git diff <deployed-ref>:path HEAD:path` on every file
   the claim rests on. A clean working tree is not evidence it matches production — this checkout was
   clean and three commits of behaviour behind.
3. **Never analyse from `restaurant-menu-screen`'s working tree by default.** It is a docs branch. Run
   `git rev-parse --abbrev-ref HEAD` first and read from `origin/main` or `origin/cloudflare-staging`
   explicitly with `git show`.
4. **Check whether the fix already shipped before designing it.** `git log --all -- <path>` and a grep
   for the issue number. #321 had already reached the same diagnosis, in a commit message that says
   so. Two days of analysis rediscovered it.

Siblings already recorded: `written-columns-are-not-selected-columns` (the route wrote a column it
never selected), `mjs-main-module-guard-false-green` (the CI step passed having run nothing),
`security-checks-need-a-positive-control` (an attack "REFUSED" by a dead endpoint),
`brief-premises-are-base-conditional` (the brief describes *some* branch). This one extends the last:
**the base you must check is not only the brief's, it is your own.**
