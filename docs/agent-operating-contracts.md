# FlashTap — Agent Operating Contracts

Four artifacts, plus the roles and deployment rules they depend on. Paste sections 1–3 into
agent briefs; section 4 and below are for whoever is coordinating.

**Status: provisional.** This was written on 2026-08-10 from one long session and it will be
wrong within a week. It is version-controlled so the edits have history — when a rule here
misfires, change it here rather than working around it in a brief. Test manually on 5–10 real
issues before automating orchestration.

Every rule below is here because something went wrong, not because it sounded prudent. Where a
rule cites an incident, the citation is the justification — delete the rule when the incident
stops being possible.

---

## 1. Implementer Contract

Give this to every implementer agent, verbatim.

```
You own one issue, in one worktree. Confirm both before acting:
pwd, git rev-parse --abbrev-ref HEAD, git worktree list.

VERIFY BEFORE TRUSTING
The brief may describe a state that does not exist. Check the repo
before acting on any description, including mine. If reality differs,
report the mismatch and stop.

NEVER
- push to origin, touch main, or dispatch any workflow
- run any Supabase command, including reads
- WRITE outside your worktree (reading from the main checkout to
  provision your own worktree is expected — see TOOLCHAIN)
- file issues yourself (see OWNERSHIP)
- run the bare full test suite (see TEST ISOLATION)
- choose a policy answer yourself (see POLICY BOUNDARY)

TOOLCHAIN — PROVISION FIRST
A fresh worktree from `git worktree add` contains NO node_modules and
NO .env files. Both are gitignored, so neither arrives with the
checkout. Until you provision, the prescribed typecheck command below
does not exist on disk and jest has no environment. Do this first,
before any check whose result you intend to report.

1. node_modules. Preferred: a junction to the main checkout.

   cmd //c mklink /J "<your worktree>\node_modules" ^
     "C:\Users\223125318\Desktop\mvp\restaurant-menu-screen\node_modules"

   Preferred because it is instantaneous and costs no disk, and because
   a worktree cut from the same commit has a byte-identical
   package-lock.json — so there is nothing that can diverge. VERIFY that
   before junctioning: md5sum package-lock.json against the main
   checkout's. If they differ, your worktree is on a different base and
   you must `npm ci` instead.

   The junction shares one mutable directory across every worktree. So:
   never run npm ci / npm install in a junctioned worktree, and never in
   two worktrees at once. If you need to install anything, use npm ci in
   an unjunctioned worktree instead.

   `npm ci` is the fallback: slower and costs disk, but fully isolated.

2. .env. Copy .env.test and .env.local in from the main checkout.
   jest.setup-env.ts resolves .env.test relative to the WORKTREE root,
   so without it every live suite fails spuriously and you will report
   those failures as your own regressions.

Both ft-172 and ft-186 hit this independently on 2026-08-10 and solved
it two different ways — junction and npm ci respectively — and neither
solution was written down, so the third agent had to rediscover it.
That is why this section exists.

TOOLCHAIN — THE COMPILER
A worktree without node_modules resolves `npx tsc` to a squatter
package that prints "This is not the tsc command you are looking for"
and EXITS 0. Any exit-code check sails straight past it, and every
"typecheck green" claim you make afterwards is worthless.

Always invoke node node_modules/typescript/bin/tsc, which cannot
resolve to anything but the local compiler. Verify --version reads
5.9.3 before trusting any result.

WORKTREES SHARE ONE .git — REFS MOVE UNDER YOU
Worktrees isolate FILES. They do not isolate rows (see TEST ISOLATION)
and they do not isolate REFS. Another agent's fetch updates
origin/<branch> for every worktree at once. Observed 2026-08-10: an
auditor's origin/cloudflare-staging moved from 4fa1d01 to 5f19e69
mid-task, and it was caught only because the tip happened to be
re-printed.

So: re-read any SHA at the moment you use it. Never trust a SHA quoted
in a brief, including your base — `git rev-parse` it when it matters,
not once at the start.

TEST ISOLATION
Never run the bare full suite (`npx jest` with no path filter). The
live-data suites all write to ONE shared staging Supabase project, so
separate worktrees — and even separate clones — isolate FILES, not
ROWS. Two concurrent full runs fight over the same rows and invent
failures in suites unrelated to either change.

Run hermetic suites only: ones that mock @/lib/supabase/* or never
import __tests__/helpers. Pick the ones covering what you touched.
The integrator runs the full suite once, serially, at the end.

BASELINE
You will be given the known-failing suites by NAME and by SHA. Compare
by suite NAME, never by count — counts coincide often enough to
mislead. Any NEW failure by name is yours and you stop.

If the baseline SHA no longer exists (a rebase can remove it from every
branch), say so, re-measure, and state which SHA your new baseline came
from. Do not silently compare against a number.

`main` AND `cloudflare-staging` HAVE DIFFERENT BASELINES. Measured 2026-08-11:

    staging  6 suites / 13 tests
    main     7 suites / 17 tests

The delta is `guest-orders-validation` — 4 tests, repaired by wave-2's #122,
which is on staging and not on `main`. So a branch cut from `main` legitimately
fails 17, and comparing it against staging's 13 reads as four regressions that
do not exist.

Take the baseline from the ref you actually branched from. This rule already
said a baseline is pinned to a commit; that alone did not stop the mistake being
made on a batch branch cut from `main`. The numbers might stop the next one.

THE BASELINE IS FOR RECOGNITION, NOT REPRODUCTION. It exists so you can
identify a failure as pre-existing if you happen to hit one. You are NOT
expected to run the named suites — they are the live ones, and the
integrator measures them once, serially.

An EMPTY baseline is a legitimate, complete answer. If no hermetic suite
covers what you touched, write exactly that, with the grep that shows no
suite imports your changed modules. "No baseline suite covers this, here
is the check" is a STRONGER report than a green run of unrelated tests.
Never run live suites for ceremony.

PROOF
Classify your proof and produce the right kind:
- Regression — failing test, fix, passing test. Default for behaviour.
- Static — compiler/lint failure, fix, clean. For pure type work,
  tsc exit 0 is the proof; strengthen it with a negative probe you
  confirm fails, then revert.
- Invariant — query shows bad state, fix, invariant restored.
- Integration — real request, device, or provider interaction.
- Observational — logs, version endpoint, runtime artifact.
- Reachability — for deletions and dead-code removal. tsc exit 0 is
  NECESSARY BUT NOT SUFFICIENT: a deleted file always typechecks. The
  proof is the enumeration — the exact grep and its FULL output, plus
  explicit disposal of every non-literal path: barrel / `export *`
  re-export, dynamic import() or require() with a computed specifier,
  framework route convention, and build-time aliases or rewrites.
  State each one checked, with the command. A Next build is NOT a
  substitute where next.config sets typescript.ignoreBuildErrors.
- Archaeological — for audits. The claim is "the code at this ref does
  or does not contain this fix". Read the file at `<ref>:<path>`; label
  every finding CODE, commit-message, or inference.

Do not invent an artificial test to satisfy procedure. Say which kind
you used and why.

A negative probe must be TWO-SIDED. A probe that fails after your change
proves nothing on its own — it might have failed before. Confirm the bad
input was ACCEPTED before and is REJECTED after. The one-sided reading is
the natural one and is nearly worthless.

A SUITE THAT FAILS TO LOAD IS NOT A FAILING-FIRST PROOF. `Tests: 0 total`
means the harness could not run, not that the old behaviour was wrong. Same
family as the one-sided negative probe: a result that looks like evidence and
is not. Live example: proving #123's test red, deleting
`lib/tabs/settle-tab-state.ts` alongside the two routes made the suite fail to
import and report `Tests: 0 total` — which proves only that the test needs the
new module. Keeping the module and reverting ONLY the two routes produced six
real assertion failures naming the defect. Revert what carries the BEHAVIOUR,
never the modules the test depends on.

A PASSING TEST IS NOT EVIDENCE THE CODE IS CORRECT. It is evidence the
code matches the test. Both can be wrong together, and then the test
pins the defect in place. Live example: #131 — a ready order is labelled
PREPARING on production, and main's own
__tests__/receipt-status-badge.test.ts:25 ASSERTS that it reads
PREPARING. The suite is green and the bug is load-bearing. When a test
encodes the behaviour you are about to change, read it as a claim to be
checked, not as a constraint to satisfy.

SUPPRESSIONS
Every !, as, any, or ts-nocheck you introduce is disclosed and graded:
did you ESTABLISH the fact, or ASSERT it to quiet the checker? Say
which, per site. Suppression is not a fix, and converting one blanket
suppression into eleven narrow ones is an improvement in blast radius
and auditability — not "types fixed". Do not let it be recorded as one.

POLICY BOUNDARY
Choosing the ruling is the human's. An implementation choice INSIDE a
ruling already made is yours — make it, and disclose your reasoning.

Escalate: anything changing what a customer is told about money, what
is charged, or what a payment means. Do not escalate: which of several
correct implementations satisfies a ruling you already have.

OWNERSHIP
You do not file issues. Creating a GitHub issue is an outward-facing
action in the same family as pushing and dispatching, and it is the
orchestrator's. Propose them in NEW ISSUES TO FILE — one title and a
few lines of body each, written well enough to file verbatim — and the
orchestrator files them and reports the numbers back.

A RECORDED DECISION IS A RULING THAT HAS ALREADY BEEN MADE.
If you find a comment or a test recording a DELIBERATE decision
against the change you are about to make, do NOT implement it. Write
the counter-argument as a question in your ruling packet and carry on
with the rest of the task. The person who made that decision is not
here to defend it, which is a reason to escalate, not a licence to
overrule.

Observed 2026-08-11: an agent found #118's author had explicitly
rejected widening parseTableLandingPath — the reason was written into a
test comment on the QR entry path — implemented the widening anyway,
and flagged it honestly. The flag worked and the human reverted it. The
implementation was wasted; the counter-argument was the deliverable.

SEPARATE PROBLEMS
Write them up and continue. Switch only if blocking,
security-critical, or likely to invalidate your current fix.

COMPLETION
The structured handoff is the only completion signal, and it must be
SENT AS A MESSAGE. Your turn text does not reach the integrator — a
handoff written as prose in your own transcript is invisible and reads
as silence.

Going idle is not finishing. If you stop early, send the handoff anyway
saying how far you got and what blocked you. A partial report with the
gaps named is far more useful than silence.
```

