import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * #325 — a POS row must not render a literal "0" in the Table column.
 *
 * The terminal POS route hardcodes `tableNumber: 0` (there is no table for a counter sale), and the
 * cell used `??`, which substitutes only for null/undefined. So `0` passed straight through and
 * every POS row in Order History showed a table numbered zero.
 *
 * `0` is never a real table: every route that accepts a table number rejects `tableNumber <= 0` as
 * invalid. So the falsy check is the correct one here, and it is what the neighbouring `memberName`
 * cell already uses.
 *
 * ASSERTED ON THE SOURCE, because the alternative is rendering a page-sized component with a
 * Supabase client, a restaurant context and a router just to read one table cell. The risk of a
 * source assertion is that it passes having found nothing, so the first test pins the file down.
 */
const FILE = join(process.cwd(), 'components', 'order-history', 'order-history-content.tsx')
const src = readFileSync(FILE, 'utf8')

/** Comments quote the OLD expression while explaining the fix; matching those proves nothing. */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('#325 — the Table column', () => {
  it('found the real component, so an empty scan cannot report green', () => {
    expect(src.length).toBeGreaterThan(2000)
    expect(codeOnly).toContain('table_number')
    expect(codeOnly).toContain('Table')
  })

  it('renders a dash for table_number 0, not the number itself', () => {
    expect(codeOnly).toMatch(/\{order\.table_number \|\| '—'\}/)
  })

  it('does not use ?? , which lets 0 through', () => {
    // The whole defect in one line. `??` only substitutes null/undefined.
    expect(codeOnly).not.toMatch(/\{order\.table_number \?\? '—'\}/)
  })

  it('the neighbouring member cell already used the falsy check, so this is consistent', () => {
    expect(codeOnly).toMatch(/\{order\.memberName \|\| '—'\}/)
  })
})

describe('the rule the fix depends on', () => {
  it('0 is not a valid table number anywhere that accepts one', () => {
    // If this ever stops holding, `||` becomes wrong and the fix has to change with it.
    const guards = [
      join(process.cwd(), 'app', 'api', 'admin', 'tables', 'route.ts'),
      join(process.cwd(), 'app', 'api', 'guest', 'orders', 'active-table', 'route.ts'),
    ]
    for (const g of guards) {
      const s = readFileSync(g, 'utf8')
      expect(s).toMatch(/tableNumber <= 0/)
    }
  })
})
