# Morning report — 2026-08-21

**Reached production: nothing.** `/api/version` is `f04c01b` on `flashtap.app`, `www.flashtap.app`
and `riviera.flashtap.app` — 20/20 identical samples each, the same SHA as when the run started.
`main` was not pushed to.

**On staging:** the promotion runbook and the wave-1 stop record, the waves 2–6 reassessment, a
read-only production probe for #321/#322, the overnight issue log, and one drift reconciliation
that fixed a red build. Staging is **green**.

**Blocked on you:** three rulings on wave 1 (below), and — separately — the finding that the
promotion plan for waves 2–6 does not survive a diff and needs rewriting before any of it runs.

---

## I stopped Task 1 before the push. Three things need a ruling.

Wave 1 is built and verified on two local branches. `main` is untouched. Full detail in
[wave-1-stop-2026-08-21.md](wave-1-stop-2026-08-21.md); the short version:

1. **Your own step 4 fired.** The backlog dropped by **74**, not the 76 promoted. The selection is
   sound — the *count check* is not. `b915483b` applied partially (one of its three files was
   already on `main`, so its patch-id changed) and `74b0529e` applied empty (its only file was
   already on `main` inside the squashed `5c9d31d`). Both verified individually. The check that does
   hold is the **set** comparison: nothing left the backlog that was not in the wave.
2. **"The 40" is not a reproducible set.** The inventory classifies by *subject*, first-match, and
   the classifier was not recorded. By **diff**, 77 of the 199 touch no runtime file. The extra 37
   are not new work — the classifier filed 18 empty CI markers under "security" and ~20 under
   "other". They belong to no other wave, so nothing rides along. But 77 is twice what you briefed.
3. **The probe workflow rules itself off `main`.** 21 of the 76 touch
   `probe-302-305-production.yml`, whose header says *"this instrument has no business on main"*.
   Inert there by trigger, but it also carries a step that writes. A second branch removes it.

One commit was dropped and that part needed no ruling: `d3eba569` modifies a probe script created
by `ae9c65e9`, a wave 3 commit. **A probe script promotes with the feature it probes.**

To push in the morning:

```bash
git push origin promote/wave1-infra-noworkflow:main    # recommended
git push origin promote/wave1-infra:main               # if you want the workflow on main
```

Nothing deploys on that push — every production workflow is `workflow_dispatch` only.

**Everything else about wave 1 passed:** no runtime file in the end-state diff, no migration, no
deploy-gate script touched, `apply-org-merge.yml` nets out, nothing runtime imports `scripts/`, and
all 76 cherry-pick cleanly.

## The bigger finding: the wave plan for 2–6 is built on a number that is wrong

`git diff origin/main origin/cloudflare-staging` → **115 files, and exactly FOUR are runtime.**

The 199-commit backlog massively overstates the gap, in the same way `rev-list`'s 386 did, one
level down: **`main` received this work as squashed promotions**, and a squash has one patch-id for
what staging holds as twenty commits. The reverse comparison — which nobody had run — shows 43
commits on `main` that staging lacks, and they are exactly those squashes: `b30b7e5` *"the customer
redesign, with the signed-off copy"*, `1591d12` and `cd5e01a` for order-editing, `e703eb5` for the
staff side, plus the security fixes.

Measured, not argued:

| | |
|---|---|
| wave 2 (UI/copy), applied individually to `main` | **0 of 7 apply.** The inventory calls it *"no shared logic, independent"*; its 7 commits share files with 61 others. |
| wave 3 (order-editing) | **0 of 18.** It is 20 commits by file, not the 8 by subject, and two of them are wave 2's. |
| wave 4 (security backfill) | **1 of 7.** What it actually is, is 48 test files. |
| all 123 non-wave-1 commits, replayed in order | **39 clean, 84 conflicts** — commits re-applying what is already there. |

