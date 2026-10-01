/**
 * MUTATION CHECK for the payment-success path's round-trip changes (perf/latency-sprint 2026-10-01,
 * Phase 4): issueReceiptForOrder, markOrderPaidConfirmed, clearReadyToPayAndReopenTab and the
 * terminal payment route.
 *
 * Each mutation reintroduces ONE way the change could be wrong -- serial again, a duplicate read
 * back, or concurrent with a DIFFERENT outcome than one-at-a-time -- prints the mutated lines back
 * from disk, runs the suites and requires them RED with a real test count (a compile/load fault is
 * an instrument fault, never a pass). Every file is restored whatever happens; the suites then run
 * unmutated and must be GREEN. Shares .source-mutation.lock with the other source-rewriting scripts.
 *
 *   node scripts/mutate-payment-path-latency.mjs          # all
 *   node scripts/mutate-payment-path-latency.mjs RC-3     # one
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
const RECEIPT = 'lib/receipts/issueReceipt.ts'
const MARK = 'lib/payments/mark-order-paid-confirmed.ts'
const TABSTATE = 'lib/tabs/settle-tab-state.ts'
const ROUTE = 'app/api/terminal/orders/[orderId]/payment/route.ts'
const PREPARE = 'app/api/terminal/orders/[orderId]/prepare-payment/route.ts'
const MERCHANT = 'lib/payments/terminal-merchant-order.ts'
const SUITES = [
  '__tests__/receipt-issuance-latency.test.ts',
  '__tests__/terminal-order-payment-latency.test.ts',
  '__tests__/mark-paid-holds-an-order-changed-mid-charge.test.ts',
  '__tests__/terminal-order-payment-non-gateway-ledger.test.ts',
  '__tests__/prepare-payment-latency.test.ts',
]

const MUTATIONS = [
  {
    id: 'RC-1',
    file: RECEIPT,
    what: 'the existing-receipt check and the order read go back to one after the other',
    from: '  const [existingSettled, orderSettled] = await Promise.allSettled([\n',
    to:
      "  const existingFirst = await Promise.allSettled([supabase.from('receipt_documents').select('*').eq('order_id', orderId).eq('document_type', DOCUMENT_TYPE).eq('version', 1).maybeSingle()])\n" +
      '  const [, orderSettled] = await Promise.allSettled([\n',
    also: {
      from: '  const { data: existingEarly } = inOrder(existingSettled)\n',
      to: '  const { data: existingEarly } = inOrder(existingFirst[0])\n',
    },
  },
  {
    id: 'RC-2',
    file: RECEIPT,
    what: 'the restaurant is read on its own before the rest of the wave',
    from: "  const tipReference = String(order.payment_reference || '').trim()\n",
    to:
      "  await supabase.from('restaurants').select('name, address, currency').eq('id', order.restaurant_id).single()\n" +
      "  const tipReference = String(order.payment_reference || '').trim()\n",
  },
  {
    id: 'RC-3',
    file: RECEIPT,
    what: 'Promise.all semantics: the FIRST read to reject decides the error, not the first in order',
    from: '  const [restaurantSettled, billingSettled, registrationSettled, saleEventsSettled, tipSettled] =\n    await Promise.allSettled([\n',
    to:
      '  const [restaurantSettled, billingSettled, registrationSettled, saleEventsSettled, tipSettled] =\n' +
      "    await ((xs: Promise<any>[]) => Promise.all(xs).then((vs) => vs.map((value) => ({ status: 'fulfilled' as const, value }))))([\n",
  },
  {
    id: 'RC-4',
    file: RECEIPT,
    what: 'a sales-read failure is reported before a missing restaurant',
    from: '  const { data: restaurant, error: restaurantError } = inOrder(restaurantSettled)\n',
    to:
      '  {\n' +
      '    const early = inOrder(saleEventsSettled)\n' +
      '    if (early.error) throw new Error(`issueReceiptForOrder: failed to load payment events for order ${orderId}: ${early.error.message}`)\n' +
      '  }\n' +
      '  const { data: restaurant, error: restaurantError } = inOrder(restaurantSettled)\n',
  },
  {
    id: 'RC-5',
    file: RECEIPT,
    what: 'vat_registered is folded into the billing read (against the recorded decision)',
    from: "        .select('vat_number, registration_number')\n",
    to: "        .select('vat_number, registration_number, vat_registered')\n",
    also: {
      from: '    const { data: registrationRow } = inOrder(registrationSettled)\n',
      to: '    const { data: registrationRow } = inOrder(billingSettled)\n',
    },
  },
  {
    id: 'RC-6',
    file: RECEIPT,
    what: 'an unreadable order is reported before an existing receipt is returned',
    from: '  const { data: existingEarly } = inOrder(existingSettled)\n',
    to:
      '  if (inOrder(orderSettled).error) throw new Error(`issueReceiptForOrder: order not found (${orderId})`)\n' +
      '  const { data: existingEarly } = inOrder(existingSettled)\n',
  },
  {
    id: 'PP-1',
    file: MARK,
    what: 'audit, tab total and receipt go back to one after the other after the claim',
    from:
      '  const settled = await Promise.allSettled([\n' +
      '    recordAudit(),\n' +
      '    recomputeTabTotal(),\n' +
      '    safeIssueReceiptForOrder(orderId, source),\n' +
      '  ])\n',
    to:
      '  await recordAudit()\n' +
      '  await recomputeTabTotal()\n' +
      '  await safeIssueReceiptForOrder(orderId, source)\n' +
      '  const settled: PromiseSettledResult<unknown>[] = []\n',
  },
  {
    id: 'PP-2',
    file: TABSTATE,
    what: 'the ready-to-pay clear and the reopen go back to one after the other',
    from:
      '  const [, { error: reopenError }] = await Promise.all([\n' +
      '    clearFlags(),\n' +
      "    supabase.from('tabs').update({ status: 'open' }).eq('id', tabId).is('settled_at', null),\n" +
      '  ])\n',
    to:
      '  await clearFlags()\n' +
      "  const { error: reopenError } = await supabase.from('tabs').update({ status: 'open' }).eq('id', tabId).is('settled_at', null)\n",
  },
  {
    id: 'PP-3',
    file: ROUTE,
    what: "the tab's orders are read a second time for canClose (the statuses handed back are ignored)",
    from: '          if (result.tabPaymentStatuses) return result.tabPaymentStatuses\n',
    to: '          if (false && result.tabPaymentStatuses) return result.tabPaymentStatuses\n',
  },
  {
    id: 'PP-4',
    file: TABSTATE,
    what: "the parallel reopen loses its resurrection guard (a closed-out tab is reopened)",
    from: "    supabase.from('tabs').update({ status: 'open' }).eq('id', tabId).is('settled_at', null),\n",
    to: "    supabase.from('tabs').update({ status: 'open' }).eq('id', tabId),\n",
  },
  {
    id: 'PP-5',
    file: MARK,
    what: 'a step that throws is swallowed instead of surfacing as before',
    from: "  for (const s of settled) if (s.status === 'rejected') throw s.reason\n",
    to: "  for (const s of settled) if (s.status === 'rejected' && false) throw s.reason\n",
  },
  {
    id: 'PR-1',
    file: MERCHANT,
    what: 'the merchant-order helper ignores the preloaded lead row and reads it again',
    from: '    preloaded !== undefined\n',
    to: '    false && preloaded !== undefined\n',
  },
  {
    id: 'PR-2',
    file: PREPARE,
    what: 'the terminal check and the credentials read go back to one after the other',
    from:
      '    const [terminalChecked, credentialsRead] = await Promise.allSettled([\n' +
      '      validateTerminalRecord(supabase, terminal),\n' +
      '      getRestaurantFinaticCredentials(terminal.restaurantId),\n' +
      '    ])\n',
    to:
      '    const [terminalChecked] = await Promise.allSettled([validateTerminalRecord(supabase, terminal)])\n' +
      '    const [credentialsRead] = await Promise.allSettled([getRestaurantFinaticCredentials(terminal.restaurantId)])\n',
  },
  {
    id: 'PR-3',
    file: PREPARE,
    what: 'the gratuity check is read on its own before the settlement set',
    from: '    const [tipMemberRead, settlementRead] = await Promise.allSettled([\n',
    to:
      "    if (tipCents > 0) await supabase.from('restaurant_users').select('user_id').eq('restaurant_id', terminal.restaurantId).eq('user_id', tipStaffUserId).maybeSingle()\n" +
      '    const [tipMemberRead, settlementRead] = await Promise.allSettled([\n',
  },
  {
    id: 'PR-4',
    file: PREPARE,
    what: 'the terminal check result is ignored now that it runs alongside the credentials read',
    from: "    if (terminalChecked.status === 'rejected') throw terminalChecked.reason\n",
    to: "    if (terminalChecked.status === 'rejected' && false) throw terminalChecked.reason\n",
  },
  {
    id: 'PR-5',
    file: PREPARE,
    what: "a failed read no longer carries the helper's own error message",
    from: '      if (orderReadError) throw new Error(`Failed to load order: ${orderReadError.message}`)\n',
    to: '      if (orderReadError) throw new Error(orderReadError.message)\n',
  },
  {
    id: 'PR-6',
    file: PREPARE,
    what: 'the helper is handed the wrong row (the last in the set, not the lead)',
    from: '      const leadRead = (orderRows ?? []).find((r) => String(r.id) === orderId) ?? null\n',
    to: '      const leadRead = (orderRows ?? [])[(orderRows ?? []).length - 1] ?? null\n',
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

const control = runJest([...SUITES, '__tests__/receipt-vat-registration-is-explicit.test.ts', '__tests__/e2e-order-to-receipt.test.ts', '__tests__/tab-settle-ledger-tip.test.ts'])
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`)
if (control.status !== 0) failures += 1

process.exit(failures === 0 ? 0 : 1)
