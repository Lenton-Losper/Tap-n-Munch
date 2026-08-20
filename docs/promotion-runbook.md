# Promotion runbook — staging → main

How to move a wave of `cloudflare-staging` commits onto `main` without resurrecting work that is
already there, without shipping a runtime change you did not intend, and with a verification that
can actually fail.

Written from the wave 1 attempt of 2026-08-21, which **stopped at step 6** — see
[wave-1-stop-2026-08-21.md](wave-1-stop-2026-08-21.md). Every step below was executed; the
procedure is proven, the wave is not promoted.

Companion documents: [staging-backlog-inventory.md](staging-backlog-inventory.md) is what to
promote and in what order. [promotion-constraints.md](promotion-constraints.md) is the list of
orderings that must not be violated. This file is *how*.

---

## The three things that go wrong

1. **A merge resurrects reverted work.** 132 of the 331 commits examined between `main` and
   `cloudflare-staging` are already on `main` as cherry-picks with different SHAs. `git merge`
   and `git rev-list` both count them as absent. Only patch-id comparison does not.
2. **A commit classified as inert is not.** The inventory groups commits by *subject*, and says so.
   Subject is not diff. A wave selected by subject will contain runtime changes and will miss
   inert commits that belong with it.
3. **The verification passes without proving anything.** "The backlog count dropped" is not a
   sound check — see step 6, which is where wave 1 stopped.

---

## Step 0 — Fix the baselines, in writing

```bash
cd restaurant-menu-screen
git fetch origin --prune
git rev-parse origin/main origin/cloudflare-staging
```

Record both SHAs at the top of the wave's write-up. Every count below is meaningless without them,
and both branches move during a long session. The inventory's baselines
(`main`=`13ca90d`, `staging`=`0e7800a`) had already moved by three commits each when wave 1 was
selected — the backlog happened to still be 199, but that was luck, not stability.

Windows note: Git Bash mangles `rev:path` arguments (`origin/main:.github/x.yml` becomes
`origin/main;.github\x.yml`). Set `MSYS2_ARG_CONV_EXCL='*'` for those calls — but then POSIX paths
like `/c/Users/...` stop converting too, and `git worktree add /c/...` silently creates
`C:\c\Users\...`. **Use Windows-style `C:/Users/...` paths throughout** and the two rules stop
fighting.

## Step 1 — Select by patch-id

```bash
git cherry origin/main origin/cloudflare-staging > cherry.txt
grep -c '^+' cherry.txt      # genuine backlog
grep -c '^-' cherry.txt      # already on main under a different SHA
grep '^+' cherry.txt | awk '{print $2}' > backlog.txt
```

`git cherry` reports `-` for a commit whose patch-id is already on `main`. At the wave 1 baseline:
386 by `rev-list`, 331 examined, 132 already present, **199 genuine**. Never use the `rev-list`
number for anything.

**`git cherry` is necessary but not sufficient.** It compares patch-ids of *commits*, not content
of *files*. A commit whose content reached `main` inside a larger squashed commit still reads `+`.
Wave 1 hit this exactly once (`74b0529e`, whose file arrived on `main` inside `5c9d31d`) and it is
what makes step 6 fail. `scripts/check-branch-drift.mjs` exists precisely for this — it measures
twice, patch-id then reverse-apply — and step 6 uses it.

## Step 2 — Classify by diff, never by subject

Collect every file every backlog commit touches, in one pass. Per-commit `git show` over 199
commits takes minutes on Windows and will time out:

```bash
git log --no-walk=unsorted --pretty=format:'@@@%H|%ad|%s' --date=short --name-only \
    $(tr '\n' ' ' < backlog.txt) > log_files.txt
```

A commit is **inert** only if *every* path it touches is outside the runtime set:

| runtime — disqualifies a commit | inert |
|---|---|
| `app/ lib/ components/ hooks/ contexts/ types/ workers/ payments/ public/` | `docs/` and root `*.md` |
| `supabase/` (any migration) | `.github/` — *conditionally, see step 3* |
| `middleware.ts` `next.config.mjs` `open-next.config.ts` | `scripts/` |
| `wrangler*.toml` `package.json` `package-lock.json` `tsconfig.json` `vercel.json` | `ops/` |
| `firestore.rules` `storage.rules` `firebase.json` `firestore.indexes.json` | `.gitignore` |

`__tests__/` and `tests/` are inert at runtime but are **not** wave 1 — the inventory assigns test
coverage to the wave whose code it covers. Keep them with their feature.

