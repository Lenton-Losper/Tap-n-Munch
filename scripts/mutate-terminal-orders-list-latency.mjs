/**
 * MUTATION CHECK for GET /api/terminal/orders (list) latency work, perf/latency-sprint 2026-10-01.
 *
 * Each mutation reintroduces ONE way the list could regress -- back to one-round-trip-after-another,
 * per-order reads, a page-skipping sweep, lost isolation or lost validation -- prints the mutated
 * lines back from disk, runs the suites and requires them RED with a real test count (a
 * compile/load fault is an instrument fault, never a pass). Every file is restored whatever
 * happens, and the suites then run unmutated and must be GREEN.
 *
 * Matching is done on LF-normalised text and each file is written back with its own line endings,
 * so a CRLF checkout cannot make an anchor silently miss.
 *
 *   node scripts/mutate-terminal-orders-list-latency.mjs          # all mutations
 *   node scripts/mutate-terminal-orders-list-latency.mjs LL-3     # one
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')
const ROUTE = 'app/api/terminal/orders/route.ts'
const PROJECTION = 'lib/payments/get-payment-projection.ts'
const PAGING = 'lib/supabase/fetch-all-rows.ts'
const LATENCY = '__tests__/terminal-orders-list-latency.test.ts'
const PAGING_SUITE = '__tests__/fetch-all-rows-concurrent.test.ts'
const SUITES = [LATENCY, PAGING_SUITE]

const MUTATIONS = [
  {
    id: 'LL-1',
    file: ROUTE,
    what: 'financials batches go back to one at a time',
    from: '    FINANCIALS_FANOUT,\n  )\n',
    to: '    1,\n  )\n',
  },
  {
    id: 'LL-2',
    file: ROUTE,
    what: 'payment-projection chunks go back to one at a time on the list path',
    from: '    getPaymentProjections(supabase, restaurantId, orderIds, { concurrency: PROJECTION_FANOUT }),\n',
    to: '    getPaymentProjections(supabase, restaurantId, orderIds),\n',
  },
  {
    id: 'LL-2b',
    file: PROJECTION,
    what: 'getPaymentProjections ignores the concurrency it is given (sale chunks)',
    from: "    if (saleError) throw saleError\n    return (data ?? []) as SaleEventRow[]\n  }, concurrency)\n",
    to: "    if (saleError) throw saleError\n    return (data ?? []) as SaleEventRow[]\n  }, 1)\n",
  },
  {
    id: 'LL-3',
    file: ROUTE,
    what: 'projections and financials run one after the other again',
    from:
      '  const [projections, financials] = await Promise.all([\n' +
      '    getPaymentProjections(supabase, restaurantId, orderIds, { concurrency: PROJECTION_FANOUT }),\n' +
      '    financialsByOrder(supabase, data),\n' +
      '  ])\n',
    to:
      '  const projections = await getPaymentProjections(supabase, restaurantId, orderIds, { concurrency: PROJECTION_FANOUT })\n' +
      '  const financials = await financialsByOrder(supabase, data)\n',
  },
  {
    id: 'LL-4',
    file: ROUTE,
    what: 'N+1: financials are projected one order per batch',
    from: '  for (let i = 0; i < rows.length; i += FINANCIALS_BATCH) starts.push(i)\n',
    to: '  for (let i = 0; i < rows.length; i += 1) starts.push(i)\n',
    also: {
      from: '      const batch = rows.slice(i, i + FINANCIALS_BATCH) as unknown as FinancialOrderInput[]\n',
      to: '      const batch = rows.slice(i, i + 1) as unknown as FinancialOrderInput[]\n',
    },
  },
  {
    id: 'LL-5',
    file: PAGING,
    what: 'concurrent pages share ONE builder (postgrest-js .range() mutates it: duplicate pages)',
    from: "    const { data, error } = await build().range(offset, offset + pageSize - 1)\n",
    to: "    const { data, error } = await (shared ??= build()).range(offset, offset + pageSize - 1)\n",
    also: {
      from: '  const readPage = async (offset: number): Promise<Row[]> => {\n',
      to: '  let shared: RangeableQuery<Row> | undefined\n  const readPage = async (offset: number): Promise<Row[]> => {\n',
    },
  },
  {
    id: 'LL-6',
    file: ROUTE,
    what: 'the stale-order sweep runs alongside the list read instead of before it',
    from: "    await autoCancelStalePosOrders(supabase, { restaurantId: terminal.restaurantId, verifyWithFinatic: false })\n",
    to: "    void autoCancelStalePosOrders(supabase, { restaurantId: terminal.restaurantId, verifyWithFinatic: false })\n",
  },
  {
    id: 'LL-7',
    file: ROUTE,
    what: 'restaurant isolation is removed from the completed-history query',
    from: "          .eq('restaurant_id', terminal.restaurantId)\n          .eq('status', 'completed')\n",
    to: "          .eq('status', 'completed')\n",
  },
  {
    id: 'LL-8',
    file: ROUTE,
    what: 'the cursor tie-break query is dropped (rows sharing a placed_at are skipped)',
    from: "        cursor\n          ? base().eq('placed_at', cursor.placedAt)",
    to: "        false\n          ? base().eq('placed_at', cursor!.placedAt)",
  },
  {
    id: 'LL-9',
    file: ROUTE,
    what: 'the limit cap is removed',
    from: '      if (!Number.isInteger(limit) || limit < 1 || limit > COMPLETED_PAGE_MAX) {\n',
    to: '      if (!Number.isInteger(limit) || limit < 1) {\n',
  },
  {
    id: 'LL-10',
    file: ROUTE,
    what: 'the cursor is accepted without validation',
    from: "      const cursor = rawCursor === null ? null : parseCursor(rawCursor)\n",
    to:
      "      const cursor = rawCursor === null ? null : (parseCursor(rawCursor) ?? " +
      "{ placedAt: rawCursor.split('~')[0], id: rawCursor.split('~')[1] ?? '' })\n",
  },
  {
    id: 'LL-11',
    file: ROUTE,
    what: 'scope=active returns every live order (completed included)',
    from: "    const statuses = scope === 'active' ? ACTIVE_ORDER_STATUSES : LIVE_ORDER_STATUSES\n",
    to: '    const statuses = LIVE_ORDER_STATUSES\n',
  },
]

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--forceExit', '--maxWorkers=2', ...suites], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const out = `${r.stdout}\n${r.stderr}`
  const tests = /Tests:\s+([^\n]+)/.exec(out)
  const firstRed = /●\s+([^\n]+›[^\n]+)/.exec(out)
  return {
    status: r.status,
    summary: tests ? tests[1].trim() : '(no Tests: line)',
    firstRed: firstRed ? firstRed[1].trim() : null,
    compileFault: /Test suite failed to run/.test(out),
  }
}

const only = process.argv[2]
const chosen = MUTATIONS.filter((m) => !only || m.id === only)
if (chosen.length === 0) {
  console.error(`no mutation named ${only}`)
  process.exit(2)
}

/**
 * ONE SOURCE-REWRITING RUN AT A TIME. Two runs (this one, or compare-terminal-orders-list.mjs) each
 * capture the other's MUTANT as their "original" and restore it: on 2026-10-01 that left the N+1
 * mutant (LL-4) on disk after a "completed" run. The lock is exclusive-create; a stale one from a
 * killed run must be deleted by hand, deliberately.
 */
