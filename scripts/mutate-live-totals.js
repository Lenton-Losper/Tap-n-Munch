/**
 * MUTATION CHECK for the sprint 2026-09-28 live-totals guards.
 *
 * Each mutation breaks ONE guard on ONE line, prints the line it changed (so a mutation that
 * landed on a comment is visible), runs the suites that are supposed to catch it, and requires
 * them to FAIL. The file is restored afterwards whatever happens. Finally the suites are run once
 * unmutated and must PASS -- the positive control that the reds were caused by the mutation.
 *
 *   node scripts/mutate-live-totals.js            # all mutations
 *   node scripts/mutate-live-totals.js M2         # one
 *
 * Plain CommonJS on purpose, with no "is this the main module" guard: that guard's file:// URL
 * comparison never matches on Windows and a script built on it runs nothing and exits 0.
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const LIB_SUITE = 'src/lib/__tests__/liveTotalsAfterVoids.test.ts';
const SCREEN_SUITE = 'src/screens/__tests__/tableDetailLiveTotals.test.tsx';
const PAYMENT_SUITE = 'src/screens/__tests__/paymentScreenLiveAmount.test.tsx';

const MUTATIONS = [
  {
    id: 'M1',
    what: 'a fully voided order falls back to its full original total',
    file: 'src/lib/settlementAmount.ts',
    from: '  const liveCents = cancelled ? 0 : Math.max(0, originalCents - voidedCents);',
    to: '  const liveCents = cancelled ? 0 : voidedCents >= originalCents ? originalCents : Math.max(0, originalCents - voidedCents);',
    suites: [LIB_SUITE],
  },
  {
    id: 'M1b',
    what: 'voided lines are not subtracted at all (orders.total is charged)',
    file: 'src/lib/settlementAmount.ts',
    from: '      voidedCents += Math.round(cents);',
    to: '      voidedCents += 0 * Math.round(cents);',
    suites: [LIB_SUITE, SCREEN_SUITE, PAYMENT_SUITE],
  },
  {
    id: 'M2',
    what: "the server's financials are ignored in favour of order.total / lines",
    file: 'src/lib/settlementAmount.ts',
    from: '  if (basis.financials) {',
    to: '  if (false && basis.financials) {',
    suites: [LIB_SUITE],
  },
  {
    id: 'M3',
    what: 'no lines payload at all falls back to the order total (the pre-sprint rule)',
    file: 'src/lib/settlementAmount.ts',
    from: '  if (!order || !basis) {\n    return null;\n  }',
    to: '  if (!order) {\n    return null;\n  }\n  if (!basis) {\n    return orderMoneyWithoutTab(order);\n  }',
    suites: [LIB_SUITE, SCREEN_SUITE, 'src/lib/__tests__/settleAmountIsOutstanding.test.ts'],
  },
  {
    id: 'M4',
    what: 'a tab-lines read failure on the Charge screen falls back to the stored total',
    file: 'src/lib/orderLiveMoney.ts',
    from: '  } catch {\n    return {kind: \'unavailable\'};\n  }',
    to: '  } catch {\n    const fallback = orderMoneyWithoutTab(order);\n    return fallback ? {kind: \'known\', money: fallback} : {kind: \'unavailable\'};\n  }',
    suites: [LIB_SUITE, PAYMENT_SUITE],
  },
  {
    id: 'M5',
    what: 'the Charge screen charges the stored orders.total instead of the live amount',
    file: 'src/screens/PaymentScreen.tsx',
    from: '    const total = amountDue;\n    startPayment(orderId, total);',
    to: '    const total = storedTotal;\n    startPayment(orderId, total);',
    suites: [PAYMENT_SUITE],
  },
];

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--silent', ...suites], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = /Tests:\s+([^\n]+)/.exec(out);
  return {status: r.status, summary: tests ? tests[1].trim() : '(no Tests: line)'};
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
  const mutated = original.replace(m.from, m.to);
  try {
    writeFileSync(path, mutated);
    // Read back FROM DISK, so what is printed is what jest will load.
    const onDisk = readFileSync(path, 'utf8');
    if (!onDisk.includes(m.to)) {
      throw new Error(`${m.id}: mutation did not land in ${m.file}`);
    }
    const at = onDisk.slice(0, onDisk.indexOf(m.to)).split('\n').length;
    console.log(`\n${m.id}: ${m.what}\n  ${m.file}:${at} now reads:\n    ${m.to.split('\n').join('\n    ')}`);
    const r = runJest(m.suites);
    const red = r.status !== 0 && !/^0 total/.test(r.summary);
    console.log(`  -> ${red ? 'RED (caught)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`);
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