---

## 2. Structured Handoff

Every implementer ends with exactly this, **sent as a message**. No prose around it.

```
ISSUE: #___
CLASS: E0 | P1 | D1 | H1
BRANCH:
COMMITS:

STATE CHECKED
- base SHA:
- what I verified vs. what the brief claimed:

IS THE DEFECT REAL?
live runtime defect | latent (real and verified, not yet triggered —
state the trigger) | type-only, no current runtime consequence |
not a defect | unreachable code
- evidence:
- if the brief asserted otherwise, say so here

PROOF TYPE: regression | static | invariant | integration | observational

PROOF BEFORE
- command:
- failure output:

CHANGE
- three lines, no more

PROOF AFTER
- command:
- result:

FILES CHANGED

BLAST RADIUS
What calls the changed code. NOT the file list.
Name every route, job, or surface whose behaviour changes,
including through shared libraries.

SUPPRESSIONS: none | listed and graded

BASELINE
- suites/SHA I was given:
- what I measured:

COULD NOT DETERMINE
What is inference rather than verified, and what would settle it.

NEW ISSUES TO FILE (proposed — the orchestrator files them)
- title / few-line body, one per problem, written to file verbatim

POLICY BLOCKERS: none | ruling packet attached

READY_FOR_INTEGRATION: yes | no
```

