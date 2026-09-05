# FlashTap — Agent Operating Contracts

Four artifacts, plus the roles and deployment rules they depend on. Paste sections 1–3 into
agent briefs; section 4 and below are for whoever is coordinating.

**AMENDED 2026-08-15, section 1 TOOLCHAIN step 2 and a new PROBES THAT WRITE block.** The old
step 2 said "copy .env.test and .env.local in from the main checkout". `.env.local` holds
**PRODUCTION** credentials and `next dev` loads it ahead of `.env.test`, so an agent that followed
that step and started a dev server was aiming every write at live customers. It was a near-miss,
not an incident, and only because the agent checked before starting the server rather than after.
**A provisioning step that produces the outcome the document exists to prevent is the highest-severity
kind of error this file can contain**, which is why it is recorded at the top rather than in a
revision section at the bottom.

**Status: provisional. Revision 3, 2026-08-12** — see the revision at the end of this document
for four tooling-reliability rules. Rules 10-11 were earned landing #262 and re-derived from
verification after that session's notes were lost; rules 12-13 were ported afterwards from the
recovered session (docs/checkpoints-home-20260812) without disturbing them. Revision 2 added the role model, the activation model, the PROOF CEILING
handoff field and rules 7-9. Revisions 1 and 2 below are unchanged; nothing in either has been
retired.

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

2. .env. Copy **.env.test ONLY**. jest.setup-env.ts resolves .env.test
   relative to the WORKTREE root, so without it every live suite fails
   spuriously and you will report those failures as your own regressions.

   **NEVER COPY .env.local. IT HOLDS PRODUCTION CREDENTIALS.**

   `.env.local` points at the PRODUCTION Supabase project
   (`ihlmmpmolnpchzgwyhgh`) — the same one flashtap.app itself uses.
   Verified 2026-08-15 by reading the ref out of production's own served
   JS, not inferred from the filename.

   Next.js env precedence is
   `.env.development.local` > `.env.local` > `.env.development` > `.env`,
   and `.env.test` is loaded ONLY when NODE_ENV=test. `next dev` runs as
   `development`. So a worktree provisioned by the OLD version of this
   step — copy both files — answers every API request against
   PRODUCTION, and `.env.test` is never consulted at all.

   If you then run any probe that writes, you are writing to live
   customers' tabs, orders and payments while believing you are on
   staging.

   For a dev server, write a staging-only file instead, using the names
   lib/supabase/server.ts actually reads:

       .env.development.local
         NEXT_PUBLIC_SUPABASE_URL=<staging url from .env.test>
         NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon key>
         SUPABASE_SERVICE_ROLE_KEY=<staging service role key>

   and DELETE any .env.local the worktree already has. Both files are
   gitignored, so this is local-only and commits nothing.

Both ft-172 and ft-186 hit this independently on 2026-08-10 and solved
it two different ways — junction and npm ci respectively — and neither
solution was written down, so the third agent had to rediscover it.
That is why this section exists.

**THE NEAR-MISS THAT REWROTE STEP 2, 2026-08-15.** An agent fixing four
QR customer-flow exposures needed a dev server to prove them. It
provisioned the worktree exactly as this section then instructed — both
env files — and was one command from starting `next dev` and pointing a
WRITING probe at it. The probe created tabs, placed orders, seeded rows
and deleted them afterwards. Every one of those writes would have landed
on production.

It was caught only because the agent checked which project the server
would talk to BEFORE starting it, and the answer was not the one this
document implied. Nothing in the toolchain would have said otherwise:
the server starts, the routes answer, the fixture inserts succeed, and
the probe prints a clean result. **It is the sixth-instrument pattern —
a plausible, well-formatted, wrong answer rather than an error — except
that here the wrong answer is a write to live customer data, so there is
no second measurement that undoes it.**

The rule this earns is broader than the file name: **before any probe
that writes, establish which environment the thing under test is
actually connected to, from the thing under test — not from the env
file you believe you supplied.** The two-guard pattern under PROBES THAT
WRITE below is how.

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

PROBES THAT WRITE — TWO GUARDS, BOTH FATAL, BOTH IN THE PROBE
Any probe that creates, updates or deletes a row must refuse to run
until it has proved TWICE that it is not pointed at production. One
guard is not enough because the two things that can be wrong are
different things, and each guard only sees one of them.

  GUARD 1 — the probe's OWN credentials.
    if (!url.includes(STAGING_REF)) throw new Error(...)
    Catches: you loaded the wrong env into the probe process.
    Blind to:  the SERVER you are driving over HTTP, which loads its
               own env and may have loaded a different one.

  GUARD 2 — the SERVER under test, asked from outside.
    Read something through the server that ONLY EXISTS ON STAGING — a
    fixture restaurant, a seeded table — and abort if it is absent.
    Catches: the server is on production credentials while your probe
             is on staging ones, which is exactly what the .env.local
             trap produces.
    Blind to:  nothing the first guard covers.

