# `staging.yml` asserts against PRODUCTION, and what it would take to stop

Ruling 2026-08-25: point that step at staging secrets. This is the verification the ruling required
first — **per suite, per test, against staging** — because the change alters what these five have
been asserting for months.

## The defect

```yaml
- name: Unit and schema tests (no HTTP)
  run: npx jest --testPathPattern="schema-constraints|supabase-schema|payment|apk-terminal|capabilities"
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}          # <- PRODUCTION
    SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

The repo already records what the unprefixed names are, in `production-worker.yml`:

> *That step passes the UNPREFIXED SUPABASE_\* secrets, which in this repo are the PRODUCTION ones …
> Copying it here would point a test suite at the production database on every deploy.*

`STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY` and `STAGING_SUPABASE_SERVICE_ROLE_KEY` all
exist as secrets, so the switch itself is three lines.

**This is why both versions of `d5344c9` were wrong.** The suites named production ids because CI
runs them against production; I re-pointed them at staging fixtures, so they passed locally and
failed in CI; the revert restored them, so they pass in CI and fail locally. Neither state is right
because the environment and the fixtures disagree.

## Per-test verdict, measured against staging

### `apk-terminal`

| test | against staging |
|---|---|
| Riviera has `finatic_terminal_sn` set | **MEANINGLESS.** Zero staging venues have a terminal SN. |
| Riviera terminal SN matches P5 or dev phone | **MEANINGLESS.** Asserts *physical hardware* — that a specific live venue is paired with one of two specific devices. Pairing a fake serial to read it back asserts only that the column round-trips. |
| Orders have a timestamp column | fine — schema |
| All Riviera order statuses are valid | fine once re-pointed — staging has 17 fixture orders |
| No pending orders without a `tab_id` | **THE INVARIANT IS FALSE ON STAGING.** One of the 17 is a pending order with a null `tab_id`, and a tab-less order is a legitimate shape. It would be red forever for a correct row. |

### `supabase-schema`

| test | against staging |
|---|---|
| Riviera row exists | re-point |
| Riviera has ~196 menu items | **THRESHOLD IS PRODUCTION-SCALE.** Staging's fixture venue has 31. Replace with the property the threshold was guarding: *anon's count equals the service role's count, and is non-zero* — that catches an RLS change hiding menu rows from every QR customer, without hardcoding a size. |
| Riviera has ~29 menu categories | same; and note `menu_items` has `category_id`, not `category` |
| Riviera credentials are populated | re-point — staging's fixture venue does carry Finatic credentials |
| `tabs.settled_type` / `orders.customer_ready_to_pay` exist | fine — schema |
| No menu item cross-contamination | fine, but **both ids were production**, so two empty sets trivially did not overlap. Needs staging ids *and* a control that both sides are non-empty. |

### `schema-constraints`

| test | against staging |
|---|---|
| `payment_methods` CHECK rejects invalid values | fine — already repaired with a positive control that reads a real row first, so it can distinguish *enforced* from *dropped*. Re-point the id. |
| `restaurant_features` has all expected columns | re-point |
| ChowNow `kiosk_enabled` is true | **PRODUCTION CONFIGURATION, not schema.** The column's existence is already covered by the test above. |
| the six schema/RLS tests | fine — schema-level, environment-independent |

### `payment`

| test | against staging |
|---|---|
| Checkout credentials present or fallback documented | re-point, and assert the *pair* invariant — both set or both null — across every venue rather than one id, so it cannot go vacuous again |
| Tab schema / settled_type values | fine — now service-role after #284 |
| Finatic developer portal reachable | fine — external |

### `web-routing`

| test | against staging |
|---|---|
| `/table/1` responds 200 | **UNSATISFIABLE ON STAGING.** The rewrite is gated on an exact host match for `riviera.flashtap.app`; the staging worker 404s, and with a `Host:` header Cloudflare returns 403 before the worker runs. Measured. Already covered offline, with positive controls, by `table-landing-routing`. |
| Unknown subdomain returns non-200 or redirect | **CANNOT FAIL.** Accepts `301, 302, 404` **and** `200`, with `expect(true).toBe(true)` in its catch. |
| the three reachability tests | fine |

## Summary

- **6 tests are meaningless or false against staging** and should be deleted, not made to pass:
  the two terminal-hardware assertions, `No pending orders without a tab_id`,
  `ChowNow kiosk_enabled is true`, `/table/1 responds 200`, `Unknown subdomain…`.
- **2 tests are production-scale thresholds** that should become properties (anon count == service
  count) rather than numbers.
- **2 tests are currently vacuous** regardless of environment: the cross-contamination test compares
  two empty sets, and `Unknown subdomain` cannot fail.
- Everything else is a straight fixture re-point.

## Why the switch is NOT made in this commit

Flipping the three secret names is three lines and would turn CI red immediately, because the
fixtures are production ids. The switch and the fixture work are **one change or nothing** — which is
exactly the trap `d5344c9` fell into by doing the second half without the first.

That change deletes six tests and rewrites two more on the money path. It is mechanical but it needs
someone awake to it, and doing it at the end of a long unattended run is how the third wrong version
gets written. **The verification the ruling asked for is above; the edit is the next sitting.**
