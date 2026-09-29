/**
 * MUTATION CHECK for D2 / D3 / D1-outcome (Sprint 2026-09-29, terminal 2.41).
 *
 *   D2  "nothing was charged" only after a CONFIRMED operator cancel (owner ruling 2026-09-29).
 *   D3  PaymentScreen launches the card reader at most once per attempt, and releases the guard.
 *   D1  the web's new failure-report outcome 'attempt_released_order_kept' classifies as not_paid.
 *
 * Same engine as scripts/mutate-f-termpay.js: each mutation breaks ONE guard, prints the mutated
 * line back from disk, runs the suites that must catch it and requires them RED with a real test
 * count; the file is restored whatever happens; finally the suites run unmutated and must be GREEN.
 *
 *   node scripts/mutate-d2d3.js        # all mutations
 *   node scripts/mutate-d2d3.js D3b    # one
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const SIM_SUITE = 'src/screens/__tests__/paymentSimulation.test.tsx';
const VERDICT_SUITE = 'src/lib/__tests__/paymentVerdict.test.ts';
const OUTCOME_SUITE = 'src/lib/__tests__/paymentReportOutcome.test.ts';

const MUTATIONS = [
  {
    id: 'D2a',
    what: 'isNeverStartedVerdict back to isE04111 only (any E04111 says "nothing was charged")',
    file: 'src/lib/paymentVerdict.ts',
    from: '    verdict.isE04111 === true &&\n    attemptReaderOutcome === OPERATOR_CANCEL_OUTCOME_KIND\n',
    to: '    verdict.isE04111 === true\n',
    suites: [SIM_SUITE, VERDICT_SUITE],
  },
  {
    id: 'D2b',
    what: 'the Check handler claims every attempt was an operator cancel',
    file: 'src/screens/PaymentScreen.tsx',
    from: '        unconfirmedMessageForVerdict(verdict, attemptReaderOutcome.current),',
    to: "        unconfirmedMessageForVerdict(verdict, 'user_cancelled'),",
    suites: [SIM_SUITE],
  },
  {
    id: 'D2c',
    what: "the reader's own result is never captured (the K026 positive control must go RED)",
    file: 'src/screens/PaymentScreen.tsx',
    from: '      attemptReaderOutcome.current = result.outcomeKind ?? null;',
    to: '      attemptReaderOutcome.current = null;',
    suites: [SIM_SUITE],
  },
  {
    id: 'D2d',
    what: 'the Check path is allowed to launch the reader (and so prepare-payment)',
    file: 'src/screens/PaymentScreen.tsx',
    from: '      const verdict = await verifyTerminalPayment(orderId, token);\n',
    to: '      await processPaymentIntent(amountDue ?? 0, orderId);\n      const verdict = await verifyTerminalPayment(orderId, token);\n',
    suites: [SIM_SUITE],
  },
  {
    id: 'D2e',
    what: 'an uncertain Check drops the Check button (any message counts as "never started")',
    file: 'src/screens/PaymentScreen.tsx',
    from: '  const neverStarted = error === UNCONFIRMED_NEVER_STARTED;\n',
    to: '  const neverStarted = error != null;\n',
    suites: [SIM_SUITE],
  },
  {
    id: 'D2f',
    what: '"take payment again" is offered on every unconfirmed state, not only after K026',
    file: 'src/screens/PaymentScreen.tsx',
    from: '  const retryAllowed = neverStarted;\n',
    to: '  const retryAllowed = true;\n',
    suites: [SIM_SUITE],
  },
  {
    id: 'D2g',
    what: 'a Check that confirms paid does not re-read the order',
    file: 'src/screens/PaymentScreen.tsx',
    from: "not the one from before the charge.\n        loadOrder();\n",
    to: "not the one from before the charge.\n        void 0;\n",
    suites: [SIM_SUITE],
  },
  {
    id: 'D3a',
    what: 'the synchronous in-flight guard on handleProcessPayment is removed',
    file: 'src/screens/PaymentScreen.tsx',
    from: '    if (cardPaymentInFlight.current) {\n',
    to: '    if (false && cardPaymentInFlight.current) {\n',
    suites: [SIM_SUITE],
  },
  {
    id: 'D3b',
    what: 'the in-flight guard is never released (a legitimate retry is silently refused)',
    file: 'src/screens/PaymentScreen.tsx',
    from: '    } finally {\n      cardPaymentInFlight.current = false;\n    }',
    to: '    } finally {\n      void 0;\n    }',
    suites: [SIM_SUITE],
  },
  {
    id: 'D1',
    what: "'attempt_released_order_kept' loses its mapping (falls to unknown)",
    file: 'src/lib/paymentReportOutcome.ts',
    from: "    case 'attempt_released_order_kept':\n",
    to: "    case 'attempt_released_order_kept_MUTATED':\n",
    suites: [OUTCOME_SUITE],
  },
];

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--silent', '--forceExit', ...suites], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = /Tests:\s+([^\n]+)/.exec(out);
  return {
    status: r.status,
    summary: tests ? tests[1].trim() : '(no Tests: line)',
    compileFault: /Test suite failed to run/.test(out),
  };
}

const only = process.argv[2];
const chosen = MUTATIONS.filter(m => !only || m.id === only);
if (chosen.length === 0) {
  console.error(`no mutation named ${only}`);
  process.exit(2);
}

let failures = 0;
for (const m of chosen) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.error(`${m.id}: expected exactly one match in ${m.file}, found ${hits}`);
    failures += 1;
    continue;
  }
  try {
    writeFileSync(path, original.replace(m.from, m.to));
    const onDisk = readFileSync(path, 'utf8');
    if (!onDisk.includes(m.to)) {
      throw new Error(`${m.id}: mutation did not land in ${m.file}`);
    }
    const at = onDisk.slice(0, onDisk.indexOf(m.to)).split('\n').length;
    console.log(`\n${m.id}: ${m.what}\n  ${m.file}:${at} now reads:\n    ${m.to.split('\n').join('\n    ')}`);
    const r = runJest(m.suites);
    const red = r.status !== 0 && !r.compileFault && /failed/.test(r.summary);
    console.log(
      `  -> ${red ? 'RED (caught)' : r.compileFault ? 'INSTRUMENT FAULT (compile)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`,
    );
    if (!red) failures += 1;
  } finally {
    writeFileSync(path, original);
  }
}

const allSuites = [...new Set(chosen.flatMap(m => m.suites))];
const control = runJest(allSuites);
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`);
if (control.status !== 0) failures += 1;

process.exit(failures === 0 ? 0 : 1);