Expect the diff-based answer to disagree with the subject-based grouping, in both directions. For
wave 1 the inventory said 40; the diff said 77. The 37 extra were not hiding — the inventory's
first-match subject classifier had filed them under "security" (18 empty CI marker commits, whose
subjects say "redaction") and "other" (20). **That disagreement is the finding, not a nuisance.**

## Step 3 — The four checks that are not path matching

Path purity is necessary and not sufficient. Run all four.

**3a. Does any commit change a script the production deploy gate runs?**

```bash
git show "origin/main:.github/workflows/production-worker.yml" | grep -oE 'scripts/[A-Za-z0-9._-]+' | sort -u
```

At the wave 1 baseline that is six files (`check-migration-drift.mjs`,
`check-migration-inline-check.ts`, `check-order-number-guard.ts`, `check-orders-read-bounded.ts`,
`check-session-restaurant-resolver.ts`, `check-ts-nocheck-baseline.mjs`). A commit touching one of
them is a `scripts/` commit that **changes whether production can deploy**. It is not inert.
Wave 1 had zero.

**3b. What actually fires on a push to `main`?**

```bash
for w in $(git ls-tree --name-only origin/main .github/workflows/ | sed 's#.*/##'); do
  echo "=== $w ==="; git show "origin/main:.github/workflows/$w" | sed -n '1,20p' | grep -nE 'on:|push|branches|- main|workflow_dispatch'
done
```

On this repo, **nothing does**. Every production workflow is `workflow_dispatch` only; the rest
trigger on `cloudflare-staging`. So pushing to `main` is not a deploy, and step 5 is a separate,
deliberate act. Re-check this each wave — it is the assumption the whole runbook rests on.

**3c. Does a workflow arriving on `main` carry a ruling against it?**

A file can be inert by trigger and still be wrong to promote.
`.github/workflows/probe-302-305-production.yml` is `on: push: branches: [cloudflare-staging]`, so
on `main` it can never fire — and its own header says *"this instrument has no business on main --
it would be repo state that production carries for a check production never runs."* That is a
recorded decision. Read the header of every workflow the wave adds to `main`, and escalate rather
than override. Wave 1 stopped partly here.

Also check the wave's **end state**, not its commits: `apply-org-merge.yml` is added and removed
inside wave 1, so it never lands. `git diff --name-status origin/main..<branch>` is the only view
that shows this.

**3d. Does any runtime file import from an inert directory?**

```bash
git grep -nE "from ['\"].*scripts/|require\(['\"].*scripts/" origin/cloudflare-staging \
    -- app lib components hooks contexts types workers payments middleware.ts
```

Empty on this repo. If it is ever non-empty, `scripts/` stops being inert.

## Step 4 — Build the branch in a worktree, and let it find the dependencies

Before cherry-picking, check statically that every file the wave *modifies* (as opposed to adds)
exists on `main` or is added earlier in the wave. Walk the wave in order against a virtual tree
seeded from `git ls-tree -r --name-only origin/main`, using `--name-status`; a modify or delete of a
path not in that set means **the commit depends on a commit outside the wave**.

Wave 1 had exactly one: `d3eba569` modifies `scripts/probe-order-edit-lock-race-staging.ts`, which
is created by `ae9c65e9` — a wave 3 order-editing runtime commit. It is a wave 3 commit wearing a
`scripts/` diff. Dropped, and it belongs in wave 3.

This is the general rule the subject classifier cannot see: **a probe script promotes with the
feature it probes.**

Then apply, oldest first, in a fresh worktree off `origin/main`:

```bash
git worktree add -b promote/waveN "C:/Users/223125318/Desktop/mvp/wt-waveN" origin/main
while read sha; do
  git -C "C:/Users/223125318/Desktop/mvp/wt-waveN" cherry-pick --allow-empty --keep-redundant-commits -x "$sha" || break
done < wave.txt
```

`--allow-empty --keep-redundant-commits` matters: 18 of wave 1's commits are empty CI markers, and
without those flags the loop stops on each one. `-x` records the source SHA in the message, which
is the only durable link back to staging.

Strip CRLF from any SHA list a Windows tool wrote (`tr -d '\r'`) — `git` reports a trailing `\r` as
`fatal: bad revision '<sha>?'`, which reads like a corrupt SHA rather than a line ending.

Then prove the end state, which is the check that actually matters:

