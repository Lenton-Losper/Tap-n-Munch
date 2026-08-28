# Followup: `main` and `cloudflare-staging` drifted 8 commits in one day

**Filed:** 2026-08-28
**Status:** OPEN. Not reconciled by this doc — see "What this does not do" below.

## What happened

By the end of 2026-08-28, `origin/main` carried 8 commits (by patch-id) that
`origin/cloudflare-staging` did not:

```
b88daa08  feat(held): collapse the list to a summary, and put the override on each card
16465f57  fix(held): the collapse never hid anything, and the override was never wired
b36f2e79  feat(held): split stranded_pending — five of seven had no payment to check
78bf370a  copy(menu): sign the mark-unavailable strings
1d23405b  fix(security): gate the waiter-flow routes on station_screens_enabled
2cc42313  docs: close the station_kind-goes-NULL investigation
fa58c792  fix(money): distinguish "paid" from "cancelled" at unpaid_total === 0
3134e28a  fix(money): supersede our fix with Max's -- same bug, more complete
```

`scripts/check-branch-drift.mjs` exists precisely to catch this and it did — it failed the
2026-08-28T10:17 `staging.yml` run naming all 8, and would fail any subsequent one until this is
resolved. Production was deployed past that failure with `skip_verification: true` on explicit
authorization, for a live money-bug fix that could not wait — a documented, ruled exception, not
a routine bypass.

## Why it happened

All 8 commits landed on `main` directly during a single overnight production-incident session:
a live money bug (auto-cancelled waiter rounds, `unpaid_total` misreading as paid), a security
gap (ungated waiter-flow routes), and a documentation closure, promoted straight to production
because the incident could not wait for the normal staging round-trip. None were also pushed to
`cloudflare-staging` in the same session — `cloudflare-staging` kept evolving on its own,
independently, including a second, more complete fix for the *same* money bug (`875e4043`,
reconciled into `main` as `3134e28a`).

The drift check's own comment already names the risk this creates: *"origin/main being ahead of
origin/cloudflare-staging is a DEFECT, not a state... a merge can revert it."* A merge from
`cloudflare-staging` back into `main` today, done carelessly, could silently undo the security
gate or the money-bug fix.

## The actual process gap

A sprint — or in this case a single incident-response night — should not end with eight commits
of production-critical work sitting unmerged on one side of a branch pair. The gate that would
have caught this earlier (`check-branch-drift.mjs` in `staging.yml`) only runs on pushes to
`cloudflare-staging`, so a night spent entirely on `main` (production incident response) produces
no failing signal until the next `cloudflare-staging` push happens to compare against a `main`
that has drifted this far. By the time the gate fired, there were 8 commits to reconcile instead
of 1.

## What this does not do

This doc does not perform the reconciliation. Cherry-picking 8 commits onto `cloudflare-staging`
carries real conflict risk — two of them (`b88daa08`, `16465f57`, the held-for-review panel work)
are already known to conflict with independent `cloudflare-staging` work on the same file, per
this session's own experience resolving an equivalent conflict earlier tonight — and
`cloudflare-staging` had a second author (Max) actively pushing to it concurrently while this doc
was written. Reconciling unattended against a branch someone else is using live is how a merge
"can revert it" stops being hypothetical. That step needs a human moment, not a blind autonomous
pass, and is left open here rather than attempted.

## Suggested fix, for whoever picks this up

- Reconcile the 8 commits onto `cloudflare-staging` (cherry-pick where clean per the drift
  script's own `ABSENT` classification; attended conflict resolution for the two `DIVERGED`
  held-panel commits) once `cloudflare-staging` is not being actively pushed to.
- Consider whether `check-branch-drift.mjs` should also run on a schedule (not only on
  `cloudflare-staging` pushes), so a `main`-only night surfaces the gap the next morning instead
  of on the next unrelated staging push.
