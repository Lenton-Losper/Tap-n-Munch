/**
 * READ-ONLY PROBE for #191. No network, no database, no writes.
 *
 * Question: how often does the tab-settle sum
 *   (tabOrders ?? []).reduce((sum, o) => sum + Number(o.total), 0)
 * land on a value that is NOT the exact 2dp figure, and in which DIRECTION?
 *
 * Direction is the part that matters. The stored artefact becomes a refund
 * ceiling once the settle route writes the sale ledger row (#156), and that
 * ceiling is a strict `>` comparison, so:
 *   - artefact ABOVE the true total  -> ceiling is a hair too high, harmless
 *   - artefact BELOW the true total  -> a full refund of the exact tab total
 *                                       is REJECTED as exceeding the balance
 *
 * Run: node node_modules/tsx/dist/cli.mjs scripts/probe-settle-sum-float.ts
 */

/** The route's sum, verbatim. */
function settleSum(totals: number[]): number {
  return totals.reduce((sum, t) => sum + Number(t), 0)
}

/** The exact 2dp figure the sum is meant to produce, computed in integer cents. */
function exactSum(totals: number[]): number {
  return totals.reduce((cents, t) => cents + Math.round(t * 100), 0) / 100
}

function randomTotal(rng: () => number): number {
  // Realistic Namibian restaurant order totals: NAD 5.00 - 500.00, 2dp.
  return Math.round((5 + rng() * 495) * 100) / 100
}

// Deterministic LCG so the numbers in the packet are reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const TRIALS = 200_000

console.log('=== #191: float artefact rate in the tab-settle sum ===\n')
console.log('orders  inexact%   above%    below%   worst |delta|')

for (const n of [2, 3, 4, 5, 6, 8, 10]) {
  const rng = makeRng(20260810 + n)
  let inexact = 0
  let above = 0
  let below = 0
  let worst = 0

  for (let i = 0; i < TRIALS; i++) {
    const totals = Array.from({ length: n }, () => randomTotal(rng))
    const got = settleSum(totals)
    const want = exactSum(totals)
    if (got !== want) {
      inexact++
      if (got > want) above++
      else below++
      worst = Math.max(worst, Math.abs(got - want))
    }
  }

  console.log(
    `${String(n).padStart(6)}  ${((inexact / TRIALS) * 100).toFixed(2).padStart(7)}%  ` +
      `${((above / TRIALS) * 100).toFixed(2).padStart(6)}%  ` +
      `${((below / TRIALS) * 100).toFixed(2).padStart(6)}%  ` +
      `${worst.toExponential(3)}`,
  )
}

console.log('\n=== the issue\'s own example ===')
const example = [35.1, 27.25, 42.95]
console.log('  sum      =', settleSum(example))
console.log('  exact    =', exactSum(example))
console.log('  equal?   =', settleSum(example) === exactSum(example))

console.log('\n=== a BELOW case, and what the refund ceiling does with it ===')
// Search for a sum that lands BELOW its exact value.
const rng = makeRng(7)
let belowCase: number[] | null = null
for (let i = 0; i < 500_000 && !belowCase; i++) {
  const totals = Array.from({ length: 3 }, () => randomTotal(rng))
  if (settleSum(totals) < exactSum(totals)) belowCase = totals
}
if (belowCase) {
  const stored = settleSum(belowCase)
  const trueTotal = exactSum(belowCase)
  console.log('  orders            =', belowCase.join(' + '))
  console.log('  stored sale.amount=', stored)
  console.log('  true tab total    =', trueTotal)
  // record_terminal_refund_event: IF (v_prior + p_amount) > v_sale.amount THEN reject
  console.log('  full refund of', trueTotal, '-> (0 +', trueTotal, ') >', stored, '=',
    trueTotal > stored, trueTotal > stored ? '=> REJECTED (AMOUNT_EXCEEDS_REMAINING)' : '=> allowed')
} else {
  console.log('  none found in 500k trials')
}

console.log('\n=== does the CHECK still pass? (#180 rounds to whole cents) ===')
const floatSum = settleSum(example)
const roundedDiffCents = Math.abs(Math.round(105.3 * 100) - Math.round(floatSum * 100))
console.log('  |round(105.30*100) - round(sum*100)| =', roundedDiffCents, 'cents -> within tolerance')
