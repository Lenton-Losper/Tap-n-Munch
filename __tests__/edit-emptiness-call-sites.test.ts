/**
 * #291 -- the two call sites, not the rule.
 *
 * `edit-emptiness.test.ts` proves the predicate is right and would stay entirely green with the
 * panel still reading `kept.length === 0` and the route still throwing from inside
 * `repriceKeptLines`. A test bound to a shared rule cannot see whether anything calls it, and
 * `tsc` cannot either -- #232 established that with a two-sided probe, and this defect is the
 * same shape twice over.
 *
 * It matters more than usual here because the defect was DOUBLE-SIDED: the panel greyed Save out,
 * and a client that got past that would have met a 400 the customer cannot read. Fixing one side
 * looks like a fix and is not one, so both are asserted.
 */
import fs from 'fs'
import path from 'path'

const PANEL = path.join(process.cwd(), 'components', 'order-edit-panel.tsx')
const ROUTE = path.join(
  process.cwd(),
  'app', 'api', 'guest', 'orders', '[orderId]', 'edit', 'route.ts',
)
const REPRICE = path.join(process.cwd(), 'lib', 'orders', 'reprice-priced-lines.ts')

const panel = fs.readFileSync(PANEL, 'utf8')
const route = fs.readFileSync(ROUTE, 'utf8')
const reprice = fs.readFileSync(REPRICE, 'utf8')

describe('#291 the panel decides emptiness with the shared predicate', () => {
  it('the scan found a real file', () => {
    // The label moved into signed copy (MENU_COPY.editSaveChanges) -- assert the panel still
    // renders THAT control, not a literal that a copy pass can move out from under this scan.
    expect(panel).toContain('MENU_COPY.editSaveChanges')
  })

  it('imports editLeavesOrderEmpty', () => {
    expect(panel).toContain("from '@/lib/orders/edit-emptiness'")
  })

  it('the Save button is gated on the predicate, not on kept.length', () => {
    expect(panel).toMatch(/disabled=\{busy \|\| wouldBeEmpty/)
    expect(panel).not.toMatch(/disabled=\{busy \|\| kept\.length === 0/)
  })

  it('the cannotEmpty warning is gated on the predicate too', () => {
    // Both the message and the button, or the customer is told the edit is impossible while the
    // button is live -- or the reverse, which is how this defect reads on a phone.
    expect(panel).not.toMatch(/\{kept\.length === 0 && \(/)
    expect(panel).toMatch(/\{wouldBeEmpty && \(/)
  })
})

describe('#291 the route decides emptiness with the same predicate', () => {
  it('the scan found a real file', () => {
    expect(route).toContain('repriceKeptLines')
  })

  it('imports and calls editLeavesOrderEmpty', () => {
    expect(route).toContain("from '@/lib/orders/edit-emptiness'")
    expect(route).toMatch(/editLeavesOrderEmpty\(\{/)
  })

  it('counts the additions, not only the kept lines', () => {
    // The bug in one line: a check that reads only `next.items.length` is the server-side
    // version of the panel bug and refuses every swap with an unreadable 400.
    expect(route).toMatch(/additionCount: parsed\.add\?\.length \?\? 0/)
  })
})

describe('#291 repriceKeptLines no longer owns the decision', () => {
  it('does not refuse an empty keep', () => {
    expect(reprice).not.toContain("An order must keep at least one item")
  })

  it('still refuses a keep that is not a list', () => {
    // Removing the emptiness throw must not remove the type guard with it.
    expect(reprice).toMatch(/if \(!Array\.isArray\(keep\)\) \{/)
  })
})
