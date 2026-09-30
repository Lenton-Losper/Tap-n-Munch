/**
 * MUTATION CHECK for the RC sprint's terminal fixes and failure-mode coverage (2026-09-30).
 *
 *   A4   Send / Charge reach the server once per press batch (synchronous in-flight refs).
 *   A5   the round's order note and the POS cart are frozen while their request is out.
 *   B    a cancellation is never shown as done without the server's word (5xx is not "nothing changed").
 *   I1   one wrong PIN is one /authorize POST and one lockout strike.
 *   E    an uncertain card payment survives Back, reopen, a restart and another order, and keeps
 *        Process Payment blocked until the server has answered.
 *
 * Same engine as scripts/mutate-d2d3.js: each mutation breaks ONE guard, prints the mutated line
 * back from disk, runs the suites that must catch it and requires them RED with a real test count
 * (a compile fault is an instrument fault, never a pass); the file is restored whatever happens;
 * finally the suites run unmutated and must be GREEN.
 *
 *   node scripts/mutate-rc-terminal.js          # all mutations
 *   node scripts/mutate-rc-terminal.js RC-E6    # one
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const ROUND_SUITE = 'src/screens/__tests__/rcRoundSendWire.test.tsx';
const POS_SUITE = 'src/screens/__tests__/rcPosChargeWire.test.tsx';
const CANCEL_SUITE = 'src/components/__tests__/rcCancelAuthWire.test.tsx';
const PAY_SUITE = 'src/screens/__tests__/rcPaymentRecovery.test.tsx';

const MUTATIONS = [
  {
    id: 'RC-A4',
    what: 'the synchronous Send guard is removed (state-only guard, as before)',
    file: 'src/screens/ServiceRoundReviewScreen.tsx',
    from: '    if (!table || sendInFlightRef.current) {\n',
    to: '    if (!table || (false && sendInFlightRef.current)) {\n',
    suites: [ROUND_SUITE],
  },
  {
    id: 'RC-A4b',
    what: 'the Send guard is never released (a Retry after an unknown outcome is silently refused)',
    file: 'src/screens/ServiceRoundReviewScreen.tsx',
    from: '    } finally {\n      sendInFlightRef.current = false;\n',
    to: '    } finally {\n      void 0;\n',
    suites: [ROUND_SUITE],
  },
  {
    id: 'RC-A4-POS',
    what: 'the synchronous Charge guard on the POS cart is removed',
    file: 'src/screens/POSCartScreen.tsx',
    from: '    if (cart.length === 0 || chargeInFlight.current) {\n',
    to: '    if (cart.length === 0 || (false && chargeInFlight.current)) {\n',
    suites: [POS_SUITE],
  },
  {
    id: 'RC-A5',
    what: 'the order note stays editable while the round is being sent',
    file: 'src/screens/ServiceRoundReviewScreen.tsx',
    from: '          editable={!locked && !sending}\n',
    to: '          editable={!locked}\n',
    suites: [ROUND_SUITE],
  },
  {
    id: 'RC-B4',
    what: 'a 5xx / unreadable failure on the amend call is shown as a definite "nothing changed"',
    file: 'src/components/AmendLineSheet.tsx',
    from: '          setVerdict(unknownVerdict(voiding));\n',
    to: '          setFailure(Copy.AMEND_FAILED_NOTHING_CHANGED);\n',
    suites: [CANCEL_SUITE],
  },
  {
    id: 'RC-B5',
    what: 'a 200 that does not name the line in `applied` is read as removed',
    file: 'src/lib/amendTabLines.ts',
    from: "  return {kind: 'not_confirmed', lineId, why: 'absent'};\n",
    to: "  return {kind: 'confirmed', lineId, effect: 'removed', quantity: 0, previousQuantity: request.previousQuantity};\n",
    suites: [CANCEL_SUITE],
  },
  {
    id: 'RC-I1',
    what: 'a 401 PIN_MISMATCH is treated as an expired session: refreshed and re-POSTed (two strikes)',
    file: 'src/lib/api.ts',
    from: "  if (err && err.status === 401 && err.code !== 'PIN_MISMATCH') {\n    const newToken",
    to: '  if (err && err.status === 401) {\n    const newToken',
    suites: [CANCEL_SUITE],
  },
  {
    id: 'RC-E6',
    what: 'Back resets an uncertain payment again (the record is wiped on leave)',
    file: 'src/screens/PaymentScreen.tsx',
    from: '      if (holdsRecoveryState(machineStateRef.current)) {\n        return;\n      }\n      reset();\n',
    to: '      reset();\n',
    suites: [PAY_SUITE],
  },
  {
    id: 'RC-E4b',
    what: 'one slot for the whole device again (per-order keys removed)',
    file: 'src/components/PaymentStateMachine.tsx',
    from: '  return orderId ? `${PAYMENT_STATE_STORAGE_KEY}:${orderId}` : PAYMENT_STATE_STORAGE_KEY;\n',
    to: '  return PAYMENT_STATE_STORAGE_KEY;\n',
    suites: [PAY_SUITE],
  },
  {
    id: 'RC-E4',
    what: 'the payment state machine persists nothing (crash recovery gone)',
    file: 'src/components/PaymentStateMachine.tsx',
    from: '      persistPaymentState(latest.current, currentOrderId);\n',
    to: '      void persistPaymentState;\n',
    suites: [PAY_SUITE],
  },
  {
    id: 'RC-E2',
    what: 'Process Payment is live again while the payment is UNCONFIRMED',
    file: 'src/screens/PaymentScreen.tsx',
    from: "    state === 'PAYMENT_IN_PROGRESS' ||\n    state === 'PAYMENT_UNCONFIRMED' ||\n",
    to: "    state === 'PAYMENT_IN_PROGRESS' ||\n",
    suites: [PAY_SUITE],
  },
];

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--forceExit', '--maxWorkers=2', ...suites], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = /Tests:\s+([^\n]+)/.exec(out);
  const firstRed = /●\s+([^\n]+›[^\n]+)/.exec(out);
  return {
    status: r.status,
    summary: tests ? tests[1].trim() : '(no Tests: line)',
    firstRed: firstRed ? firstRed[1].trim() : null,
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
    if (r.firstRed) {
      console.log(`     first RED: ${r.firstRed}`);
    }
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
