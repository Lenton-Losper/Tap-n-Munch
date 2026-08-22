# Promotion runbook — staging → main

How to move a wave of `cloudflare-staging` commits onto `main` without resurrecting work that is
already there, without shipping a runtime change you did not intend, and with a verification that
can actually fail.

Written from wave 1 on 2026-08-21. It stopped at step 6 for a ruling, the ruling went against the
check rather than the wave, and **wave 1 then promoted: 76 commits, `f04c01b` → `1811b0e`.** Step 6
below is the corrected check, not the one that stopped it. See
[wave-1-stop-2026-08-21.md](wave-1-stop-2026-08-21.md) for the three rulings and their answers.

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
3. **The verification measures the wrong thing.** "The backlog count dropped by N" is not a sound
   check — it fails on a correct promotion and it cannot fail on a wrong one. Wave 1 stopped on it
   for nothing. **Verify by content: the file gap.** See step 6.

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
why step 6 counts **files**, not commits. `scripts/check-branch-drift.mjs` exists precisely for this
— it measures twice, patch-id then reverse-apply — and step 6 uses it.

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
than override. Wave 1 stopped here and the ruling upheld the header: the file was removed in a final
commit and `main` took the wave with **no `.github/` change at all**.

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

### A clean cherry-pick is not a correct one

**Zero conflicts does not mean the right content landed.** Measured 2026-08-22 on `e304ddc` (the
E04111 payments wave) against `origin/main` at `bbce8cb`:

    cherry-pick e304ddc onto bare main   -> CLEAN, zero conflicts
    lib/orders/auto-cancel-stale-pos-orders.ts
      after the pick : 3d3f3fee
      on staging     : 225d4529     *** 113 insertions missing ***

The pick was clean **because** its hunks did not overlap the earlier wave's. The earlier wave's
skip-audit and rest-interval work simply was not underneath, and nothing at apply time said so.
Applied in order after that wave, the same commit produces a file byte-identical to staging.

So git's silence is evidence about *textual overlap*, not about *dependency*. Step 4's virtual-tree
walk catches a commit that modifies a file **absent** from `main`; it cannot catch one that modifies
a file **present but older**. That is the gap this note closes.

**What actually caught it, in this instance:** the deployed file used `VERIFICATION_SKIPPED_ACTION`
at line 346 while its declaration stayed behind in the earlier wave, so `tsc --noEmit`
(`production-worker.yml:59`) fails. Neither wave-6 test exists on `main`, so the jest step could not
have caught it — `tsc` was the only backstop, and it was luck rather than design.

**Do not rely on that.** A wave whose missing lines are pure logic rather than a new export
typechecks perfectly and ships wrong behaviour silently. The check that does not depend on luck:

    # for every runtime file the wave touches, after assembling the wave and before pushing
    git rev-parse HEAD:<path>
    git rev-parse origin/cloudflare-staging:<path>
    # equal, or the wave is incomplete — regardless of what the cherry-pick reported

Blob equality per touched file is cheap, total, and independent of conflict reporting. Run it at
**assembly** time, not only at Step 6 — Step 6's end-state gap check does catch this, but only after
the push, which is the expensive place to find out.

## Step 5 — Verify BEFORE pushing, not after

Everything in step 6 can be measured against the local branch. Do it there. A promotion that fails
its own verification should never have reached `origin/main`, and on this repo nothing forces you
to push first — `main` has no push-triggered workflow (step 3b).

Wave 1 stopped here with `main` untouched while three rulings were answered — which is the outcome
the ordering is for. Had step 6 run after the push, a promotion would have been reversed for a
residual that turned out to be benign.

## Step 6 — Verify by CONTENT. Do not verify by commit count.

**Ruled 2026-08-21, after wave 1: the count check is wrong and a later wave must not stop on it.**

The intuitive check is *"the backlog dropped by exactly the number promoted"*. It does not, a sound
wave fails it, and wave 1 stopped on it for nothing. Wave 1 promoted 76 and the commit backlog fell
by 74 — **both residuals were benign and neither was a selection error**:

| commit | why it still read `+` after a correct promotion |
|---|---|
| `b915483b` | Applied **partially**. One of its three files (`.github/workflows/staging.yml`) was already on `main`, so the cherry-pick's diff — and therefore its patch-id — differs from the original. The content promoted; the patch-id did not match. |
| `74b0529e` | Applied **empty**. Its only file was already on `main` byte-identical, having arrived inside the squashed promotion `5c9d31d`. There was never anything to promote. |

Both shapes recur in every wave, because `main` is built by cherry-pick and by squash. **A commit
count cannot distinguish "did not promote" from "was already there under a different patch-id."**
Content can.

### The measure: the file gap, before and after

```bash
git diff --name-status origin/main origin/cloudflare-staging > gap_before.txt      # before the push
# ... promote ...
git diff --name-status origin/main origin/cloudflare-staging > gap_after.txt       # after
diff <(awk '{print $2}' gap_before.txt | sort) <(awk '{print $2}' gap_after.txt | sort)
```

**Pass condition: the files that leave the gap are exactly the files the wave's end-state diff
carries, and no others.**

