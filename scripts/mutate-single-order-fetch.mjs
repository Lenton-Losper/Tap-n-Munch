/**
 * MUTATION CHECK for GET /api/terminal/orders?orderId= (Payment screen performance, 2026-09-30).
 *
 * Each mutation reintroduces ONE way the single-order read could regress, prints the mutated lines
 * back from disk, runs the suite and requires it RED with a real test count (a compile/load fault
 * is an instrument fault, never a pass). The file is restored whatever happens, and the suite then
 * runs unmutated and must be GREEN.
 *
 * Matching is done on LF-normalised text and the file is written back with its own line endings,
 * so a CRLF checkout cannot make an anchor silently miss.
 *
 *   node scripts/mutate-single-order-fetch.mjs          # all mutations
 *   node scripts/mutate-single-order-fetch.mjs SO-W4    # one
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')
const ROUTE = 'app/api/terminal/orders/route.ts'
const SUITE = '__tests__/terminal-orders-single-order.test.ts'

const SINGLE_QUERY =
  "      const { data: row, error } = await supabase\n" +
  "        .from('orders')\n" +
  "        .select('*')\n" +
  "        .eq('restaurant_id', terminal.restaurantId)\n" +
  "        .eq('id', orderId)\n" +
  "        .in('status', LIVE_ORDER_STATUSES)\n" +
  '        .maybeSingle()\n'

const ALL_LIVE =
  'await fetchAllRows<Record<string, unknown>>(supabase.from(\'orders\').select(\'*\')' +
  ".eq('restaurant_id', terminal.restaurantId).in('status', LIVE_ORDER_STATUSES)" +
  ".order('placed_at', { ascending: false }), { label: 'mutant' })"

const MUTATIONS = [
  {
    id: 'SO-W1',
    what: 'the server ignores ?orderId (every request takes the list path)',
    from: "    if (url.searchParams.has('orderId')) {\n",
    to: "    if (false && url.searchParams.has('orderId')) {\n",
  },
  {
    id: 'SO-W2',
    what: 'the single-order path loads every live order and picks one out',
    from: SINGLE_QUERY,
    to:
      `      const everyLive = ${ALL_LIVE}\n` +
      '      const row = everyLive.find((o: any) => String(o.id) === orderId) ?? null\n' +
      '      const error = null as { message: string } | null\n',
  },
  {
    id: 'SO-W3',
    what: 'the single-order path computes projections/financials for every live order, then filters',
    from: '      const orders = await enrichOrders(supabase, terminal.restaurantId, [row as Record<string, unknown>])\n',
    to:
      `      const orders = (await enrichOrders(supabase, terminal.restaurantId, ${ALL_LIVE}))` +
      '.filter((o: any) => String(o.id) === orderId)\n',
  },
  {
    id: 'SO-W4',
    what: 'restaurant isolation is removed from the single-order query',
    from: "        .eq('restaurant_id', terminal.restaurantId)\n        .eq('id', orderId)\n",
    to: "        .eq('id', orderId)\n",
  },
  {
    id: 'SO-W5',
    what: 'not-found answers 404 instead of the empty envelope the terminal reads as "Order not found"',
    from: '      if (!row) return NextResponse.json({ orders: [] })\n',
    to: "      if (!row) return NextResponse.json({ error: 'Order not found' }, { status: 404 })\n",
  },
  {
    id: 'SO-W6',
    what: 'the live-status filter is dropped from the single-order query (a cancelled order is returned)',
    from: "        .eq('id', orderId)\n        .in('status', LIVE_ORDER_STATUSES)\n        .maybeSingle()\n",
    to: "        .eq('id', orderId)\n        .maybeSingle()\n",
  },
  {
    id: 'SO-W7',
    what: 'the orderId format check is removed',
    from: '      if (!UUID_RE.test(orderId)) {\n',
    to: '      if (false && !UUID_RE.test(orderId)) {\n',
  },
  {
    id: 'SO-W8',
    what: 'the restaurant-wide stale-order sweep runs on the single-order path',
    from: "    if (url.searchParams.has('orderId')) {\n",
    to:
      "    if (url.searchParams.has('orderId')) {\n" +
      '      await autoCancelStalePosOrders(supabase, { restaurantId: terminal.restaurantId, verifyWithFinatic: false })\n',
  },
  {
    id: 'SO-W9',
    what: 'the single-order branch is moved above the orders:read permission gate',
    from:
      "    if (!terminal.permissions.includes('orders:read')) {\n",
    to:
      "    if (new URL(req.url).searchParams.has('orderId') && !terminal.permissions.includes('orders:read')) {\n" +
      '      const { data: r } = await supabase.from(\'orders\').select(\'*\').eq(\'id\', String(new URL(req.url).searchParams.get(\'orderId\'))).maybeSingle()\n' +
      '      return NextResponse.json({ orders: r ? [r] : [] })\n' +
      '    }\n' +
      "    if (!terminal.permissions.includes('orders:read')) {\n",
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

const path = join(ROOT, ROUTE)
const original = readFileSync(path, 'utf8')
const crlf = original.includes('\r\n')
const lf = crlf ? original.replace(/\r\n/g, '\n') : original
const toDisk = (text) => (crlf ? text.replace(/\n/g, '\r\n') : text)

let failures = 0
try {
  for (const m of chosen) {
    const hits = lf.split(m.from).length - 1
    if (hits !== 1) {
      console.error(`${m.id}: expected exactly one match in ${ROUTE}, found ${hits}`)
      failures += 1
      continue
    }
    const mutated = lf.replace(m.from, m.to)
    writeFileSync(path, toDisk(mutated))
    const onDisk = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    if (!onDisk.includes(m.to)) throw new Error(`${m.id}: mutation did not land in ${ROUTE}`)
    const at = onDisk.slice(0, onDisk.indexOf(m.to)).split('\n').length
    console.log(`\n${m.id}: ${m.what}\n  ${ROUTE}:${at} now reads:\n    ${m.to.trimEnd().split('\n').join('\n    ')}`)
    const r = runJest([SUITE])
    const red = r.status !== 0 && !r.compileFault && /failed/.test(r.summary)
    console.log(
      `  -> ${red ? 'RED (caught)' : r.compileFault ? 'INSTRUMENT FAULT (compile)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`,
    )
    if (r.firstRed) console.log(`     first RED: ${r.firstRed}`)
    if (!red) failures += 1
    writeFileSync(path, original)
  }
} finally {
  writeFileSync(path, original)
}

if (readFileSync(path, 'utf8') !== original) {
  console.error('RESTORE FAILED: route.ts differs from its pre-mutation content')
  process.exit(3)
}

const control = runJest([SUITE, '__tests__/terminal-orders-list-financials.test.ts'])
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`)
if (control.status !== 0) failures += 1

process.exit(failures === 0 ? 0 : 1)
