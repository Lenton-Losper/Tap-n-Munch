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
- edit outside your worktree
- run the bare full test suite (see TEST ISOLATION)
- choose a policy answer yourself (see POLICY BOUNDARY)

TOOLCHAIN
A worktree without node_modules resolves `npx tsc` to a squatter
package that prints "This is not the tsc command you are looking for"
and EXITS 0. Any exit-code check sails straight past it, and every
"typecheck green" claim you make afterwards is worthless.

Always invoke node node_modules/typescript/bin/tsc, which cannot
resolve to anything but the local compiler. Verify --version reads
5.9.3 before trusting any result.

A fresh worktree also has no .env.test, and jest.setup-env.ts resolves
it relative to the worktree root — without it, live suites fail
spuriously and you will report those failures as yours. Copy .env.test
and .env.local in from the main checkout. Both are gitignored.

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

PROOF
Classify your proof and produce the right kind:
- Regression — failing test, fix, passing test. Default for behaviour.
- Static — compiler/lint failure, fix, clean. For pure type work,
  tsc exit 0 is the proof; strengthen it with a negative probe you
  confirm fails, then revert.
- Invariant — query shows bad state, fix, invariant restored.
- Integration — real request, device, or provider interaction.
- Observational — logs, version endpoint, runtime artifact.

Do not invent an artificial test to satisfy procedure. Say which kind
you used and why.

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

SEPARATE PROBLEMS
File them separately and continue. Switch only if blocking,
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

NEW ISSUES FILED: #___

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

| Size | Shape |
|---|---|
| **S** | One implementer. Typo, isolated UI, obvious null check. |
| **M** | Investigator + implementer. |
| **L / H1** | Full issue team. |

**Auto-qualifies as H1 regardless of apparent size:** payments, auth, migrations, stock,
destructive data operations, anything touching a shared library with payment callers.

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

**Independent verifier** — distrusts everyone. Reads artifacts, not reports: `git rev-parse`,
`git cherry`, `git patch-id --stable`, actual test output, `/api/version` **cache-busted**.

The misses that produced this document were state claims, not bad code — a SHA that no longer
existed on any branch, a branch believed pushed that was not, a baseline pinned to a commit that
had been rebased away, two issue counts that did not reproduce. The verifier's job is mechanical
and catches exactly that class.

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

## Operating rule

Discover in parallel. Reframe before deciding. Write in isolation. Report structurally.
Integrate serially. Verify independently. Deploy by blast radius.

**Agents may summarize reality. Gates must inspect it.**