**Why BLAST RADIUS is separate from FILES CHANGED.** #180 changed two library files and three
test files. Zero `app/api/**` paths. The behaviour landed on three payment routes — the
single-order terminal callback, tab settle, and Finatic verification — through untouched call
sites of a shared function. Anything grading risk by file list would have called it low-risk.

For a change routed through a shared library, the honest blast radius is the set of **call
sites**. `grep -rn "<changed symbol>" app/` is what tells the truth; the diff does not.

---

## 3. Ruling Packet

One packet per issue, not one per question. Batch every open decision, numbered.

```
RULING — #___

FINDING
What the investigation established that you did not know before.

REFRAMED DECISION
The question as it stands AFTER the finding.
If the finding invalidated the original question, do not ask the
original question.

Q1. <question>
  A.
  B.
  C.
  RECOMMENDATION: _ — one line why

Q2. <question>
  A.
  B.
  RECOMMENDATION: _ — one line why

Q3. ...

CUSTOMER IMPACT
What changes for someone paying, ordering, or being told about money.
"None" is a valid answer and should be stated.

BLOCKS
What cannot proceed until this is answered.

CONFIDENCE: high | medium | low
COULD NOT DETERMINE:
```

Reply format: `#180: Q1:A Q2:B Q3:B Q4:B`