Guard 2 is the one that matters and the one everybody omits, because it
is the only guard that interrogates the system under test rather than
the process doing the testing. A probe with guard 1 alone reports that
it is safely on staging while every request it makes lands somewhere
else.

Worked example, scripts/probe-qr-exposures-staging.ts:

    if (!url.includes(STAGING_REF)) throw ...            // guard 1
    const r = await api(`/api/tabs/active?restaurantId=${RID}...`)
    if (r.status === 404) throw new Error(               // guard 2
      'the server cannot resolve the staging fixture restaurant. '
      + 'It is not running on staging credentials. '
      + 'Aborting before any write.')

Both run BEFORE the first insert, and guard 2 runs before the fixture
is used rather than after it is created.

THREE MORE RULES FOR A WRITING PROBE, each earned the same session:

- SEED YOUR OWN FIXTURE IN A RANGE NOBODY ELSE USES, and clean it up in
  a `finally`. Table numbers 9200-9599 and session ids prefixed
  `probe-` made it possible to prove afterwards, by query, that nothing
  of the run survived — and to tell the run's leftovers apart from
  another agent's live click-test, which was sitting on the same
  project at the same time.

- DELETE LEAVES FIRST and DISCOVER dependents rather than trusting the
  run's own list. Revision 2 already says this; a probe needs it more
  than a cleanup script, because the routes it drives insert rows it
  never saw (customer_sessions from the token routes, receipts from an
  Accept).

- PREFER AN ORACLE THAT STOPS SHORT OF THE SIDE EFFECT. To prove an
  authorization gate on a route that SENDS something, seed a row that
  passes the gate and fails the NEXT check. The QR receipt-email probe
  used an order that is `completed` but not `paid`: 400 means auth
  passed, 404 means auth refused, and no email is ever sent in either
  direction. Proving an exfiltration gate by exfiltrating is not a
  proof, it is the incident.

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

#### FIRED AGAIN 2026-08-13, on an agent that had this document in context. Twice in one week.

The form was `git checkout origin/cloudflare-staging -- .` — used to refresh a worktree, not to
revert a file, which is why the rule above did not feel like it applied. It stages all of it. The
next commit in that worktree swept in **eight files belonging to another branch's commit** and
described them in a message about something else.

**Why it evades detection, stated plainly because knowing the rule was not enough:**

> `git status` compares the INDEX to the WORKTREE. This trap makes them agree. So a clean
> `git status` is the SYMPTOM of the trap, not the all-clear — it is what you see *because* the
> unintended content is staged, not evidence that nothing is.

Every mechanical gate reports success on the result: it compiles, it lints, tests pass, `git status`
is clean. There is nothing wrong with the CONTENT — the files are byte-identical to the branch they
came from — so no diff-based check flags it either. What is wrong is the AUTHORSHIP and the scope of
the commit.

**The two checks that work, both before every commit:**

```
git diff --cached --stat        # what is ACTUALLY staged
```

then compare that file list against **what you intended to change**. If a path you did not touch is
in it, stop. That comparison is the whole check; the command alone is not enough, because a staged
foreign file looks exactly like a staged intended one.

**And the one that catches it after the fact**, which is how this instance was caught:

```
git merge-base --is-ancestor <the other commit> HEAD    # NO means you re-applied its content
git rev-parse HEAD:<path>                               # against origin/<branch>:<path>
```

Blobs matching the branch while the branch's commit is NOT an ancestor is the signature: the content
arrived without the history. The push was going to be rejected as non-fast-forward, which is luck
rather than a control — the same luck that stopped the cwd-drift push in revision 2. `git rebase`
onto the real tip reduced the commit to its intended four files.

**Generalisation worth keeping:** the reason this rule needed restating is that it was written about
`git checkout <sha> -- <file>` for partial reverts, and the instance was `git checkout <ref> -- .`
for a worktree refresh. Same command, different intent, so the rule did not fire in the reader's
head. The rule is really about the FLAG-FREE FORM OF `git checkout` WITH A PATHSPEC, whatever the
pathspec is and whatever it was for.

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
- **`scripts/deploy/deploy-production.mjs`, run locally, is the production path** — by design, not
  as a fallback. It is what enforces the sequence: artifact gate, upload at 0%, smoke the preview,
  record the rollback target, explicit two-flag promotion, sampled live health.
  `production-worker.yml` is **not** the route and must not be described as one. GitHub Actions is
  unavailable at the account level; jobs are rejected before executing any step. The workflow file
  stays in the tree as a record of the same sequence, but nothing dispatches it. See
  `docs/production-deploy-runbook.md`
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

---

# Revision 3 — 2026-08-12

Written from a fresh session on a new machine. The prior session's brief named a checkpoint
(`55e6dac`) and a "Revision 3" that turned out not to exist on any branch — the session that
earned them ran on a machine whose work was never pushed, the same failure mode Revision 1 already
names ("work can exist on no remote at all") applied to this document about itself. What follows is
**re-derived from this session's own verification**, not recovered from memory, per the human's
explicit instruction not to guess at what the lost session wrote. Revisions 1 and 2 are unchanged.