const LOCK = join(ROOT, '.source-mutation.lock')
try {
  writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
} catch {
  console.error(`refusing: ${LOCK} exists -- another mutation/compare run is rewriting sources`)
  process.exit(4)
}
process.on('exit', () => {
  try {
    rmSync(LOCK)
  } catch {}
})

const files = [...new Set(MUTATIONS.map((m) => m.file))]
const originals = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const restoreAll = () => {
  for (const [f, text] of originals) writeFileSync(join(ROOT, f), text)
}

let failures = 0
try {
  for (const m of chosen) {
    const original = originals.get(m.file)
    const crlf = original.includes('\r\n')
    let lf = crlf ? original.replace(/\r\n/g, '\n') : original
    const edits = [m, ...(m.also ? [m.also] : [])]
    let ok = true
    for (const e of edits) {
      const hits = lf.split(e.from).length - 1
      if (hits !== 1) {
        console.error(`${m.id}: expected exactly one match in ${m.file}, found ${hits}: ${JSON.stringify(e.from.slice(0, 80))}`)
        ok = false
        break
      }
      lf = lf.replace(e.from, e.to)
    }
    if (!ok) {
      failures += 1
      continue
    }
    writeFileSync(join(ROOT, m.file), crlf ? lf.replace(/\n/g, '\r\n') : lf)
    const onDisk = readFileSync(join(ROOT, m.file), 'utf8').replace(/\r\n/g, '\n')
    for (const e of edits) {
      if (!onDisk.includes(e.to)) throw new Error(`${m.id}: mutation did not land in ${m.file}`)
    }
    const at = onDisk.slice(0, onDisk.indexOf(m.to)).split('\n').length
    console.log(`\n${m.id}: ${m.what}\n  ${m.file}:${at} now reads:\n    ${m.to.trimEnd().split('\n').join('\n    ')}`)
    const r = runJest(SUITES)
    const red = r.status !== 0 && !r.compileFault && /failed/.test(r.summary)
    console.log(
      `  -> ${red ? 'RED (caught)' : r.compileFault ? 'INSTRUMENT FAULT (compile)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`,
    )
    if (r.firstRed) console.log(`     first RED: ${r.firstRed}`)
    if (!red) failures += 1
    restoreAll()
  }
} finally {
  restoreAll()
}

for (const [f, text] of originals) {
  if (readFileSync(join(ROOT, f), 'utf8') !== text) {
    console.error(`RESTORE FAILED: ${f} differs from its pre-mutation content`)
    process.exit(3)
  }
}

const control = runJest([...SUITES, '__tests__/terminal-orders-list-financials.test.ts', '__tests__/terminal-orders-single-order.test.ts'])
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`)
if (control.status !== 0) failures += 1

process.exit(failures === 0 ? 0 : 1)
