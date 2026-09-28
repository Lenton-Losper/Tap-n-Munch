/**
 * MUTATION CHECK for F-TERMPAY (Sprint 2026-09-29): typed prepare-payment refusals (task 3) and the
 * order list card's live money (task 8).
 *
 * Each mutation breaks ONE guard on ONE line, prints the line it changed from disk (so a mutation
 * that landed on a comment is visible), runs the suites that are supposed to catch it, and requires
 * them to FAIL with a real test count. The file is restored afterwards whatever happens. Finally the
 * suites are run once unmutated and must PASS.
 *
 *   node scripts/mutate-f-termpay.js        # all mutations
 *   node scripts/mutate-f-termpay.js T1     # one
 *
 * Plain CommonJS with no "is this the main module" guard, as scripts/mutate-live-totals.js explains.
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const LIB_SUITE = 'src/lib/__tests__/prepareRefusalSettlementSet.test.ts';
const TABLE_SUITE = 'src/screens/__tests__/settleRefusedSetNotClaimable.test.tsx';
const PAYMENT_SUITE = 'src/screens/__tests__/paymentScreenPrepareRefusal.test.tsx';
const CARD_SUITE = 'src/components/__tests__/orderCardLiveTotal.test.tsx';

const MUTATIONS = [
  {
    id: 'T1',
    what: 'processPaymentIntent ignores the typed refusal (SETTLEMENT_SET_NOT_CLAIMABLE -> ambiguous -> verify + FAILED report)',
    file: 'src/lib/payment.ts',
    from: '    const prepareRefusal = readerLaunched ? null : prepareRefusalFromError(error);',
    to: '    const prepareRefusal = readerLaunched || true ? null : prepareRefusalFromError(error);',
    suites: [LIB_SUITE],
  },
  {
    id: 'T2',
    what: 'a refusal-shaped code is believed even after the reader has opened',
    file: 'src/lib/payment.ts',
    from: '    const prepareRefusal = readerLaunched ? null : prepareRefusalFromError(error);',
    to: '    const prepareRefusal = prepareRefusalFromError(error);',
    suites: [LIB_SUITE],
  },
  {
    id: 'T3',
    what: "api.ts drops the server's per-order reasons",
    file: 'src/lib/api.ts',
    from: "      data.code === 'SETTLEMENT_SET_NOT_CLAIMABLE' ? parseNotClaimable(data) : [],",
    to: "      data.code === 'MUTATED_NEVER' ? parseNotClaimable(data) : [],",
    suites: [LIB_SUITE],
  },
  {
    id: 'T4',
    what: 'the tab settle screen treats a typed refusal as an ordinary failure (verify, report, generic error)',
    file: 'src/screens/TableDetailScreen.tsx',
    from: '      if (paymentResult.prepareRefusal) {',
    to: '      if (false && paymentResult.prepareRefusal) {',
    suites: [TABLE_SUITE],
  },
  {
    id: 'T5',
    what: 'the refused orders stay selected (a second tap resends the refused set)',
    file: 'src/screens/TableDetailScreen.tsx',
    from: '        setSelectedIds(prev => new Set([...prev].filter(id => !refused.includes(id))));',
    to: '        setSelectedIds(prev => new Set([...prev].filter(id => !refused.includes(id) || true)));',
    suites: [TABLE_SUITE],
  },
  {
    id: 'T6',
    what: 'the Charge screen treats a typed refusal as an ordinary failure',
    file: 'src/screens/PaymentScreen.tsx',
    from: '      if (result.prepareRefusal) {',
    to: '      if (false && result.prepareRefusal) {',
    suites: [PAYMENT_SUITE],
  },
  {
    id: 'T7',
    what: '/settle NOTHING_LEFT_TO_CHARGE after a card charge shows the generic error',
    file: 'src/screens/TableDetailScreen.tsx',
    from: "        err.code === 'NOTHING_LEFT_TO_CHARGE'\n      ) {\n        Alert.alert(SETTLE_NOTHING_LEFT_AFTER_CARD_TITLE",
    to: "        err.code === 'MUTATED_NEVER'\n      ) {\n        Alert.alert(SETTLE_NOTHING_LEFT_AFTER_CARD_TITLE",
    suites: [TABLE_SUITE],
  },
  {
    id: 'T8',
    what: 'the order card shows the stored orders.total for an amended order',
    file: 'src/components/OrderCard.tsx',
    from: '        {formatCurrency(f.live_cents / 100)}\n      </Text>',
    to: '        {formatCurrency(order.total)}\n      </Text>',
    suites: [CARD_SUITE],
  },
  {
    id: 'T9',
    what: "the mapper drops the server's financials (every card falls back to 'Ordered')",
    file: 'src/lib/orderMapper.ts',
    from: '    financials: parseMoneyCents(row.financials) ?? undefined,',
    to: '    financials: undefined && parseMoneyCents(row.financials),',
    suites: [CARD_SUITE],
  },
  // ---- Sprint 2026-09-29 follow-up (f-race contract) ----
  {
    id: 'T10',
    what: 'ORDER_CHANGED_DURING_PREPARE is not a typed refusal (falls to ambiguous: verify + FAILED report)',
    file: 'src/lib/settlementRefusal.ts',
    from: "  'ORDER_CHANGED_DURING_PREPARE',\n] as const;",
    to: '] as const;',
    suites: [LIB_SUITE],
  },
  {
    id: 'T11',
    what: 'ORDER_CHANGED_DURING_PAYMENT (card charged, order held) is treated as a failure',
    file: 'src/screens/PaymentScreen.tsx',
    from: "        if (code === 'ORDER_CHANGED_DURING_PAYMENT') {",
    to: "        if (code === 'MUTATED_NEVER') {",
    suites: [PAYMENT_SUITE],
  },
  {
    id: 'T12',
    what: 'the held payment screen hides the transaction reference',
    file: 'src/screens/PaymentScreen.tsx',
    from: "          setHeldForReview({reference: opts.voucherNo || opts.reference});",
    to: "          setHeldForReview({reference: ''});",
    suites: [PAYMENT_SUITE],
  },
  {
    id: 'T13',
    what: 'the amend refusal payment_in_flight loses its specific message (falls to "we do not know why")',
    file: 'src/constants/amendCopy.ts',
    from: '  payment_in_flight:\n',
    to: '  payment_in_flight_MUTATED:\n',
    suites: ['src/components/__tests__/amendSheetOutcomes.test.tsx'],
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
