/**
 * #306 — the CLIENT half of "your change was saved".
 *
 * The server telling the truth is not the fix the customer meets. Before this branch existed, the
 * honest sentence arrived through `setError()`: the customer was told in red that their change
 * was saved, beside an order that had not refreshed, with no way forward. Better than the lie it
 * replaced, and not yet the fix.
 *
 * WHAT THIS FILE CAN AND CANNOT DO, in the shape `edit-emptiness-call-sites.test.ts` established:
 * it scans the call site, because a test bound to the shared rule cannot see whether anything
 * calls it and `tsc` cannot either. It proves the branch EXISTS and routes to the success path.
 * It cannot prove what renders — no panel render harness exists, and building one is not this
 * commit. The server half is proved by `scripts/probe-306-lost-response-is-not-a-lie.ts`, which
 * asserts the response the branch keys on.
 */
import fs from 'fs'
import path from 'path'

const PANEL = path.join(process.cwd(), 'components', 'order-edit-panel.tsx')
const CLIENT = path.join(process.cwd(), 'lib', 'guest-orders', 'client.ts')
const ROUTE = path.join(
  process.cwd(),
  'app', 'api', 'guest', 'orders', '[orderId]', 'edit', 'route.ts',
)

const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
/** Comments stripped: assertions here have matched the very comments describing them before. */
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const panel = codeOnly(read(PANEL))
const client = codeOnly(read(CLIENT))
const route = codeOnly(read(ROUTE))

describe('#306 the already_saved branch is wired end to end', () => {
  it('the scan found real files', () => {
    // Without this a moved file turns every assertion below into a no-op that reports green.
    expect(panel).toContain('Save changes')
    expect(client).toContain('OrderEditRefused')
    expect(route).toContain('alreadySavedResponse')
  })

  it('the server emits the reason the client keys on', () => {
    expect(route).toContain("reason: 'already_saved'")
  })

  it('the server sends the current order with it, not just a sentence', () => {
    const body = route.slice(route.indexOf('function alreadySavedResponse'))
    for (const field of ['items:', 'subtotal:', 'tax:', 'total:']) {
      expect(body.slice(0, 900)).toContain(field)
    }
  })

  it('the refusal carries the body through, or the panel has nothing to show', () => {
    expect(client).toMatch(/readonly details: Record<string, unknown>/)
    // The throw must actually pass it. A field declared and never populated is the same defect
    // as a column written and never selected.
    expect(client).toMatch(/new OrderEditRefused\([\s\S]{0,220}?parsed,\s*\)/)
  })

  it('the panel branches on already_saved BEFORE the generic setError', () => {
    const branch = panel.indexOf("err.reason === 'already_saved'")
    const generic = panel.indexOf('setError(err.message)')
    expect(branch).toBeGreaterThan(-1)
    expect(generic).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(generic)
  })

  it('that branch takes the success path: a notice, a refresh, and no error', () => {
    const start = panel.indexOf("err.reason === 'already_saved'")
    // Bounded at the branch's own `return`, or the slice runs on into the generic handler and
    // the "no setError here" assertion silently measures the wrong code.
    const end = panel.indexOf('return', start)
    expect(end).toBeGreaterThan(start)
    const branch = panel.slice(start, end)
    expect(branch).toContain('setNotice(')
    expect(branch).toContain('onEdited()')
    expect(branch).not.toContain('setError(')
    // Same cleanup as a successful save, or the editor stays open over a spent lock.
    expect(branch).toContain('clearPendingAdditions(orderId)')
    expect(branch).toContain('setGrant(null)')
  })
})
