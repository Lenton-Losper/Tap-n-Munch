# FlashTap — Agent Operating Contracts

Four artifacts, plus the roles and deployment rules they depend on. Paste sections 1–3 into
agent briefs; section 4 and below are for whoever is coordinating.

**Status: provisional. Revision 2, 2026-08-11** — see the revision at the end of this document
for the role model, the activation model, the PROOF CEILING handoff field and rules 7-9. Revision
1 below is unchanged; nothing in it has been retired.

This was written on 2026-08-10 from one long session and it will be wrong within a week. It is version-controlled so the edits have history — when a rule here
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

The delta is `guest-orders-validation` — 4 tests. **CORRECTED 2026-08-11 (rev 2): this is a
STALE TEST ON MAIN, not a missing code fix on staging.** The earlier wording here said staging
carried a #122 auth fix that `main` lacked. That inverts which branch is behind, on a
security-relevant file, and it was propagated into agent briefs before it was caught.

Verified: `guestCanAccessOrder` is **byte-identical at both refs** — same content hash
`18ce303910cccb41059c23a3570a135c6342f9dd`. The diff between the two `validation.ts` files begins
*after* that function.

  CODE  main is AHEAD  — `isWellFormedPaymentRef` + a fail-closed `paymentRefOrFilter`.
                         Staging returns bare `string` with no validation (#254).
  TEST  main is BEHIND — its four cases call `guestCanAccessOrder` with `{}`, no `restaurantId`,
                         asserting the contract that existed before `f4f9111` made restaurant
                         binding mandatory. They have failed ever since. Staging carries the
                         repaired test, plus two cases that were missing entirely.

So a branch cut from `main` legitimately fails 17, and comparing it against staging's 13 reads as
four regressions that do not exist — the practical rule is unchanged. But the four reds are on a
multi-tenant isolation function, they are noise a real regression would hide in, and every agent is
told to ignore them. Tracked as #257.

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
payment route does import from it"* — true on `cloudflare-staging`, false on `main`, which had
neither.

**THIS INCIDENT HAS EXPIRED, 2026-08-11.** `lib/tabs/settle-tab-state.ts` is now PRESENT at both
refs, so the statement `dd3d9eb` would plant is true on `main` and the commit is no longer an
example of anything. It is kept here as an ILLUSTRATION of the failure mode, explicitly labelled
as historical — the rule stands, its original instance does not. **A rule whose incident has
become impossible should be deleted, not inherited; this one survives only because the failure
mode is still reachable by other commits.** If no live instance can be cited the next time this is
reviewed, delete the rule.

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
  while its sibling UI fix #175 did not — and #174 being closed made #175 look done.
  **RESOLVED 2026-08-11: #174 and #175 are BOTH fully live on `main` and are off the
  do-not-promote list.** Measured, not inherited: `21d5133` is an ancestor of `origin/main`,
  `lib/tables/table-number-conflict.ts` is identical across refs and carries #175's rationale in
  its header, migration `20260806000000` is on main, `components/qr-code-management.tsx` is
  identical and renders the number at `:208-209`, and both #175 tests are present. The split was
  real once and has closed. The EXAMPLE stays because the shape recurs; the pair is no longer an
  instance of it.
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

---

# Revision 2 — 2026-08-11

Written after a second long session: nine production deploys, sixteen issues closed. Revision 1
above is unchanged and nothing in it was retired. This adds the role model, the activation model,
one handoff field, and three rules.

Same standard as revision 1: **every item cites the incident that produced it.** A role or rule
with no incident behind it is a guess, and should be deleted rather than kept for symmetry.

## Roles

Five agent roles plus the human. These are *functions*, not headcount — one instance may hold
several, with the single exception stated under Integration & State Auditor.

### Reality & Proof Engineer

Establishes what is actually true before anything is built, and what a proof is worth afterwards.
Owns the failing-first probe, the negative probe, and the sentence *"the issue's premise is false."*

Origin incidents:

- **#186** — described as a runtime defect; it was type-only, with no runtime consequence. Four
  issues that session turned out the same way.
- **#177** — argued from "nothing reads this column." `app/api/terminal/tables/route.ts:50` reads
  it as a hard gate on the payment terminal's entire table list, and the dangerous direction was
  the *opposite* of the one filed. Closed and refiled as #216 rather than reframed.
- **#200** — filed as a live revenue leak. Measured: zero of 2,604 orders affected.
- **#201** — filed as a customer being shown a false "Payment Confirmed". The button was
  **unsatisfiable**: it rendered only inside a branch its own condition excluded, so no customer
  ever clicked it and no write was ever attempted.
- **#180's blast radius**, inherited from what revision 1 called the Tracer. A change is scoped by
  *what calls it*, not by what it touches. The integer-cent comparator had callers on four payment
  legs — and a fifth gate (#197) never called it at all, which is exactly why a sweep defined by
  the helper missed it.

### Ledger

Owns *"where is this recorded, and who reads that record?"* Distinguishes a log line from a
durable, queryable fact. A `console.error` in a Worker is not a record.

Origin incidents:

- **#195** — the settle route discarded the result of three writes that ran *after* the orders were
  claimed paid, including the `payments` INSERT. The money record itself could fail while the route
  answered `success: true`.
- **#127** — 282 duplicate `(restaurant, order_number)` pairs on production, which is what blocks
  the unique index. A ledger question, not a code question.
- **#187** — a charged-but-refused payment left no record at one call site and a console line at
  another. Closed with one audit row carrying both figures; the *prevention* half stayed open,
  because the fix the issue proposed had already been rejected one file over.
- **`orders.payment_trans_no`** — selected by the ops console, written by a module with **no caller
  since 2026-06-02**. The field had been blank for ten weeks. Deleting the module did not create
  the blank; it removed the last code pretending otherwise.

### Canary

Owns *"what would have to be true for this to be observable, and is it?"* Finds the coverage that
does not exist, rather than the test that fails.

Origin incidents:

- **The Finatic gap** — no public key, no listing API, no code list. Whole classes of gateway
  behaviour cannot be asserted from this repo at all, and a proof claiming otherwise is wrong.
- **Staging's missing variant and VAT coverage** — the staging project held no menu item with a
  variant group and no configured tax rate, so an entire pricing path had never been exercised
  against real data. Seeding it was a prerequisite to proving anything about it.
- Corollary the session produced twice: **a green suite can pin the defect.** `stock-status`
  asserted `computeStockStatus(-5, null) === 'not_tracked'` on the same two shapes that were live
  and wrong on staging (#146). #131 was the first instance.

### One Writer

Owns the worktree. That only one agent writes per worktree is revision 1's rule. What this session
added is that **the orchestrator is not exempt**, and that the rule needs *detection*, not only
prohibition.

Origin incidents, both within the same hour:

- **Bidirectional collision in `ov/ov-d-195`.** An implementer's #165 commit landed under the
  integrator mid-commit, and the integrator's #195 commit landed under the implementer. Neither
  knew the other was there. Only `git add <explicit path>` stopped one being authored under the
  other's message — and neither `tsc` nor any test would have caught it, because the result
  compiles and passes.
- **Integrator cwd drift.** A `git push origin HEAD:main` ran from the docs branch instead of the
  intended worktree. It was rejected as non-fast-forward, and that rejection is the only reason the
  handover document did not land on `main`.

Controls, all mechanical:

- `git -C <worktree>` for every git command. Never accept a bare `git status` as evidence about
  your own tree.
- `git rev-parse HEAD` immediately before and after your own commit. If it moved by more than your
  commit, someone else is in the tree.
- Stage by explicit path. Never `git add -A`, `git add .`, or `git commit -a`.

### Integration & State Auditor

Verifies state mechanically, against artifacts, after the fact.

**RULE: this MUST be a SEPARATE INSTANCE — not a second mode of the instance that did the work.**

This is a rule, not a preference, and the reason is specific: the failures it exists to catch are
*invisible from inside the instance that caused them*, because the mistaken state is the state that
instance would report from. Both incidents above demonstrate it:

- the **cwd drift** was undetectable by the drifted shell — every relative command it ran agreed
  with itself;
- the **worktree collision** was found only because an implementer happened to run
  `git status --porcelain` *after* committing rather than before, and the integrator did not know
  it had collided with anyone until told.

Two modes of one instance inherits that blind spot exactly. The auditor must be able to observe a
state its subject cannot.

### Human Operator — device and reality verification

The human's own role, and not a fallback. Owns what no agent can obtain: taps on a real device, a
real card on a real terminal, a real phone on mobile data, and go/no-go on production.

Also owns, unchanged from revision 1: policy rulings, customer-facing copy, and anything changing
what a customer is told about money.

Two of this session's confirmed defects were reachable **only** this way — #202's Riviera
reproduction, and the "Menu coming soon!" flash during a slow category fetch (#214), which no test
asserts and which appears on every cold load of the first screen a QR customer sees.

## Activation model

Roles are activated by **failure class exposed**, not by size.

| Size | Chain |
|---|---|
| **S** | Reality & Proof → One Writer → integration verification. |
| **M** | The S chain, plus **Ledger or Canary only where the issue exposes that failure class.** Not both by default; not either by habit. |
| **H1** | The full chain, with rulings to the human **before** implementation, not after. |

**Auto-H1 regardless of size** — migrations, payments, auth, destructive cleanup, shared state,
stock, receipt identity, terminal onboarding.

The migration entry earns its place: `20260811120000` changed no enforced behaviour and still
blocked every production deploy, because the drift guard asks whether the **file and the ledger
agree**, not what the migration does. "The code doesn't need it" is not the question being asked.

## Addition to section 2 — the handoff block

Add this block. It is the difference between "I proved it" and "I proved as much as this
environment permits."

```
PROOF CEILING: UNIT | DB-INTEGRATION | STAGING | DEVICE | LIVE-PROVIDER
ACHIEVED:
GAP:
CEILING BLOCKED BY:
```

`CEILING BLOCKED BY` is filled **only when the ceiling is currently unreachable**, and must
distinguish two very different things:

- **obtainable** — "needs one completed staging payment", "needs a device tap". Say what would
  obtain it. Someone can go and get it.
- **should not be done** — "needs a write to the live terminal estate", "needs a production
  migration against an unmeasured constraint". Say why not. Nobody should go and get it.

Precedent for the second: production's `restaurant_terminals_status_check` vocabulary is still
unverified, deliberately. Settling it means inserting and deleting a row on the table that gates
terminal authentication, on the live estate. Staging was probed and answered; production was left
alone and the gap was *stated*.

## Rule 7 — a change that makes existing code reachable

> **WHEN A CHANGE MAKES EXISTING CODE REACHABLE, THE PROOF THAT IT WORKS IS NOT THE PROOF THAT IT
> IS SAFE.** Enumerate what became reachable, in full, as a separate deliverable.

Origin incident **#204**. Mounting `<Toaster />` app-wide was a one-line fix with a clean two-sided
proof. What it actually did was make **17 previously-unrenderable strings** visible at once — 10 on
the cart page, 3 on the tab page, 4 on order-secure, plus 2 on a platform-ops panel — none of which
any customer had ever seen, and none written in the knowledge that it would be read. Four concerned
a tab, a settlement or a price. Five rendered raw server error text.

`tsc` was clean, 24 tests passed, and the entire risk lay outside anything a test can assert. The
enumeration was the bulk of the work, and the contract had not asked for it.

The same commit surfaced `tab/page.tsx`'s "Cash payments are no longer available. Please select
Card." on a branch that fires for **card and other**, not only cash — a payment-method instruction
that can be wrong for two of its three triggers, unreachable until that mount and therefore never
reportable.

## Two further rules this session earned

**A negative probe must verify it LANDED before its result means anything.** In #191 a probe pattern
matched two sites, so the substitution silently did nothing — and all three tests stayed green,
which is indistinguishable from evidence. It happened again in #190 through a `sed` delimiter clash,
leaving 16 green. Echo the substituted line after every edit, or assert the pattern matched. A probe
that changes nothing looks exactly like a fix that works.

**A test that restates the rule instead of importing it proves nothing.** In #205 five tests stayed
green against a render site that had been reverted to the defective expression, because the test
carried its own copy of the rule. Fixed by extracting to `lib/cart/addon-display-price.ts` so the
test binds to shipped code; the same probe then failed 2 of 5 by name.

State the residual honestly: what that proves is the **rule**. That the call site uses it is covered
by reading and `tsc`, **not by test**.

## Deletion order, when cleaning up

Enumerate dependents before deleting, and **delete leaves first**.

Origin incident: removing four staging rows from a verification run deleted the audit rows first,
then failed on `receipt_documents_order_id_fkey` — leaving, for a few seconds, the worse of the two
half-states: the audit trail gone while the paid order remained.

And: **a cleanup script must discover dependents rather than trust the run's own list.** That run
reported the orders and audit rows it created. The receipt document it had also issued surfaced only
when the delete failed.