**The rule that makes this safe:** if investigation invalidates the original question, reframe
before asking.

- "What tolerance should we use?" stops being the question once you find the tolerance is a
  float artefact — `Math.abs(a-b) <= 0.01` is a one-cent tolerance for some amounts and a *zero*
  tolerance for others, rejecting 28.5% of exact one-cent differences by binary representation
  alone.
- "How do we tighten 85 sites?" stops being the question once you find `orders.status` and
  `orders.payment_status` have no `CHECK` constraint and are free text — a closed union would
  assert a guarantee the database does not make.

Without a FINDING field the option list quietly makes the decision and the human rubber-stamps
a menu.

---

## 4. Team Activation

Two separate questions. Answer both; do not let the first decide the second.

**How big is the work?**

| Size | Meaning |
|---|---|
| **S** | Typo, isolated UI, obvious null check. |
| **M** | One subsystem, some investigation needed before the fix is knowable. |
| **L / H1** | Multiple surfaces, or the blast radius is not yet known. |

**How many agents does it need?**

| Shape | When |
|---|---|
| One implementer | S. Also M or L **when the investigation is already complete** — see below. |
| Investigator + implementer | M where the fix is not yet knowable. |
| Full issue team | L / H1 where blast radius, reproduction and domain rules all need establishing. |

**The collapse exit.** If the investigation has already been done and is being handed over —
authoritative compiler output, a reproduction, an established blast radius — collapse to a
single implementer regardless of size, and **say so in the brief with the reason**. Sizing a
task M and then spawning an investigator to rediscover what you already have in hand wastes a
context and invites a second, differing account of the same facts.

**Auto-qualifies as H1 regardless of apparent size:** payments, auth, migrations, stock,
destructive data operations, anything touching a shared library with payment callers. Note this
raises the *class*, which drives deployment and confirmation — it does not by itself mandate a
full team if the investigation is already done.

### L/H1 team shape

```
T+0  (parallel)
  blast-radius investigator
  reproduction / proof investigator
  domain / invariant investigator
  writer — worktree, baseline tests, test scaffolding ONLY

T+N  findings converge
  ruling needed?
    no  -> writer implements
    yes -> ONE ruling packet -> human answers

  writer finishes
  structured handoff (sent, not written)
  integrator
  independent verifier
```

The writer prepares scaffolding during investigation but does not commit to a fix direction
until findings converge.

Only one agent writes per worktree. Parallel reasoning is cheap; parallel writing is where the
fourteen-unpushed-commits problem comes from.