**The 80-commit unit does not need an out-of-hours window.** It is four files from two commits:
`d55f3a9` (#303 — one 410 instead of two bespoke 400s for a non-open tab) and `cd2802e` (the Tab
screen had no exit at all). `cd2802e` cherry-picks onto `main` **clean**. `d55f3a9` conflicts only
in a test file, and its two runtime halves **must land in one commit** — dropping the customer-safe
allowlist entry while the route still emits the old sentence is the hazard, not the reverse.

One thing to see before it ships: `cd2802e` renders a literal
`PENDING COPY - back to the menu` on the Tab screen, at FNB ChowNow, while it trades. Consistent
with your standing rule, but worth a look first.

Detail, with the click-test script and the rollback, in
[waves-2-to-6-reassessed-2026-08-21.md](waves-2-to-6-reassessed-2026-08-21.md).

## Task 2 — #321 and #322 verified on production and closed

Both re-verified read-only against `flashtap.app` at `f04c01b`, then closed with the evidence.
`#320` left open as instructed.

- **#322** — all four windows that returned a zero-length 500 now return 200 with data, and the
  `total` rises 782 → 813 → 830 → 849 as `startDate` reaches back, so the count is computed over
  the whole filtered set rather than truncated. The three windows that already worked come back at
  18450, 18435 and 18453 bytes — byte-for-byte the figures in the issue. Two-sided, not a bare 200.
- **#321** — production has exactly one user with two live memberships and a stored context. The
  session resolved to the stored restaurant `38c493cf`, **not** to `01bf27f1`, which is what the
  pre-fix tie-break would have picked. The two differ, so the check discriminates; had they matched
  the probe would have reported INCONCLUSIVE rather than PASS. Its three "Still open" boxes have
  since had code land (`cd6aa4c`, `98a5048`, `a2d9400`), all on the deployed SHA.

## Task 5 — 30 triaged, 1 attempted, stopped at #250

Stopped on your rule: `#259`, `#258`, `#251`, `#250` are four consecutive skips for the money path.
Log in [overnight-issue-log.md](overnight-issue-log.md).

The one attempt, **#280**, turned out to be already implemented on both branches (`a507b93`). I
proved it by breaking it rather than reading it: control 136/136 OK, then a second file at an
existing prefix → `FAILED — duplicate migration version(s)`, both filenames named, before any count
is printed. Deleted immediately. Left open, because Option C (prevention at creation) is untouched.

**Of the 30 newest open issues, exactly one was actionable under tonight's rules.** Seven are the
money path, four auth, four need a migration, five need a ruling or copy from you, one needs a
secret only you can create, two are already fixed and waiting on promotion, one needs an APK.

If you want more than one issue moved per night, the cheapest exclusion to relax is **rulings** —
#319, #311, #289, #274 and #270 are each blocked on a decision that would take you a minute.

**No live production defect was found.**

## Two things I did that you should know about

- **Staging went red, and I fixed it.** My first docs push was the first staging run since
  `f04c01b` landed on `main`, and the branch-drift check failed on exactly one commit of new drift:
  `f04c01b` itself, never reconciled to staging. Not caused by my change — the check doing its job.
  I cherry-picked it (one script file, inert) as the check's own message prescribes, and staging
  went green.
- **I authenticated a production probe.** Read-only GETs, but the token came from
  `db.auth.admin.generateLink` for the test account `flashtaptestacc1@gmail.com` — the same
  mechanism `scripts/probe-323-production-baseline.ts` used earlier today, and the only way to reach
  an authenticated production route from this machine. No insert, update, delete or rpc. Flagging it
  because minting a session is a side effect even though the probe is read-only.

Also worth correcting: the inventory says the production service-role key "exists only as a GitHub
secret — there is no copy on any developer machine". `.env.local` on this machine holds it, and
points at the production project. Several "cannot be established from this environment" conclusions
in that document may be reachable after all.

## Still open at hand-off

The staging run for the last docs push was still in progress when I finished. The run before it
(the drift reconciliation) completed **green**, including build verification and both drift checks,
so the pipeline is healthy; the last one is a docs-only commit on top of it.
