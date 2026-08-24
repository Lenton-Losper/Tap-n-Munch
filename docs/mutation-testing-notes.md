# Mutation testing: how the harness lies to you

Written 2026-08-24, after mutation-verifying the 14 source-text suites (#330) and auditing 19 suites
for the "green over an error" shape (#331).

**Every fault recorded here produced a confident, specific, wrong answer about a suite that was
fine.** None of them errored. That is the failure mode worth internalising: a mutation harness does
not fail loudly when it is aimed wrong — it reports that your tests are worthless.

---

## The four that bit, in order of subtlety

### 1. A substring-preserving rename is not a mutation

The subtlest, and the one most likely to be repeated.

```
waiting_review  ->  waiting_reviewRENAMED
```

`waiting_reviewRENAMED` still **contains** `waiting_review`. Every `expect(code).toMatch(/waiting_review/)`
still passed, so the suite was reported as SURVIVED — "asserts something other than what its name
promises" — when it was correct all along.

Same trap:

| mutation | why it does nothing |
|---|---|
| `href` → `hrefREMOVED` | `href=` becomes `hrefREMOVED=`, but `toContain('href')` still matches |
| `foo` → `fooX` | any `toMatch(/foo/)`, `toContain('foo')`, `includes('foo')` survives |
| adding a suffix, ever | source-text suites almost always match on substrings |

**Rule: replace the token with something that does NOT contain it.** `waiting_review` → `pending_review`.
`RESULT_OK` → `RESULT_DENIED`, not `RESULT_OKAY`.

Check it before believing a SURVIVED: `mutatedSource.includes(originalToken)` must be **false**.

### 2. Mutating a file the suite never opens

`view-menu-keeps-the-tab` reads `v2/page.tsx`. `waiting-request-tells-the-customer` reads
`ActiveOrderBanner.tsx`. Both were mutated in `tab/page.tsx` because the suite NAME suggested it.

**Rule: read the suite's `readFileSync` / path constants first, and mutate what it actually opens.**
Never infer the target from the suite name.

### 3. Mutating the negative case

`customer-screens-have-an-exit` asserts that `session-ended` has **no** in-app exit — deliberately,
with a comment saying "the point is that the absence is chosen". Removing the exit there is
strengthening what the suite asserts, not breaking it.

**Rule: find which assertion your mutation is supposed to flip, and confirm that assertion expects
`true`.** A suite full of `expect(...).toBe(false)` cases needs the inverse mutation.

Related: an assertion that is a **disjunction** needs all its arms broken.
`hasExit = /router\.push\(|<Link\b|router\.back\(|href=/` accepts any of four controls; removing one
leaves three and the suite rightly still passes.

### 4. A harness whose failure mode looks like its finding

`execFileSync('npx', [...])` on Windows fails with `ENOENT`, because `npx` is `npx.cmd`. The runner
caught the exception, treated it as "the suite failed", and reported **all fourteen** suites as red
at baseline — a result indistinguishable from a genuine finding, and one that contradicted a full
jest run taken twenty minutes earlier.

**Rule: a spawn failure is not a test failure.** Distinguish them explicitly:

```js
catch (e) {
  if (e && e.code === 'ENOENT') throw new Error(`cannot run jest: ${e.message}`)
  return 'FAIL'
}
```

And **always run a positive control**: mutate something you KNOW is covered and confirm the harness
reports CAUGHT. If nothing is ever caught, suspect the harness before the suites.

---

## Two detectors that did not work, and why they are recorded rather than deleted

Hunting the "green over an error" shape across 19 suites (#331), after
`push-to-terminal-race-and-trim` was found green on 9 assertions while every request returned 500.

### Poisoning a table in the fake — too many false positives

Make `from('x')` throw for a table the fake names, and see whether the suite notices. It found two
"suspects", and **both were false positives**:

- `table-close-payment-safety` — the distress line was `[TABLE-CLOSE] closed with unpaid orders`,
  which is the behaviour under test being logged deliberately
- `accept-rollback-failure-is-not-silent` — "survived poisoning `orders`" because it never reads
  `orders`; its subject is `order_requests`

Worse, **six of the nineteen came back "could not locate a `from()` to poison"** — the regex could
not find their fake's shape. That is *not tested*, and it would have been easy to read the summary as
*clean*. A detector must distinguish "checked and fine" from "could not check".

### Patching `NextResponse.json` to catch 5xx — never fired

The direct instrument: wrap the response builder and shout on `status >= 500`. It reported all 19
clean — **including when re-run against the known-broken push-to-terminal fake**, where a 500 was
certain. The positive control is the only reason that was caught rather than published.

Compounding it, the first sweep passed `--setupFilesAfterEnv=...` on the jest CLI, which **swallows
the following test path as another value**. Every suite ran ZERO tests and the sweep printed a clean
result with an empty `Tests:` column. A row of zeros with no test counts is not a pass.

### What did work — cheap and sound

**Ask whether the suite asserts the response status at all.** A suite that checks `res.status`
cannot be green over a 500. That is a grep, it has no false negatives for this shape, and it reduced
19 suites to 3 worth reading:

```
gateway-amount-exact-match                asserts body.paid / body.applied / body.outcome  -> safe
terminal-payment-cent-tolerance-routes    asserts status inside a toEqual                  -> safe
terminal-cancel-payload-reaches-handler   asserts only that a handler was CALLED           -> tested
```

The third was decided by poisoning `createServerSupabaseClient` so the route could not reach the
database at all: **5 of 5 failed**, so it genuinely exercises its success path.

**Result: all 19 reach their success path.** The two that were red are repaired separately.

---

## The standing rules

1. **Never report a SURVIVED without checking the mutation actually changed the thing asserted on.**
   For source-text suites: `mutated.includes(token) === false`.
2. **Positive control first.** Break something known-covered. If the harness does not catch it, the
   harness is broken.
3. **"Could not check" is not "clean".** Report the three states — caught, survived, not applicable —
   and never let the third collapse into either of the others.
4. **A spawn failure, a config error and a test failure are three different things.** A harness that
   renders them identically will eventually tell you your test suite is worthless, and it will be
   wrong.
5. **Mutate the file the suite reads, not the file its name suggests.**

---

## A partition over an empty map is not a result (2026-08-24)

Same family as the two dead detectors above, and it survived long enough to reach a report.

`probe-sale-event-gap.ts` partitioned paid orders by `audit_logs.action = 'order.paid'`.
**That action has never existed.** `markOrderPaidConfirmed` writes `payment.completed`, hardcoded,
with no exported constant -- so the name was guessable, and I guessed.

The query returned **zero rows across 1633 paid orders**. Every bucket collapsed into
`(no order.paid audit row)`, and the script printed that breakdown as though it were an answer. I
then drew a conclusion from it -- "the detector is not blind on terminal traffic" -- which was not
measured from anything.

**The control collapsed too, and that is what should have caught it.** A control that agrees with
the result for the same reason the result is wrong is not a control.

### THE RULE

> **An instrument that groups by a key must refuse to report when the key is mostly absent.**

A `groupBy` never fails. It silently produces one enormous unknown bucket, formatted exactly like a
finding. So:

1. **Count the coverage before partitioning**, and print it: "grouping key present on N of M rows".
2. **Refuse below a threshold.** The probe now stops at under 20% and says why, rather than
   rendering a partition nobody can use.
3. **Read the constant, never the string.** Every action name in this codebase that is exported --
   `ORDER_CANCELLED_ACTION`, `PAYMENT_STATUS_CHANGED_ACTION`, `SECOND_PAYMENT_REFUSED_ACTION` --
   is exported precisely so a consumer cannot guess. `payment.completed` is the one on the paid
   path that is NOT, which is why this happened there and not elsewhere.
4. **Prefer a discriminator that does not depend on the instrument.** The probe now leads with a
   structural one -- `payment_channel = card_manual` AND a gateway reference -- which works on
   history predating any audit row.
