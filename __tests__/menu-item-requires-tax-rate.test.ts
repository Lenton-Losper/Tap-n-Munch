/**
 * A MENU ITEM CANNOT BE SAVED WITHOUT AN EXPLICITLY CHOSEN TAX RATE. Ruled 2026-08-18.
 *
 * The receipt that caused it, production order #10, paid:
 *
 *     1x coffee     NAD  50.00   stored tax 0.00   rate 0%   <- tax_rate_id was NULL
 *     1x Pork Star  NAD 240.00   stored tax 12.12  rate 5.32%
 *     VAT           NAD  12.12   <- at 15% inclusive it should be 37.83
 *
 * The arithmetic was faithful; nobody had chosen a rate for the coffee, and the form's DEFAULT
 * selection was literally "Use restaurant default". Zero-rating by default is deliberate on that
 * restaurant — what was wrong is that the question was never put.
 */
import {
  checkTaxRateChosen,
  taxRateBelongsToRestaurant,
  TAX_RATE_REQUIRED_MESSAGE,
} from '@/lib/menu-items/require-tax-rate'

const RATE = '7d5f0a2e-0000-4000-8000-000000000001'
const OTHER = '7d5f0a2e-0000-4000-8000-000000000002'

describe('creating a menu item', () => {
  it('REFUSES when no rate was chosen — the defect, stated as a rule', () => {
    expect(checkTaxRateChosen(undefined, null).ok).toBe(false)
    expect(checkTaxRateChosen(null, null).ok).toBe(false)
    expect(checkTaxRateChosen('', null).ok).toBe(false)
    expect(checkTaxRateChosen('   ', null).ok).toBe(false)
  })

  it('ACCEPTS an explicit choice — the control, or "refuses everything" would pass the above', () => {
    expect(checkTaxRateChosen(RATE, null).ok).toBe(true)
  })

  /**
   * "No tax" must stay reachable. The ruling removes the IMPLICIT fallback, not the option — a
   * restaurant that genuinely zero-rates an item selects a 0% rate, and that is a rate id like any
   * other. A rule that refused zero-rating would be a different, worse defect.
   */
  it('ACCEPTS a deliberately zero-rated choice, because that is a real answer', () => {
    expect(checkTaxRateChosen(OTHER, null).ok).toBe(true)
  })

  it('carries the refusal message and names the field', () => {
    const r = checkTaxRateChosen(undefined, null)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.message).toBe(TAX_RATE_REQUIRED_MESSAGE)
    expect(r.field).toBe('tax_rate_id')
  })

  /**
   * Was `toMatch(/^PENDING COPY/)` while the wording was outstanding. Signed off 2026-08-18, so
   * the assertion INVERTS rather than being deleted: the thing worth guarding was never that a
   * placeholder existed, it was that a placeholder must never reach a person. This message renders
   * in a staff-facing toast and in the API error body, and it shipped to production once already
   * with the marker still on it.
   */
  it('ships real wording — a placeholder must never reach the person saving', () => {
    expect(TAX_RATE_REQUIRED_MESSAGE).not.toMatch(/PENDING COPY|TODO|TBD|FIXME/i)
    expect(TAX_RATE_REQUIRED_MESSAGE.trim().length).toBeGreaterThan(0)
  })
})

describe('editing a menu item', () => {
  it('leaves an untouched rate alone — omitting the field is not clearing it', () => {
    // The common edit: change the price, say nothing about tax.
    expect(checkTaxRateChosen(undefined, RATE).ok).toBe(true)
  })

  it('REFUSES to leave a legacy item without one, which is what forces the choice', () => {
    // 390 of 396 production items are in this state. Editing one now asks the question — it does
    // NOT assign a rate on anyone's behalf, because that would change what a customer is charged.
    expect(checkTaxRateChosen(undefined, null).ok).toBe(false)
  })

  it('REFUSES an explicit clear, even on an item that had one', () => {
    expect(checkTaxRateChosen('', RATE).ok).toBe(false)
    expect(checkTaxRateChosen(null, RATE).ok).toBe(false)
  })

  it('ACCEPTS changing one rate for another', () => {
    expect(checkTaxRateChosen(OTHER, RATE).ok).toBe(true)
  })
})

describe('the rate must belong to this restaurant', () => {
  /**
   * "A rate was chosen" and "a rate this tenant owns" are different questions. A foreign id would
   * be stored and then silently fall back at pricing time — the same silence by another route, and
   * the API is reachable without the form.
   */
  it('accepts one of the restaurant’s own rates', () => {
    expect(taxRateBelongsToRestaurant(RATE, [RATE, OTHER])).toBe(true)
  })

  it('rejects an id belonging to another restaurant', () => {
    expect(taxRateBelongsToRestaurant('7d5f0a2e-0000-4000-8000-00000000dead', [RATE, OTHER])).toBe(
      false,
    )
  })

  it('rejects an absent or blank id rather than treating it as unowned-but-fine', () => {
    expect(taxRateBelongsToRestaurant(undefined, [RATE])).toBe(false)
    expect(taxRateBelongsToRestaurant('', [RATE])).toBe(false)
    expect(taxRateBelongsToRestaurant('  ', [RATE])).toBe(false)
  })

  it('rejects everything when the restaurant has no rates at all', () => {
    expect(taxRateBelongsToRestaurant(RATE, [])).toBe(false)
  })
})

describe('the route enforces it, not just the form', () => {
  /**
   * A disabled button is not a rule. This project has shipped that mistake before — a client guard
   * is not a lock (#302) — and /api/admin/menu/items is reachable without the form. Asserted as a
   * source scan because the handlers are Next route exports that need a full request to invoke.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const route = readFileSync(
    join(process.cwd(), 'app/api/admin/menu/items/route.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')

  it('guards BOTH write handlers', () => {
    const calls = route.match(/refuseWithoutTaxRate\(/g) ?? []
    // one definition + one call in POST + one in PATCH
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  it('reads the existing rate, or an edit could not tell "unchanged" from "never set"', () => {
    expect(route).toMatch(/select\('id, name, subcategory_id, category_id, tax_rate_id'\)/)
  })
})
