# Handover — the restaurant switcher, 2026-08-20

Branch `fix/sidebar-restaurant-switcher`, off `cloudflare-staging` (`d913a34`).
Commits `e4c1d26` (the switcher) and `54bbdd4` (the probe).

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
