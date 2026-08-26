# GitHub Support ticket — stuck workflow run 32984581496

Submit at https://support.github.com/ (Actions category). Cannot be filed via API or `gh`;
the support form requires an authenticated browser session.

---

**Subject:** Workflow run stuck in `queued` with zero jobs; cancel API reports it as completed

**Repository:** Lenton-Losper/Tap-n-Munch
**Run:** https://github.com/Lenton-Losper/Tap-n-Munch/actions/runs/32984581496
**Run ID:** 32984581496

**Summary**

A `workflow_dispatch` run has been stuck in `queued` since 2026-08-26T15:16:35Z with zero jobs
ever created. It cannot be cancelled: the cancel endpoint reports the run as already completed
while the runs endpoint reports it as queued. The two APIs disagree about the same run.

**Evidence**

    GET /repos/Lenton-Losper/Tap-n-Munch/actions/runs/32984581496
      status      queued
      conclusion  null
      run_attempt 1
      created_at  2026-08-26T15:16:35Z
      updated_at  2026-08-26T15:16:35Z     <-- identical to created_at

    GET /repos/.../actions/runs/32984581496/jobs
      total_count 0

    POST /repos/.../actions/runs/32984581496/cancel   (via `gh run cancel`)
      "Cannot cancel a workflow run that is completed"

**`updated_at` has never moved off `created_at`.** The run has not been touched once in over
nine hours. No job was ever created, so this is not a hung job — it appears to be a run record
that was never assigned to a runner.

**It did not clear when the incident resolved.** The run was created during the GitHub Actions
incident of 2026-08-26 (opened ~15:09 UTC). We deliberately waited for that incident to be
fully resolved before retrying. After full resolution — githubstatus reporting All Systems
Operational with no unresolved incidents — the run is unchanged and the cancel still fails with
the same message. This is not a residual effect that is self-healing.

**Other workflows in the repository run normally.** A "Deploy to Cloudflare Staging" run and two
probe workflows completed successfully at 2026-08-26T14:54:10Z, and other runs of this same
production workflow reached terminal states (`failure` at 15:25:40Z, `startup_failure` at
15:10:45Z). Actions is not broken for this repository generally — the problem is isolated to
this run record.

**Request**

Please clear run 32984581496 from the backend. We have deliberately not dispatched further runs
of this workflow to avoid adding to a queue we cannot drain.

**Impact**

This workflow is the only automated route to our production environment. A verified fix for a
live customer-facing defect is blocked behind it.
