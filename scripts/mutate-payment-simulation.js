/**
 * MUTATION CHECK for src/screens/__tests__/paymentSimulation.test.tsx (paysim, 2026-09-29).
 *
 * Each mutation breaks ONE line of the device card path, prints the line it changed (so a mutation
 * that landed on a comment is visible), runs the simulation suite, and requires it to FAIL. The
 * file is restored afterwards whatever happens. Finally the suite runs unmutated and must PASS --
 * the positive control that the reds were caused by the mutation.
 *
 *   node scripts/mutate-payment-simulation.js        # all mutations
 *   node scripts/mutate-payment-simulation.js PS-T2  # one
 *
 * Plain CommonJS with no main-module guard, like mutate-live-totals.js (that guard's file:// URL
 * comparison never matches on Windows and a script built on it runs nothing and exits 0).
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const SUITE = 'src/screens/__tests__/paymentSimulation.test.tsx';

const MUTATIONS = [
  {
    id: 'PS-T1',
    what: 'the reader is asked for the caller amount, not the server chargeCents',
    file: 'src/lib/payment.ts',
    from: '    const amountInCents = String(Math.round(chargeAmount * 100));',
    to: '    const amountInCents = String(Math.round(amount * 100) + 1);',
  },
  {
    id: 'PS-T2',
    what: 'an unknown reader code (9027) is treated as a confirmed decline',
    file: 'src/lib/payment.ts',
    from: "export const CONFIRMED_DECLINE_CODES: readonly string[] = ['PAYMENT_DECLINED'];",
    to: "export const CONFIRMED_DECLINE_CODES: readonly string[] = ['PAYMENT_DECLINED', 'PAYMENT_AMBIGUOUS'];",
  },
  {
    id: 'PS-T3',
    what: '"Check payment status" never resolves to success when the server says paid',
    file: 'src/screens/PaymentScreen.tsx',
    from: '      if (verdict.paid) {',
    to: '      if (false && verdict.paid) {',
  },
];

function runJest() {
  const r = spawnSync(process.execPath, [JEST, '--silent', '--forceExit', SUITE], {cwd: ROOT, encoding: 'utf8'});
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = /Tests:\s+([^\n]+)/.exec(out);
  const firstRed = /✕ ([^\n]+)|× ([^\n]+)/.exec(out);
  return {status: r.status, summary: tests ? tests[1].trim() : '(no Tests: line)', firstRed: firstRed ? (firstRed[1] || firstRed[2]).trim() : ''};
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
    if (!onDisk.includes(m.to)) throw new Error(`${m.id}: mutation did not land in ${m.file}`);
    const at = onDisk.slice(0, onDisk.indexOf(m.to)).split('\n').length;
    console.log(`\n${m.id}: ${m.what}\n  ${m.file}:${at} now reads:\n    ${m.to}`);
    const r = runJest();
    const red = r.status !== 0 && !/^0 total/.test(r.summary);
    console.log(`  -> ${red ? 'RED (caught)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}${r.firstRed ? `  first red: ${r.firstRed}` : ''}`);
    if (!red) failures += 1;
  } finally {
    writeFileSync(path, original);
  }
}

const control = runJest();
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`);
if (control.status !== 0) failures += 1;
process.exit(failures === 0 ? 0 : 1);
