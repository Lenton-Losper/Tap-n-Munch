/**
 * #206 -- the call sites, not the rule.
 *
 * `customer-safe-error.test.ts` proves the filter classifies correctly. It would stay entirely
 * green with all five call sites still printing `err.message` raw, because a test bound to a
 * shared rule cannot see whether anyone calls it -- and `tsc` cannot either. That is #232's
 * lesson, and #206 is exactly the shape it applies to: the defect was never in a function, it
 * was in five expressions.
 *
 * So this scans the shipped source of the customer-facing pages.
 */
import fs from 'fs'
import path from 'path'

const PAGES = [
  'cart/page.tsx',
  'tab/page.tsx',
  'order-secure/page.tsx',
].map((rel) => ({
  rel,
  file: path.join(process.cwd(), 'app', 'menu', '[restaurantId]', rel),
}))

/** `description:` lines inside a toast are what the customer actually reads. */
const RAW_MESSAGE_IN_DESCRIPTION =
  /description:\s*(?:[\w?.]*err(?:or)?\??\.message|[\w]+\s+instanceof\s+Error\s*\?\s*[\w]+\.message)/

describe('#206 -- no customer page renders server error text verbatim', () => {
  it.each(PAGES)('$rel routes its toast text through customerSafeError', ({ file }) => {
    const source = fs.readFileSync(file, 'utf8')

    // Guard the scan: if the file moved or was emptied, fail rather than pass on nothing.
    expect(source.length).toBeGreaterThan(500)
    expect(source).toContain('toast(')

    expect(source).toContain("from '@/lib/customer-copy/customer-safe-error'")
    expect(source).toMatch(/description: customerSafeError\(/)
    expect(RAW_MESSAGE_IN_DESCRIPTION.test(source)).toBe(false)
  })

  it('the scan pattern actually matches the shape it is meant to catch', () => {
    // Without this, a typo in the regex would make the assertion above vacuously true forever.
    expect(RAW_MESSAGE_IN_DESCRIPTION.test("description: err?.message || 'Please try again.',")).toBe(true)
    expect(
      RAW_MESSAGE_IN_DESCRIPTION.test("description: err instanceof Error ? err.message : 'x',")
    ).toBe(true)
    expect(RAW_MESSAGE_IN_DESCRIPTION.test("description: error.message || 'x',")).toBe(true)
    expect(RAW_MESSAGE_IN_DESCRIPTION.test("description: customerSafeError(err, 'x'),")).toBe(false)
  })

  it('all five call sites are accounted for', () => {
    const total = PAGES.reduce((n, { file }) => {
      const hits = fs.readFileSync(file, 'utf8').match(/description: customerSafeError\(/g)
      return n + (hits?.length ?? 0)
    }, 0)
    // #206 enumerated five. If a sixth toast appears it must be classified, not silently added.
    expect(total).toBe(5)
  })
})