```bash
git diff --name-only origin/main..promote/waveN | sort > wave_files.txt
comm -23 <(awk '{print $2}' gap_before.txt | sort) <(awk '{print $2}' gap_after.txt | sort) > left_the_gap.txt
comm -23 left_the_gap.txt wave_files.txt     # must be EMPTY — files left the gap that the wave did not carry
comm -13 left_the_gap.txt wave_files.txt     # wave files still differing — see below
```

The second list is not automatically a failure. A file the wave carried can still differ afterwards
when `main` and staging both changed it — that is genuine two-sided divergence, and it must be named
and explained, not waived.

### Three further checks, in order of what they catch

1. **Nothing left that was not in the wave** — the `comm -23` above, empty. This is what catches an
   accidental merge dragging unrelated work along, and it is the one that must never be waived.
2. **`scripts/check-branch-drift.mjs origin/main origin/cloudflare-staging` agrees.** It measures
   twice — patch-id, then reverse-apply against the tree — so content ported under a different
   patch-id reads PRESENT rather than missing. That is exactly the `74b0529e` case, and it is why
   this script is the authority and raw `git cherry` is not.
3. **The commit count, recorded but never gating.** Print it, note any residual, and move on. If a
   promoted commit still reads `+`, explain it with `git show --stat` on the original versus the
   applied commit and a blob comparison on the file — then carry on. **An unexplained residual is
   worth investigating; a mismatched count is not worth stopping for.**

### Why the commit backlog will read high forever

`git cherry` compares patch-ids of *commits*. A squashed promotion has **one** patch-id for what
staging holds as twenty commits, so all twenty keep reading `+` after their content has landed.
Wave 1's re-measurement found `main` holding 43 such squashes — `b30b7e5` "the customer redesign",
`1591d12` and `cd5e01a` for order-editing, `e703eb5` for the staff side — which is why a 199-commit
"backlog" corresponded to a 115-file, 4-runtime-file real gap. **The commit number is not a
quantity of work. The file gap is.**

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

---

# Pre-launch: a venue's first card

Not a promotion step — a separate gate, kept here because this is the file that gets read before
something ships to a live venue.

**No venue takes its first card until `finatic_merchant_no` and `finatic_store_no` are non-null.**

```bash
node scripts/check-venue-payment-readiness.mjs          # every venue with a registered terminal
node scripts/check-venue-payment-readiness.mjs --all    # every venue, test rows included
node scripts/check-venue-payment-readiness.mjs <id>     # one venue
```

Exit 0 = ready. Exit 1 = at least one venue with a terminal cannot settle a card.

## Why this is a gate and not a nice-to-have

On 2026-08-21, **every** card taken at FNB ChowNow settled through `path: fallback_verified_paid` —
not one went through the signed webhook. The PayCloud signature fails on ~100% of live traffic
(#107, `Encryption block is invalid.`), so the recovery path is the **primary** settlement path.

And that path opens with:

```ts
const creds = await getRestaurantFinaticCredentials(restaurantId)   // throws if unconfigured
```

The signed webhook does not need per-restaurant credentials. The fallback does. So a venue with
NULL credentials has **no settlement path at all**: the card clears at the gateway, the signature
check fails, the fallback throws, and the order is never marked paid. **The money is taken and the
order shows unpaid, with nothing behind it.**

Chownow Nedbank was in exactly that state when its devices were handed over on 2026-08-20. It had
not traded yet, so nothing was lost. This gate is what turns that from luck into a check.

## What to obtain, per venue

| field | required | notes |
|---|---|---|
| `finatic_merchant_no` | **yes** | 12 digits; the three live venues all begin `3426` |
| `finatic_store_no` | **yes** | 10 digits; all begin `4426` |
| `checkout_merchant_no` | only for QR / hosted checkout | **ask, do not assume** — Riviera's is `342600032359`, different from its card `342600171063` |
| `checkout_store_no` | only for QR / hosted checkout | `app/api/orders/route.ts:519` reads this pair with **no fallback**, so an empty value sends Finatic a blank merchant number rather than failing cleanly |
| `finatic_terminal_sn` | no | stamped into payment-attempt audit metadata only |

App-level `app_id` and keys are environment-wide, **not** per venue — unless the venue is onboarded
under a different Finatic account, which is worth asking explicitly, because then the app-level keys
change too and it stops being a four-column job.

## What this gate does not check

It reads columns; it does not call Finatic. **A merchant/store pair that is present but wrong passes
here and fails at the till.** Confirming the pair is live means running one real card at the venue
and watching the order settle. This gate protects that first-card test; it does not replace it.

## Standing state, 2026-08-21

| venue | terminal | card pair | |
|---|---|---|---|
| Riviera | registered | set | READY |
| FNB ChowNow | registered | set | READY |
| Mingle Brew & Pour | registered | set | READY |
| **Digi Cofee** | **registered, active** | **NULL** | **BLOCKED** — dormant since 2026-07-29, 15 card orders historically and 2 settled (N$3 each, 20–22 July, while the signed webhook still worked). Either give it credentials or deactivate its terminal. |
| **Chownow Nedbank** | none yet | **NULL** | **BLOCKED** — devices handed over 2026-08-20, not yet opened |