Note this is a *files* rule. It does not make parallel test runs safe — see TEST ISOLATION.
Isolating an agent into its own worktree or its own clone does nothing about the shared staging
database.

---

## Roles

**Human** — policy rulings, customer-facing copy, anything changing what a customer is told
about money, deploy go/no-go.

**Orchestrator** — coordinates. Its claims are disposable, not authoritative.

**Integrator** — sole owner of origin pushes, `main`, and workflow dispatch. Outside every issue
team. Also the only one who runs the full test suite, once, serially.

**Who files issues** — the orchestrator, not the implementer. Implementers propose in
`NEW ISSUES TO FILE`; the orchestrator files and reports the numbers back. Issue creation is
outward-facing and belongs with pushing and dispatching, not with writing code.

**Independent verifier** — distrusts everyone. Reads artifacts, not reports: `git rev-parse`,
`git cherry`, `git patch-id --stable`, actual test output, `/api/version` **cache-busted**.

The misses that produced this document were state claims, not bad code — a SHA that no longer
existed on any branch, a branch believed pushed that was not, a baseline pinned to a commit that
had been rebased away, two issue counts that did not reproduce. The verifier's job is mechanical
and catches exactly that class.

### `git checkout <sha> -- file` stages. A gate cannot catch what this hides.

To prove a test fails without its fix, the obvious move is to revert the source and keep the test:

```
git checkout <base-sha> -- src/thing.ts     # revert source, keep tests
npx jest path/to/test                        # confirm red
git checkout -- src/thing.ts                 # "restore"
```

**The last line does not restore.** `git checkout <sha> -- file` writes the old content to the
worktree AND STAGES IT. `git checkout -- file` then restores from the *index*, which now holds the
reverted version. The fix is silently gone, and `git status --porcelain -uno` reads **clean**,
because index and worktree agree.

**Prefer `git revert <sha>` when undoing a WHOLE commit** — it produces an ordinary commit and
never desynchronises index from worktree, so the trap cannot arise. The `git checkout` form is for
PARTIAL reverts, and only there does the dance below apply.

Correct restore for a partial revert:

```
git checkout HEAD -- src/thing.ts && git reset
```

**Verify by BLOB IDENTITY, not by `git status`.** A clean `git status` is the exact false signal
this trap produces — index and worktree agreeing is the condition that hides it. What settles it:

```
git diff <base> HEAD                 # empty, for a full revert
git rev-parse <base>:<path>          # these three must agree
git rev-parse HEAD:<path>
git hash-object <path>
```

Then verify with `git diff --cached --stat` (must be empty) and grep for a marker from the fix.

Observed 2026-08-10 while proving #125's four tests failed without their fix. Caught on the
`--cached` diff; one step later the branch would have been pushed with the fix removed.

**Why no gate catches this.** The tests were never reverted — only the source. So the pushed branch
would have carried passing tests and no fix, `tsc` would exit 0, lint would pass, and Build
Verification would go green. Every mechanical check in the pipeline reports success on a change
that does nothing. It is caught by looking at the index, or not at all.

Applies to the orchestrator/integrator, not only implementers: the failing-first check is normally
run by whoever is about to push.

### The verifier's limit — state it, do not paper over it

**Mechanical gates verify that a commit APPLIES. They cannot verify that it is still TRUE on the
target branch.**

Worked example. `dd3d9eb` was a comment-only commit explaining why two test suites need no mock
of `@/lib/tabs/settle-tab-state`. Cherry-picked toward `main` it passed every mechanical check:
clean forbidden-path scan, clean patch-id, applied without conflict. It would still have planted
a false statement, because its text asserts *"#123 adds `lib/tabs/settle-tab-state.ts`, and the
payment route does import from it"* — true on `cloudflare-staging`, false on `main`, which has
neither.

Nothing in `rev-parse`, `cherry`, or `patch-id` can detect that. Someone has to read the content
against the destination.

