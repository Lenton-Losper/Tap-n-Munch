/**
 * #179 — a valid table number must not take a path that fails to resolve.
 *
 * Middleware sees the RAW pathname. `/table/%205` gave `Number("%205") = NaN`, so no rewrite
 * happened; Next then decoded the param to `" 5"` and rendered the landing outside the provider
 * tree, where `useTab()` throws on mount. The customer's QR encoded table 5 and got a broken page.
 */
import { parseTableLandingPath } from '@/lib/riviera-subdomain'

describe('percent-encoded table numbers', () => {
  it('resolves /table/%205 to 5 — the defect', () => {
    expect(parseTableLandingPath('/table/%205')).toBe(5)
  })

  it('resolves a trailing encoded space too', () => {
    expect(parseTableLandingPath('/table/5%20')).toBe(5)
  })

  it('resolves a plain /table/5 — the control', () => {
    // Without this, "decodes correctly" could be satisfied by a parser that returns 5 for anything.
    expect(parseTableLandingPath('/table/5')).toBe(5)
    expect(parseTableLandingPath('/table/120')).toBe(120)
    expect(parseTableLandingPath('/table/9999')).toBe(9999)
  })
})

describe('what is still NOT a table number', () => {
  /**
   * The fix widens decoding only. A non-integer is still null, because rewriting `/table/5.5` to
   * a table that does not exist would be a different defect wearing the same fix.
   */
  it('rejects non-integers', () => {
    expect(parseTableLandingPath('/table/5.5')).toBeNull()
    expect(parseTableLandingPath('/table/0.5')).toBeNull()
    expect(parseTableLandingPath('/table/1e-3')).toBeNull()
  })

  it('rejects zero and negatives', () => {
    expect(parseTableLandingPath('/table/0')).toBeNull()
    expect(parseTableLandingPath('/table/-1')).toBeNull()
  })

  it('rejects words', () => {
    expect(parseTableLandingPath('/table/abc')).toBeNull()
    expect(parseTableLandingPath('/table/%61%62%63')).toBeNull() // "abc", encoded
  })

  it('rejects an empty or whitespace-only segment', () => {
    // `Number("")` is 0, which passes Number.isInteger and would be caught only by `> 0` — for
    // the wrong reason. Rejected explicitly instead.
    expect(parseTableLandingPath('/table/%20')).toBeNull()
    expect(parseTableLandingPath('/table/')).toBeNull()
  })

  it('returns null for a malformed escape rather than throwing', () => {
    // decodeURIComponent throws on this. A 500 from middleware over a bad URL would be worse than
    // the defect being fixed.
    expect(() => parseTableLandingPath('/table/%E0%A4%A')).not.toThrow()
    expect(parseTableLandingPath('/table/%E0%A4%A')).toBeNull()
  })

  it('is not a table path at all', () => {
    expect(parseTableLandingPath('/menu/abc')).toBeNull()
    expect(parseTableLandingPath('/table/5/extra')).toBeNull()
  })

  it('tolerates a trailing slash, as it always did', () => {
    expect(parseTableLandingPath('/table/5/')).toBe(5)
  })
})