Same standard as before: every item cites what was checked, and how.

## Rule 10 — a script's own location is not where you think you are running it against

`scripts/check-migration-drift.mjs` resolves the migrations directory it audits from its OWN file
location, not from where it is invoked:

    const __dirname = dirname(fileURLToPath(import.meta.url))
    const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations')

This is ordinary, usually-correct Node.js practice — a script resolving its own assets relative to
itself works regardless of `cwd`. It becomes a footgun specifically under this project's TOOLCHAIN
rule: `node_modules` is junctioned across worktrees, but `scripts/` and `supabase/migrations/` are
not — every worktree carries its OWN copy of this file. A path that reaches into a DIFFERENT
checkout than the one you are standing in — a stale absolute path copied from an earlier command, a
habit of running the main checkout's copy from inside a worktree — audits THAT checkout's
migrations, silently. The output is correctly formatted and confidently wrong; nothing distinguishes
it from a genuine run against your own tree.

**Demonstrated directly this session, not only reasoned about** — see Rule 11: two worktrees open at
once turned out to be carrying genuinely different copies of this exact file, which is what led to
finding Rule 11 in the first place.

**Always invoke the copy inside the worktree you are auditing** — `node scripts/check-migration-drift.mjs`
from that worktree's own root, never a path reaching into another checkout. Same discipline as the
TOOLCHAIN section's `node node_modules/typescript/bin/tsc`, and the identical reason: the thing that
silently resolves to the wrong target gives no error, only a wrong answer.

## Rule 11 — PRODUCTION'S deploy gate runs a two-state drift check. Staging's runs three.

Say it in that order, because the reverse — "the drift check has three states" — describes
`scripts/check-migration-drift.mjs` as a single concept and is wrong for the copy that actually
gates a real deploy. **This rule's own first draft made that mistake**: the instruction that asked
for it to be written up described "the drift check having THREE states not two" without saying
staging-only, which is only true of one of the two copies. It was corrected before being recorded
here, but the instruction that produced it was not verified before being repeated, which is
precisely what this document's own VERIFY BEFORE TRUSTING rule (section 1) says not to do — including,
apparently, to a human's own brief.

The two copies, read directly rather than inferred from a commit message:

- `origin/main:scripts/check-migration-drift.mjs` — TWO states: OK or FAILED
  (`LOCAL_NOT_APPLIED` / `APPLIED_NOT_LOCAL`, both from the script's own docblock). No
  `targetEnvironment`, no `-- @env:` parsing, no scope concept at all.
  `.github/workflows/production-worker.yml:138-139` runs `node scripts/check-migration-drift.mjs`
  checked out from `main` — **this is what actually gates a production deploy.**
- `origin/cloudflare-staging:scripts/check-migration-drift.mjs` — THREE states: OK, a
  non-blocking WARNING (a migration applied outside its declared `-- @env:` scope, or a target
  environment `SUPABASE_URL` couldn't identify), or FAILED. Added by `76153d8` (#143, "teach
  drift check environment scope"). `.github/workflows/staging.yml:546-551` runs the same command,
  checked out from staging.
- `76153d8` is reachable from `docs/agent-operating-contracts`, `cloudflare-staging`, and several
  `fix/*`/`reconcile/*` branches — **not from `origin/main`.** Filed as its own issue, **#269** —
  this is a live gap in the deploy pipeline, not only a documentation finding, and belongs on the
  issue tracker independent of this rule existing.

**Dormant today** — no migration currently committed on `main` carries an `-- @env:` header (all
files scanned this session). It stays dormant only until someone commits an environment-scoped
migration believing the docblock's description of the feature is live everywhere. On `main` the
header is not recognised at all, the file is scoped `both` by default, and a migration meant to be
staging-only would be reported `LOCAL_NOT_APPLIED` against production the moment it's committed —
the exact "genuine dilemma" #143 was written to resolve, silently reintroduced on whichever
environment doesn't have the scoping. **Nobody will expect the two environments to disagree about
it, because nothing about either script's own output says the other one exists.**

**Same class as Revision 2's close-audit methodology** — `main` is built by cherry-pick, so
"fixed" drifts — except every prior instance was product code. This one is the AUDIT TOOLING
ITSELF running two different rule sets on the two environments it is supposed to be comparing,
which is a blind spot no close-audit run FROM either environment can see about its own gate — the
same shape as Revision 2's Integration & State Auditor section, applied to a script instead of an
agent. And now, once, to a human's brief instead of an agent's.

**Before relying on a green drift check for anything scope-sensitive, confirm which version actually
ran**: `grep -c targetEnvironment scripts/check-migration-drift.mjs` in the checkout the gate used;
zero means the two-state version, `-- @env:` headers are decoration there, and `76153d8` needs
porting to `main` before scoping can be trusted on production's own gate.

## Rule 12 — the migration LANDING has four states, and two of them read clean

Distinct from Rule 11, which is about two different *scripts*. This is about the two *facts* a
single drift check compares — the committed file and the ledger row — and it is why landing a
migration has an ordering that is not obvious.

Ported from a parallel session that landed #262's anon-grant migration on production 2026-08-12;
the measurements are that session's, and were taken against the production ledger.

|  file on `main` | ledger row | drift check | |
|---|---|---|---|
| no  | no  | **CLEAN** | 127 local / 127 applied, OK — *and the SQL was already applied* |
| no  | yes | FAILS | `APPLIED_NOT_LOCAL` |
| yes | no  | FAILS | `LOCAL_NOT_APPLIED` — blocks EVERY production deploy, not just this one |
| yes | yes | **CLEAN** | 128 local / 128 applied, OK |

**Row one is the one nobody expects.** "Drift is clean" did not mean the migration was unapplied,
and did not mean it was recorded. It meant *both sides were equally ignorant of it*. A clean drift
check is not evidence about the database — same family as the 42501 correction and the
`test.failing` trap: a signal that looks like information and is not.

The consequence is the procedure. Because rows two and three both fail, **the ledger repair and the
file merge each break the gate on their own, in opposite directions.** They cannot be spaced out:

1. Apply the SQL, and verify it by **probing enforced behaviour** — never by the ledger (#263).
2. Prepare the commit **completely** and verify it in isolation: real compiler, its own suite, blob
   identities, clean index. Do not push.
3. Repair the ledger.
4. Push immediately.
5. Re-run the drift check and confirm clean **on the new numbers** — both counts must have moved by
   one. Unchanged counts mean something did not land.

Steps 3 and 4 are the exposed window; nothing may be interleaved and no deploy may run in it. Doing
step 2 first is what shrinks that window to seconds. Doing it after step 3 leaves production
undeployable for as long as the commit takes to prepare — on that landing, a full typecheck.

Corollary, and the reason step 1 stands alone: `db query` does not write the ledger. Confirmed
again on that landing — the ledger row was absent immediately after a successful apply. **A
verified-present object gets `migration repair --status applied`, never a re-run**, and the
committed file is never rewritten.

## Rule 13 — the sixth lying instrument, and the first one built while looking for the failure it hid

> **`git rev-list --count --not --remotes=origin <branch>` returns 0 for every branch, always.**
> `--not` is POSITIONAL: it inverts every ref that follows it, including the branch you meant to
> ask about. The command means "reachable from nothing", which is nothing.
>
> The correct form puts the branch FIRST: `git rev-list --count <branch> --not --remotes=origin`.

Observed 2026-08-12. A session was asked — explicitly, because three sets of work had already been
lost that week — to find every local commit not on origin. It ran the broken form across every
branch, got 0 everywhere, and reported **"none — every local branch tip is reachable from origin"**.

The correct form, run minutes later on the same repository, found **18 branches with unpushed
commits**, including 8 on the documentation branch from that same day — which existed on no origin
ref at all and would have been the fourth loss.

Measured side by side, same repo, same branch, same moment:

    WRONG  git rev-list --count --not --remotes=origin docs/agent-operating-contracts   -> 0
    RIGHT  git rev-list --count docs/agent-operating-contracts --not --remotes=origin   -> 8

**What makes this the worst of the six is not the flag. It is that the instrument was built for the
express purpose of catching this failure, and it reported the reassuring answer.** The other five
lied about a thing being checked; this one lied about the check itself, to the person who had just
said they did not trust it. A green from a safety check written in the same breath as the fear it
addresses deserves one adversarial test before it is believed.

**The general form, which is the transferable part:** any predicate whose FALSE answer is the
comfortable one must be shown to be capable of returning TRUE before its FALSE means anything. That
is the two-sided-probe rule from Revision 1, applied to a diagnostic rather than to a fix — and it
is cheap here, because a repository always has *something* unpushed to point it at, or one
`git commit` makes one.

The five preceding instruments, for the pattern: `EXIT=$?` after a pipe reporting `head`'s status ·
`npx tsc` resolving to a squatter that exits 0 · a `file://` main-module guard that never matches on
Windows so CI scans nothing · probe substitutions that silently match nothing (repeatedly, and on
this project usually because the file is CRLF and the pattern was LF-anchored) · a path-relative
script auditing the wrong checkout (Rule 10). **Every one produced a plausible, well-formatted,
wrong answer rather than an error, and every one was caught by a second, differently-shaped
measurement — a blob hash, a version string, a sibling `ls` — never by reading the output more
carefully.**

---

# Revision 4 — 2026-08-26

## Rule 14 — never cite an issue number in code or a commit before the issue exists

> **One GitHub tracker serves both codebases. An issue number written into source or a commit
> message is a claim on a number nobody has reserved, and the next `gh issue create` will take it.**

Observed 2026-08-26, by causing it.

`#346` had been written into `src/constants/paymentCopy.ts` (`// ─── #346: the 42 seconds ───`), into
terminal commits `85bf62a` and `4fc3126`, and into `2368152e` in the web repo — while **no issue
#346 had ever been opened**. The next `gh issue create`, for an unrelated finding, was allocated
346 and collided with all of it.

GitHub issue numbers are sequential per repository and are never reusable, so the collision cannot
be undone. The repair was to rewrite the newly-created #346 into the issue the code already
referenced — filed retroactively, saying so in the first line — and refile the new finding as #347.

**The code references are the fixed points.** They are committed, they are in a signed-copy file,
and they are quoted in three commit messages across two repositories; an issue body is none of
those things. When the two disagree, move the issue.

### Why this is cheap to get wrong here specifically

`Lenton-Losper/Tap-n-Munch` is the single tracker for **both** the web repo (`Desktop/mvp/*`) and
the terminal repo (`D:\RN\FlashTapTerminal`, labelled `terminal-repo`). Numbering is shared, but the
two codebases are worked on in separate checkouts and often by separate agents, so the number an
agent sees as "next" in one repo's commit log has no relationship to what the tracker will allocate.
Two agents can each reason their way to the same free number without either being careless.

### The contract

1. **File the issue first, then cite it.** A number that exists is a number nobody else can take.
2. **If you find a number cited in code that is not filed** — `git grep -n '#3[0-9][0-9]'` against
   both repos, checked against `gh issue list --state all` — **file that issue before you create
   your own**, retroactively and marked as such. It costs one command and it makes every existing
   reference correct.
3. **Before `gh issue create`, look at the next few numbers.** `gh issue list --state all --limit 1`
   gives the current maximum; grep both repos for the two or three numbers above it.
4. **Never renumber code to match a tracker.** Rewriting a signed-copy file or a commit message to
   chase an issue number is the tail wagging the dog, and commit messages cannot be rewritten after
   a push anyway.

### The general form

This is Rule 10's shape one level out. Rule 10 is *a script's own location is not where you think
you are running it against*; this is **an identifier is not yours until something authoritative has
issued it**. Both fail the same way: the local view is self-consistent and confidently wrong,
because the authority was never consulted. Anything allocated by a shared external system —
issue numbers, migration timestamps, `order_number`, receipt sequences — has the same shape. Ask
the allocator, do not infer from what you can see.

## Rule 15 — explicit `git add` does not protect you when someone else's work is already staged

> **`git add <your-file>` controls what you ADD. `git commit` commits the whole INDEX.**
> If another agent left files staged in the checkout before you arrived, your explicit `git add`
> is irrelevant — they go into your commit, under your message, with you as the author.

This is Revision 1's "never `git add -A`" rule with the hole it left. That rule assumed the danger
was a convenience flag sweeping up *unstaged* work. It is not the only shape: the index can already
be dirty, and then no amount of care at `add` time helps.

Observed 2026-08-26 in `restaurant-menu-screen`. Nine of another agent's `scripts/prod/` files were
already staged when the session began. `git add docs/agent-operating-contracts.md` added exactly one
file. `git commit` then committed **ten**, and `git show --stat` on my own commit was what caught
it — 1,343 insertions across files I had never opened.

### The form that is actually safe

    git commit -F /tmp/msg.txt -- path/to/your-file.md

A pathspec on `commit` commits **only those paths** and leaves everything else staged exactly as it
was. Use it whenever you are not the only writer in a checkout, which on this project is most of the
time.

### The repair, if you have already committed and not pushed

    git log --format=%B -n 1 HEAD > /tmp/msg.txt   # keep your message
    git reset --soft HEAD~1                        # restores THEIR staging too
    git commit -F /tmp/msg.txt -- path/to/your-file.md
    git status --short                             # their files must be back as `A `/`M `

The soft reset is the important part: it puts the index back the way it was, so the other agent's
staged work survives. A `--mixed` or `--hard` reset would unstage or destroy it.

### The check that catches it

**`git status --short` BEFORE you commit, every time.** A staged `A `/`M ` line you did not put
there is the entire warning you get, and it appears nowhere in `git diff`, which shows unstaged
changes only. Pair it with `git show --stat <sha>` after — Revision 1 already asks for that, and it
is what caught this — but the `status` beforehand is cheaper and turns a repair into a non-event.

### Why this is reachable here rather than theoretical

Two agents work this repository at once, in different checkouts, and the orchestrator lands changes
directly in whichever tree is open (Revision 1 recorded that the co-writer was the orchestrator, not
a rogue peer). Worktrees isolate files from *other worktrees*, never from anyone working in *yours*.
"One writer per checkout" is a rule, not a mechanism, and the index is shared state that rule does
not cover.

## Rule 16 — a mock encodes an assumption about the mocked module's FAILURE shapes, and only a live probe can check it

> **When a suite must mock a module, it stops testing that module's contract and starts testing
> your belief about it.** The mock agrees with the code because the same person wrote both, in the
> same hour, holding the same wrong idea.

Sits beside the frozen-fixture rule. That one says a fixture captured from reality goes stale; this
one says a fixture *invented* from reading the source was never right to begin with, and nothing in
the suite can tell you.

### The worked example, 2026-08-26

`__tests__/held-payments-store-and-release.test.ts` mocks `@/lib/terminal-auth`. It **has** to:
`requireTerminalAuth` imports `jose`, which is ESM-only, and ts-jest cannot load a route that
imports it (see the standing note on that). The mock threw a `Response`, because that is what
`requireTerminalAuth` throws for a missing `Authorization` header.

It also throws a **JOSEError** — a plain `Error` — when the header is present and the *token* is
malformed or expired. Two shapes from one function. The route's single outer catch returned the
Response and answered 500 for anything else, so:

    no token                  ->  401   correct
    Bearer not-a-real-token   ->  500   wrong, on all four production hostnames

Twenty-four tests passed. They could not have failed: the mock only ever threw the shape the code
already handled. **The mock was a faithful copy of the misunderstanding.**

Why it mattered: `terminalFetch` refreshes the access token and retries on **401**, not on 500.
Terminal tokens last an hour. A device whose token aged out would have been answered 500 forever
and never recovered — on the endpoint whose entire purpose is releasing a card transaction that
exists nowhere else on that device.

### What found it, and the part worth copying

A production probe with a **junk-token case that was added for completeness**. The probe's real
question was "did the route ship", answered by requiring `POST /api/terminal/held-payments` to
return 401 while a nonexistent terminal path returns 404 — the control, because a 401 alone cannot
tell *refuses* from *not there*. The junk-token line was a third case thrown in while writing it.

**It found the defect nobody was looking for.** That is not luck twice over: a probe that enumerates
a module's failure *inputs* rather than asserting one expected *output* will keep doing this,
because the inputs are where the assumption lives.

### The contract

1. **When you mock a module, write down what failure shapes you believe it produces** — in the mock,
   as a comment. That belief is now reviewable instead of implicit.
2. **Read the mocked module's source for `throw`**, and count the shapes. `requireTerminalAuth`
   throws two. A helper that throws a `Response` in one branch and lets a library error escape in
   another is the common case, not an exotic one.
3. **Make the mock throw every shape**, not the convenient one. If the suite passes unchanged, the
   handler was already general; if it fails, you have found the defect at desk cost.
4. **A live probe must exercise the auth failure inputs**, because (1)–(3) are still your beliefs.
   Unauthenticated, malformed-token, and expired-token are three different requests and cost three
   lines.
5. **Every "it refused" assertion needs a control that would have been refused differently.** Same
   rule as Revision 3's two-sided probe, applied to status codes: pair the endpoint under test with
   a path that does not exist and require the two answers to DIFFER.

### The general form

A mock is a **claim about a boundary**, and boundaries are exactly where beliefs are cheapest to get
wrong and most expensive to leave wrong. Every other instrument fault in this document lied about a
thing being checked; this one lied about the *shape of the world the check assumed*. The suite was
internally consistent, well-named, and thorough, and it was measuring the author's mental model.

## Rule 17 — a sub-agent's silence is not a signal, and a verification goes stale the moment you stop looking

> **The integrator checks the tree. It does not wait for a report, and it does not quote a check it
> took ten minutes ago as though it were current.**

Two halves, learned in the same session, from opposite directions.

### Half one — silence is not a signal

A terminal sub-agent went idle **twice** without reporting. Both times the work was real and
complete: the first time it had finished a full read-only audit and written the report as plain
text, which never left its process; the second time it had committed two fixes and written a test
file. An integrator waiting for the report would have concluded it had stalled and either re-issued
the work or, worse, redone it.

`git log`, `git status --porcelain` and the file itself answered the question in one command each.
**A peer's state is observable. Ask the repository, not the peer.**

The corollary is for the sub-agent, and it is worth stating because it caused this: **plain text
output does not reach the integrator.** Only an explicit message does. An agent that writes an
excellent report into its own transcript has not reported.

### Half two — and your own check goes stale

The same session, the other direction. The integrator ran `git status`, saw an untracked test file,
and some minutes later quoted that reading in a message as the current state. By then the agent had
committed it. The check had been correct; **relaying it in the present tense after time had passed
was not.**

That is the more insidious half, because the reading was genuine. Nothing was fabricated. The fault
was the tense.

### The contract

1. **Verify a peer's state directly, from the repository, before drawing any conclusion from
   silence.** Idle is not stalled, and a missing report is not missing work.
2. **Re-read immediately before you act on it or quote it.** A `git status` is a photograph, not a
   subscription. If more than a moment has passed, take it again — it costs one command.
3. **Say when you looked.** "As of `<sha>`" or "checked just now" makes the tense explicit and lets
   the reader discount it themselves.
4. **A sub-agent reports through the message channel, always.** Anything else is a diary.
5. **When a peer corrects your reading, check the correction too** — then say plainly which of you
   was right about what. In this instance the agent was right that its file was committed, and the
   integrator was right to have checked rather than waited. Both halves went into this rule.

### Why this belongs beside the instrument rules

Every other entry here is about an instrument that reported a comfortable falsehood. This one is
about an instrument that was **accurate and then aged** — and about a second instrument, the peer's
report, that never fired at all. The failure mode is not a wrong answer; it is a right answer
consumed at the wrong time, and a right answer that was never delivered.

## Rule 18 — the tracker must be true at all times, and a stale label is a defect

> **Every state change is recorded the moment it happens, not at the end of a batch.**
> Updating the issue is part of finishing the task, not a chore that follows it.

### The four transitions, and when each is recorded

| when | do this | when exactly |
|---|---|---|
| fixed on staging | add `fixed-on-staging` | **in the same commit sequence as the fix.** Do not wait for the deploy. |
| deployed | strip `fixed-on-staging`, close with the **production SHA** and the decisive check | **in the same run as the deploy verification.** Not later. |
| ruled on | strip `needs-ruling` | **the moment the owner answers**, even if the work has not started |
| superseded or stale | close it, and say **why** | immediately; never leave it bare |

### A label that no longer applies is a defect, not untidiness

Two cost the owner time in a single day:

- **`launch-blocker` on an issue that was fixed and closed.** It reads as outstanding risk on every
  triage pass, and every reader has to re-derive that it is not.
- **`blocked-external` on work we can do ourselves.** That one is worse: it does not merely mislead,
  it *removes the issue from consideration*. #136 and #137 sat under it while being ordinary
  terminal-repo work — and #136 turned out to bear directly on a production question the owner had
  been treating as a mystery.

A wrong label is a wrong answer to a question nobody re-asks. `blocked-external` in particular is
load-bearing: it says "do not look here", so nobody does.

### Why "the moment it happens" and not "at the end"

Because the end is where it gets dropped. A batch that ends in a deploy, a report and a handover has
three natural stopping points before the tracker, and the tracker is the one with no gate on it —
nothing fails, no test goes red, and the cost lands on whoever reads it next, which is usually the
owner during triage.

It is also the same failure this document records everywhere else, one level out: the *code* is
correct and the thing that *describes* the code is stale. Rule 17's aged verification, Rule 16's
mock encoding an old belief, the comments corrected in `8ea15a8` and `c5a89d9` — a label is the
outermost layer of the same problem.

### The check

After any batch that changes state, the tracker answers correctly without a human reconstructing
it: no closed issue carries an open-state label, no open issue carries a state it has passed, and
every `needs-ruling` is genuinely awaiting a person.

## Rule 19 — parallel authors collide on `<today>HHMMSS` by default, not by accident

Two migrations were authored on 2026-08-26, on two different unpushed branches, with the identical
version prefix `20260826160000`: `order_requests_claimed_at` (#215) and
`restaurants_drop_payment_methods` (#349). Three agents were writing migrations that evening.

Neither had merged. Had both landed, `check-migration-drift.mjs` — which identifies a migration
**by numeric prefix alone** — would have recorded the version in the ledger **once**, reported
*in sync*, and left one of the two permanently unapplied **with nothing reporting it**.

The consequences were asymmetric and both bad. A skipped `claimed_at` means #215's reaper ships and
reaps nothing, since its whole premise is that a reaper cannot exist until the claim records a
time — a cron running every two minutes, doing nothing, looking healthy. A skipped drop means
#349's dead column survives the fix that claims to have removed it.

**This is what the naming convention does under concurrency.** Everyone derives `<today>HHMMSS` from
the same clock and everyone rounds to the hour. With one author that is fine; with three it is the
expected outcome. Treat a same-day collision as the default case to design against, not as a freak.

### The convention: the integrator assigns the version, or each author owns a minute offset

Whichever is cheaper for the shape of the work:

- **Integrator assigns** — an agent that needs a migration asks for a version and is given one. Best
  when the integrator is already gating the branch.
- **Per-author minute offset** — agent A takes `HH:10`, B takes `HH:20`, C takes `HH:30`. Best when
  agents are long-running and asking is a round trip. The offset belongs in the agent's brief.

Either way: **never renumber a migration that has already run against a database.** Renaming an
unpushed file costs nothing; renaming an applied one means the ledger and the tree disagree about
which file a recorded version refers to, and the repair is manual. See the migration repair-only
rule — verified-present objects get a ledger repair, never a re-run.

### The gate is the backstop, not the fix

`scripts/check-migration-version-unique.mjs`, in `production-worker.yml`'s build verification.
Two-sided against the real filenames: red on the colliding pair, green after the rename.

**One finding from building it, because it nearly shipped decorative.** The rule it exists to
enforce — *distinct filenames per version, never occurrences* — was initially unpinned. Swapping the
`Set` for an `Array` failed no test, because a directory cannot physically hold the same filename
twice; the repeated-name input the `Set` collapses only arises when names are gathered **across
branches**, which is exactly what produced ~140 false "duplicates" on a clean tree during the
investigation. It was fixed by having the detector take a **list** rather than a directory, so the
script's self-test drives the real function instead of a private copy of its logic.

A self-test with its own implementation of the logic proves only that the copy still works. If a
checker cannot be made to fail by breaking the thing it checks, it is decoration — and a collision
checker that has quietly stopped detecting exits 0 and looks exactly like a clean tree, which is the
same false negative as the guard it backstops.

### It was found by an agent that was not looking for it

The tracker agent — which writes no code and was verifying #280's premise to set a state label —
found it firing live between two other agents' unpushed branches. Neither authoring agent could see
it: each saw only its own tree. **A collision between parallel workers is visible only to something
looking across all of them**, which is an argument for the integrator holding that view explicitly
rather than assuming the agents will notice.

## Rule 20 — a comment asserting a production fact is a measurement with a date, not a statement

`lib/orders/auto-cancel-stale-pos-orders.ts:521` asserted that `payment.attempt_started` **had never
been written in production**. It was **true on 2026-08-05 and false on 2026-08-06** — the removal
commit landed at 16:13, the first marker arrived at 09:24 the next morning. It then stood unchallenged
for **21 days**, was cited as settled fact in #158 and two design documents, and became the load-bearing
premise of a recommendation that turned out to be backwards.

Nothing caught it because **nothing type-checks a comment**. It compiled, it read as authoritative, and
its shelf life was seventeen hours.

### The rule

Any comment asserting a production FACT — a count, a zero, a rate, "this has never happened", "no
venue has X" — is a **measurement, and measurements have dates.** Treat it as one of:

1. **Date it in the comment.** "As of 2026-08-05, zero rows" is honest and ages visibly. "This has
   never been written" claims a present tense it cannot keep.
2. **Make it a test that re-measures.** If the fact is load-bearing — if code or a decision depends on
   it — an assertion that re-derives it from the database is the only form that cannot rot. A test
   that fails when the world changes is the world telling you it changed.

Prefer (2) whenever the fact is doing work. Use (1) for context that merely explains.

### Why the undated form is worse than no comment

An absent comment sends the reader to the data. A confident, undated, wrong one **stops them looking** —
and the more precisely it is phrased, the more it is trusted. "Zero times" reads as though someone
checked, which they had; the defect is that the reader inherits the certainty without the date.

This is the same family as [[false-negatives-are-not-checked]]: "all clear" gets shipped and believed,
while "it's present" gets verified. A comment saying "never" is an all-clear with no expiry.

### Where this has already bitten

- `auto-cancel-stale-pos-orders.ts:521` — the case above. 1,009 rows against a claim of zero.
- `app/api/orders/route.ts:355` — "Riviera and FNB ChowNow both sit at `payment_methods=["card"]`".
  FNB ChowNow's real gate now reads `{card}` but the *other* column reads `{cash}`, and the comment
  does not say which it means or when it was true.
- The 2026-08-13 re-acceptance comment quoted across several files after the ruling was superseded on
  2026-08-16.

When you find one, correct it **and date the correction** — otherwise you have replaced one undated
claim with another.

## Rule 21 — an instrument that reports to the device is not an instrument for the operator

`recordSaleEvent` catches its own failure and writes a `console.error`. That failure ran at **99.7%
for a month** — 1,018 of August's 1,021 card payments had no ledger row — and nobody saw it, because
the report landed on a terminal, in a restaurant, that nobody reads.

The fix shipped in vc99 was a `recordWiretapEvent` in the same `catch`. **That was still not an
instrument.** `recordWiretapEvent` writes to the device's native module; there is no wiretap table
and nothing reaches the server. The failure became *recorded* without becoming *queryable*, which is
the same category of gap wearing a different coat.

### The rule

**Ask where the report LANDS, not whether one is written.** A trace is an instrument only if the
person who needs to act on it can read it without holding the device.

And the sharper half, which is what makes this a rule rather than an anecdote:

> **A reporter that shares a failure mode with the thing it reports on is not a reporter.**

If the call being watched is the device's ability to reach the server, then a report sent over that
same channel cannot arrive precisely when it matters. The instrument is silent exactly in the
condition it exists to detect — and its silence is indistinguishable from health.

### What to build instead

**Ask the question from the side that always has the answer.** The server knows it marked an order
paid by card; a ledger row should follow within seconds; nothing checked that it did. A sweep for
*"paid card orders with no sale row older than N minutes"* would have fired on 28 July, on the first
day, at 101-a-day volume — with no APK, no device cooperation and no new endpoint. It works
**precisely when the device has gone quiet**, which is the only condition under which it matters.

Where a device-side reason is genuinely wanted, carry it on a **different call that is known to
succeed** (the payment report itself demonstrably works — it produced audit rows throughout), or
queue it locally and flush opportunistically. Never on the channel under test.

### The generalisation

This is the same family as [[false-negatives-are-not-checked]] and Rule 19's decorative-checker
finding, and the third instance in one week:

- a **checker** whose self-test reimplements its own logic proves only that the copy works;
- a **detector** reading an empty table reports "zero duplicate charges" and is believed;
- a **reporter** on the failing channel is silent exactly when it matters.

All three are instruments that agree with themselves. **Before trusting one, ask what it would do if
the thing it watches were completely broken** — if the answer is "look exactly the same", it is not
an instrument.