```bash
git -C "...wt-waveN" diff --name-only origin/main..HEAD | grep -E '^(app|lib|components|hooks|contexts|types|workers|payments|public|supabase|__tests__|tests)/|^(middleware\.ts|next\.config\.mjs|open-next\.config\.ts|wrangler.*\.toml|package(-lock)?\.json|tsconfig\.json|vercel\.json|firestore\.rules|storage\.rules|firebase\.json)$'
```

Empty output, or the wave does not ship. Wave 1: 45 files, all under
`scripts/ ops/ docs/ CONTRIBUTING.md .gitignore .github/`.

## Step 5 — Verify BEFORE pushing, not after

Everything in step 6 can be measured against the local branch. Do it there. A promotion that fails
its own verification should never have reached `origin/main`, and on this repo nothing forces you
to push first — `main` has no push-triggered workflow (step 3b).

Wave 1 stopped here with `main` untouched, which is the outcome the ordering is for.

## Step 6 — The verification, and why the obvious form of it is wrong

The intuitive check is *"the backlog dropped by exactly the number promoted"*. **It does not, and a
sound wave can fail it.** Wave 1 promoted 76 and the backlog fell by 74:

```bash
git cherry promote/waveN origin/cloudflare-staging > cherry_after.txt
grep -c '^+' cherry_after.txt
```

199 → 125. The two residuals are both benign, and both are shapes that will recur:

| commit | why it still reads `+` |
|---|---|
| `b915483b` | Applied **partially**. One of its three files (`.github/workflows/staging.yml`) was already on `main`, so the cherry-pick's diff — and therefore its patch-id — differs from the original. |
| `74b0529e` | Applied **empty**. Its only file was already on `main` byte-identical, having arrived inside the squashed promotion `5c9d31d`. There was never anything to promote. |

So use the **set** check, not the count check:

```bash
comm -23 before_plus.txt after_plus.txt   # what left the backlog
comm -12 after_plus.txt wave.txt          # promoted but still listed — must be explained
```

Pass conditions:

1. **Nothing left the backlog that was not in the wave.** `comm -23 before after` minus the wave
   must be empty. Wave 1: empty. This is the check that catches an accidental merge, and it is the
   one that must never be waived.
2. **Every promoted commit that still reads `+` is explained**, individually, by partial or empty
   application — confirmed with `git show --stat` on both the original and the applied commit, and
   by `git rev-parse` on the file blobs. An unexplained residual means the wave did not apply what
   you think it applied.
3. **`scripts/check-branch-drift.mjs origin/main origin/cloudflare-staging`** agrees. It
   reverse-applies each patch-id candidate against the tree, so content ported under a different
   patch-id reads PRESENT rather than missing — which is precisely the `74b0529e` case. Its
   `KNOWN_ABSENT` baseline must shrink by the wave, and stale entries are reported so the list
   cannot rot.

Record the residuals in the wave's write-up. They are permanent: the backlog will read two higher
than the truth until those two commits are baselined.

## Step 7 — Deploy, and verify all three hostnames

Only after step 6 passes, and only for a wave cleared to reach production.

`main` has no push trigger, so the deploy is a deliberate `workflow_dispatch` of
`production-worker.yml`. Then verify `/api/version` on **all three** hostnames — and sample, do not
spot-check: the worker rolls out gradually and a single cache-busted request can return either
version for roughly two minutes. Require 20/20 identical reads per hostname before calling it done.

For an inert wave this proves only that the deploy did not *break* anything — the version string
should be the only thing that moved. Say so in the write-up rather than implying the wave was
exercised.

## Step 8 — Write it down

Per wave, in `docs/`: the baselines, the selection command and its counts, the diff-based
classification with anything dropped and why, the four step-3 checks, the end-state diff, the step-6
set comparison including every explained residual, and the deploy evidence. The wave's own commit
list belongs in the file — SHAs on staging, and the `-x` trailer links each promoted commit back.

---

## What this runbook does not cover

- **Migrations.** No wave has carried one yet. The four in the schema gap are handled separately in
  the inventory, and `seed_whatsapp_account_staging` must never be promoted. Applying a migration is
  a different procedure with a different rollback, and it is not written yet.
- **Conflict resolution.** Wave 1 applied 76 commits with zero conflicts once the one out-of-wave
  dependency was dropped. Wave 5 (80 entangled commits over the same files) will not, and a
  conflicted cherry-pick is a judgement call that this document currently just hands back to you.
- **Whether the promoted content is correct.** Everything here proves the *transfer* was faithful.
  For a runtime wave that is the smaller half of the problem.
