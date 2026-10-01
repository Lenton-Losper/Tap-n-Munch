/**
 * MUTATION CHECK for the payment timeline marks (src/lib/paymentTimeline.ts, Terminal 2.43).
 * Each mutation removes ONE mark from processPaymentIntent and requires
 * src/lib/__tests__/paymentTimeline.test.ts to go RED; the file is restored whatever happens.
 *
 *   node scripts/mutate-payment-timeline.mjs
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const F = "src/lib/payment.ts"
const orig = readFileSync(F, 'utf8')
const lf = orig.replace(/\r\n/g, '\n')
const crlf = orig.includes('\r\n')
const M = [
  ['TL-1 T0 mark removed', "  markPaymentTimeline('t0_start', {orderId, suppliedRef: Boolean(options?.merchantOrderNo)});\n"],
  ['TL-2 launch mark removed', "    markPaymentTimeline('launch_requested', {orderId, businessOrderNo: merchantOrderNo});\n"],
  ['TL-3 reject-path result mark removed', "      markPaymentTimeline('result_in_js', {orderId, settled: 'rejected'});\n"],
]
let bad = 0
try {
  for (const [name, line] of M) {
    if (lf.split(line).length !== 2) { console.log(`${name}: ANCHOR MISSING`); bad++; continue }
    const mutated = lf.replace(line, '')
    writeFileSync(F, crlf ? mutated.replace(/\n/g, '\r\n') : mutated)
    const r = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', 'src/lib/__tests__/paymentTimeline.test.ts'], { encoding: 'utf8' })
    const sum = (/Tests:\s+([^\n]+)/.exec(r.stdout + r.stderr) || [, '(none)'])[1]
    const red = r.status !== 0 && /failed/.test(sum)
    console.log(`${name}: ${red ? 'RED' : 'GREEN (NOT CAUGHT)'}  ${sum}`)
    if (!red) bad++
    writeFileSync(F, orig)
  }
} finally { writeFileSync(F, orig) }
console.log(readFileSync(F, 'utf8') === orig ? 'restored' : 'RESTORE FAILED')
process.exit(bad ? 1 : 0)
