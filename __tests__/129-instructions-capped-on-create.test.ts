/**
 * #129 — order instructions must be capped on the CREATION path, not just in the textarea.
 *
 * Both textareas carry `maxLength={MAX_INSTRUCTIONS_LENGTH}` and the guest edit route already
 * normalised. `POST /api/orders` — the route that creates every order — took the field straight
 * from the request body into a `text` column. A `maxLength` attribute is a convenience for
 * someone typing; it is not a cap, and the endpoint is reachable without the form.
 *
 * Not an injection risk: the dashboard renders instructions as JSX text so React escapes them,
 * and nothing in that path uses `dangerouslySetInnerHTML`. It is a layout and print blowout — a
 * thermal printer handed 40kB of instructions is a real outage at the counter.
 */
import {
  MAX_INSTRUCTIONS_LENGTH,
  normalizeOrderInstructions,
} from '@/lib/orders/instruction-limits'

describe('normalizeOrderInstructions', () => {
  it('caps at the limit — the defect, stated as a rule', () => {
    const huge = 'x'.repeat(40_000)
    expect(normalizeOrderInstructions(huge)).toHaveLength(MAX_INSTRUCTIONS_LENGTH)
  })

  it('leaves a normal note untouched — the control', () => {
    // Without this, "caps everything" would satisfy the test above while destroying real notes.
    const real = 'no sugar, oat milk, and please keep the burger separate from the nuts'
    expect(normalizeOrderInstructions(real)).toBe(real)
  })

  it('returns null for an empty or whitespace note', () => {
    // The write sites use `orderInstructions || null`, so null and '' behave alike there — but
    // null is the honest value for "they wrote nothing".
    expect(normalizeOrderInstructions('')).toBeNull()
    expect(normalizeOrderInstructions('   ')).toBeNull()
    expect(normalizeOrderInstructions(null)).toBeNull()
    expect(normalizeOrderInstructions(undefined)).toBeNull()
  })

  it('trims before measuring, so padding cannot smuggle length', () => {
    expect(normalizeOrderInstructions('  hi  ')).toBe('hi')
  })
})

describe('the creation route applies it', () => {
  /**
   * Source scan: the handler is a Next route export needing a full request to invoke, and the
   * point being pinned is that this specific route calls the shared helper at all.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const src = readFileSync(join(process.cwd(), 'app/api/orders/route.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('POST /api/orders normalises the field', () => {
    expect(code).toMatch(/normalizeOrderInstructions\(/)
  })

  it('does not read the raw body field straight into the row', () => {
    expect(code).not.toMatch(/const orderInstructions = rest\.orderInstructions\s*$/m)
  })

  it('uses the SAME helper as the edit route, so the limits cannot drift', () => {
    const edit = readFileSync(
      join(process.cwd(), 'app/api/guest/orders/[orderId]/edit/route.ts'),
      'utf8',
    )
    expect(edit).toMatch(/normalizeOrderInstructions/)
    expect(code).toMatch(/from '@\/lib\/orders\/instruction-limits'/)
  })
})
