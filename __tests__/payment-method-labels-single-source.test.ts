/**
 * ONE PAYMENT-METHOD LABEL MAP, AND ONLY ONE.
 *
 * ==================================================================================================
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 * ==================================================================================================
 *
 * lib/reports/daily-report-email.ts carried its own METHOD_LABELS -- card/cash/unknown --
 * byte-identical to the map in lib/reports/payment-method-split.ts, with its own independent
 * `?? p.method` fallback. Nothing referenced the two together, nothing compared them, and both
 * degraded gracefully to the raw key.
 *
 * That last part is why it would have gone unnoticed. Add a method to one and not the other and
 * nothing throws, nothing 500s, no test fails: the dashboard prints "PayToday" and the same night's
 * email prints "paytoday", for the same money, to the same manager. The split-source-of-truth
 * pattern, with a silent failure mode.
 *
 * Collapsed 2026-09-09, before PayToday, so a third value is added in exactly one place.
 *
 * ==================================================================================================
 * WHY THIS TEST READS SOURCE
 * ==================================================================================================
 *
 * Asserting the two agree would need both to exist -- which is the thing being prevented. So it
 * asserts that no OTHER module defines a lookup of this shape, by reading the report modules and
 * looking for a map keyed on the method names. A future author re-adding a local copy fails here
 * rather than shipping a quiet disagreement.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { PAYMENT_METHOD_LABELS, paymentMethodLabel } from '@/lib/reports/payment-method-split'

const REPORTS_DIR = join(process.cwd(), 'lib', 'reports')
const CANONICAL = join(REPORTS_DIR, 'payment-method-split.ts')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
}

describe('the label map has exactly one definition', () => {
  const files = sourceFiles(REPORTS_DIR)

  it('the checker can see the report modules', () => {
    // Without this, an empty file list makes every assertion below pass having read nothing.
    expect(files.length).toBeGreaterThan(3)
    expect(files).toContain(CANONICAL)
  })

  it('POSITIVE CONTROL: it finds the canonical map', () => {
    /**
     * The detector must be shown to fire on the real thing. If the pattern below stops matching
     * PAYMENT_METHOD_LABELS, it will also stop matching a future duplicate, and this suite becomes
     * an "all clear" from an instrument that reads nothing.
     */
    const src = readFileSync(CANONICAL, 'utf8')
    expect(looksLikeAMethodLabelMap(src)).toBe(true)
  })

  it('no OTHER report module defines one', () => {
    const offenders = files
      .filter((f) => f !== CANONICAL)
      .filter((f) => looksLikeAMethodLabelMap(readFileSync(f, 'utf8')))
      .map((f) => f.slice(process.cwd().length + 1).split('\\').join('/'))

    expect(offenders).toEqual([])
  })
})

/**
 * A record literal that maps the method names to display strings.
 *
 * Anchored on `card:` and `cash:` appearing as object keys with string values inside one literal,
 * which is what every copy of this has looked like. Comments are stripped first so prose about the
 * duplication -- of which there is now a good deal -- is not mistaken for the duplication.
 */
function looksLikeAMethodLabelMap(src: string): boolean {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  return /\{[^{}]*\bcard:\s*'[^']*'[^{}]*\bcash:\s*'[^']*'[^{}]*\}/.test(code)
}

describe('the map itself still behaves', () => {
  it('labels the methods it knows', () => {
    expect(paymentMethodLabel('card')).toBe('Card')
    expect(paymentMethodLabel('cash')).toBe('Cash')
  })

  it('an unrecorded method is named, not folded into cash', () => {
    /**
     * `unknown` is a real answer -- an order reported paid with no method recorded -- and a manager
     * counting a drawer would assume anything vaguer meant cash.
     */
    expect(paymentMethodLabel('unknown')).toBe('Unrecorded')
    expect(paymentMethodLabel('unknown')).not.toMatch(/cash/i)
  })

  it('an unmapped method falls back to its raw key rather than vanishing', () => {
    /**
     * The fallback is deliberate and must stay: a method with no label still has to APPEAR in a
     * cash-up, because a row silently dropped from a takings report is money that reconciles to
     * nothing. Ugly and present beats pretty and absent.
     */
    expect(paymentMethodLabel('some_new_method')).toBe('some_new_method')
  })

  it('every key in the map is lowercase', () => {
    // get-report-data lowercases payment_method before grouping, so an upper-case key here would
    // be dead and its method would print raw.
    for (const key of Object.keys(PAYMENT_METHOD_LABELS)) {
      expect({ key, lower: key === key.toLowerCase() }).toEqual({ key, lower: true })
    }
  })
})
