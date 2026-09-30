/**
 * MUTATION CHECK for the single-order fetch (Payment screen performance, 2026-09-30).
 *
 *   SO-T1  getOrder stops sending ?orderId (the request is the bare list again)
 *   SO-T2  getOrder calls getOrders() and filters on the device again (the original defect)
 *   SO-T3  getOrder takes the first row instead of matching by id (wrong order from an older worker)
 *   SO-T4  the id is not URL-encoded (a hostile id becomes extra parameters)
 *   SO-T5  mapRowToOrder drops tab_id again (the Payment screen shows the stored original for a
 *          tab order, and cash is gated on it) -- the 2.40/2.41 defect
 *
 * Same engine as scripts/mutate-rc-terminal.js: each mutation breaks ONE guard, prints the mutated
 * line back from disk, runs the suites that must catch it and requires them RED with a real test
 * count (a compile fault is an instrument fault, never a pass); the file is restored whatever
 * happens; finally the suites run unmutated and must be GREEN.
 *
 *   node scripts/mutate-single-order-fetch.js          # all mutations
 *   node scripts/mutate-single-order-fetch.js SO-T2    # one
 */
const {readFileSync, writeFileSync} = require('fs');
const {spawnSync} = require('child_process');
const {join} = require('path');

const ROOT = join(__dirname, '..');
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

const API_SUITE = 'src/lib/__tests__/getOrderSingleOrder.test.ts';
const SCREEN_SUITE = 'src/screens/__tests__/paymentScreenSingleOrderFetch.test.tsx';
const MAPPER_SUITE = 'src/lib/__tests__/orderMapperTabId.test.ts';

const URL_LINE =
  '    `${FLASHTAP_API_URL}/api/terminal/orders?orderId=${encodeURIComponent(orderId)}`,\n';

const MUTATIONS = [
  {
    id: 'SO-T1',
    what: 'getOrder no longer sends ?orderId',
    file: 'src/lib/api.ts',
    from: URL_LINE,
    to: '    `${FLASHTAP_API_URL}/api/terminal/orders`,\n',
    suites: [API_SUITE, SCREEN_SUITE],
  },
  {
    id: 'SO-T2',
    what: 'getOrder goes back to getOrders() + Array.find (the whole list, filtered on the device)',
    file: 'src/lib/api.ts',
    from: '): Promise<Order> {\n  const response = await terminalFetch(\n' + URL_LINE,
    to:
      '): Promise<Order> {\n' +
      "  { const all = await getOrders(token); const hit = all.find(o => o.id === orderId); if (!hit) { throw new Error('Order not found'); } return hit; }\n" +
      '  const response = await terminalFetch(\n' +
      URL_LINE,
    suites: [API_SUITE, SCREEN_SUITE],
  },
  {
    id: 'SO-T3',
    what: 'getOrder takes the first row of the answer instead of the requested id',
    file: 'src/lib/api.ts',
    from: "  const row = (data.orders ?? []).find(\n    r => String(r.id ?? r.order_id ?? '') === orderId,\n  );\n",
    to: '  const row = (data.orders ?? [])[0];\n',
    suites: [API_SUITE],
  },
  {
    id: 'SO-T4',
    what: 'the order id is interpolated without URL-encoding',
    file: 'src/lib/api.ts',
    from: 'orders?orderId=${encodeURIComponent(orderId)}`',
    to: 'orders?orderId=${orderId}`',
    suites: [API_SUITE],
  },
  {
    id: 'SO-T5',
    what: 'mapRowToOrder no longer copies tab_id (back to the 2.40/2.41 mapper)',
    file: 'src/lib/orderMapper.ts',
    from: '    tab_id: row.tab_id == null ? (row.tab_id as null | undefined) : String(row.tab_id),\n',
    // A marker, not '': an empty replacement would make the "did it land" check trivially true.
    to: '    // SO-T5: tab_id not mapped\n',
    suites: [SCREEN_SUITE, MAPPER_SUITE],
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