Anything **base-conditional** must be read against the branch it is landing on:

- comments asserting what exists
- tests mocking a module that may or may not be present
- migration guards
- anything whose correctness depends on a sibling change being present

---

## Deployment classes

| Class | Examples | Rule |
|---|---|---|
| D0 | copy, styles, isolated UI | may batch |
| D1 | normal application logic | small compatible batch |
| D2 | stock, order state, business rules | alone |
| D3 | payments, auth, migrations, destructive data | alone + enhanced confirmation |

**Class is assigned by BLAST RADIUS, not changed files.**

Unchanged and non-negotiable:

- nothing reaches production that is not on origin first
- `production-worker.yml` is the only production path, manual dispatch only
- migrations never ride a deploy — apply via `scripts/safe-supabase-linked.ts` first. `db query`
  does not record the ledger row, so the drift guard still fails afterwards, and the fix is
  `migration repair`, never a re-run
- verify `/api/version` with a cache-buster until #192 lands. Note both failure modes exist and
  look identical on a bare probe: a stale edge cache (cache-buster returns the new SHA
  immediately) and genuine Worker propagation (cache-buster still returns the old SHA, and
  converges within minutes). The cache-buster is what tells them apart

---

## `main` is built by cherry-pick, so "fixed" drifts — measure the gap

**"Fixed on staging" and "fixed in production" are different facts here, and nothing measures the
distance between them unless someone chooses to.**

`main` is not staging plus pending work. It is built by cherry-pick, so the two diverge in BOTH
directions and stay diverged. Measured 2026-08-10: 34 commits on `cloudflare-staging` not on
`main`, 19 on `main` not on `cloudflare-staging`. Any reasoning that treats staging as "main plus
what is queued" is wrong, and every audit that assumes it produces a confident wrong answer.

Three consequences that have each already happened:

- **A fix can sit one cherry-pick from production for days while others go past it.** #124 was a
  live payment-method allowlist bypass — `if (paymentMethod && !allowed.includes(paymentMethod))`,
  so omitting the field skipped the check entirely. The fix was on staging. Three other fixes
  (#126, #180, #125) were promoted over it before anyone looked.
- **Branch-merged and issue-fixed are different questions.** #180's branch was never merged, yet
  the issue is live, because its commits were cherry-picked. #174's DB index shipped to `main`
  while its sibling UI fix #175 did not — and #174 being closed makes #175 look done.
- **A close-audit found 31 issues fixed on a branch and not live.** That list is the most valuable
  output of the exercise precisely because those are the ones everyone assumes are done.

**So the close-audit is a standing step, not a one-off.** Run it on a schedule and before any
release decision, not when someone happens to ask at 1am. It answers one question — *for each open
issue, is the fix reachable from `origin/main`?* — and it produces three lists: shipped and live,
fixed on a branch and not live, genuinely open. The middle list is the deliverable.

Its method matters, because commit messages lie in both directions — a message can cite an issue
it did not fix, and a fix can land citing nothing. Use `Archaeological` proof: read the file at
`origin/main:<path>` and label every finding CODE, commit-message, or inference. `git log --grep`
is where the audit starts, never where it ends.

Two traps found running it:

- There is a **second production line**. `origin/feat/terminal-reconciled` ships to devices by APK;
  `main` contains no terminal app at all. "Reachable from `origin/main`" is meaningless for those
  issues, and the three-list model has no slot for "live on devices, not on `main`". Do not assert
  liveness for a terminal issue without a device version check.
- **Work can exist on no remote at all.** `feat/156-settle-writes-sale-ledger` carried two answered
  rulings and existed on one hard drive. An audit that only reads `origin` will not see it.

## Operating rule

Discover in parallel. Reframe before deciding. Write in isolation. Report structurally.
Integrate serially. Verify independently. Deploy by blast radius.

**Agents may summarize reality. Gates must inspect it.**
