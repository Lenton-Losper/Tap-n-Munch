/**
 * THE AMEND ROUTE'S VOID GATE — THE HALF THAT CHANGES WHAT A REQUEST DOES.
 *
 * ============================================================================================
 * WHY THIS IS A SEPARATE FILE FROM void-controls.test.ts
 * ============================================================================================
 *
 * That suite covers the permission, the purpose, the migrations and the staff page, ALL of which
 * are inert on their own and shipped to production on 2026-09-06. This one covers the gate, which
 * is not inert: it REFUSES a reduction that arrives without a consumed line_void token, and the
 * shipped terminal (127) sends none. Riviera and Digi Cofee both have station_screens_enabled ON,
 * so deploying this half early would refuse every line reduction at both venues, mid-service.
 *
 * The two halves are separate files so the deploy boundary is visible in the test tree rather
 * than only in a commit message.
 *
 * ============================================================================================
 * THESE ASSERT CONDITIONS, NOT MARKER STRINGS
 * ============================================================================================
 *
 * A test that greps for `VOID_NEEDS_AUTHORIZATION` passes after the guard around it becomes
 * `if (false)` — the code is still sitting there in dead code. That mistake produced five defects
 * on 2026-09-05 and 09-06, every one of which looked covered. So the CONDITIONS are asserted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '')

const AMEND = code(read('app', 'api', 'terminal', 'tabs', '[tabId]', 'amend', 'route.ts'))
const REASON_MIG = sql(read('supabase', 'migrations', '20260906120100_order_line_events_void_reason.sql'))

const at = (needle: string) => {
  const i = AMEND.indexOf(needle)
  expect(i).toBeGreaterThan(-1)
  return i
}

describe('a reduction is a void, and a void is gated', () => {
  it('gates on ANY reduction, not only on quantity zero', () => {
    // Gating only `0` leaves a bypass: reduce 3 to 1 and two dishes leave the bill with no PIN.
    expect(AMEND).toMatch(/a\.new_quantity < current/)
  })

  it('an unknown line is not treated as a reduction', () => {
    // The RPC scopes and refuses it; demanding a PIN for a line that cannot be voided is noise.
    expect(AMEND).toMatch(/typeof current === 'number' && a\.new_quantity < current/)
  })

  it('refuses without a token AND a staff id', () => {
    expect(AMEND).toMatch(/if \(!authorizationTokenId \|\| !staffUserId\)/)
    expect(AMEND).toMatch(/VOID_NEEDS_AUTHORIZATION/)
  })

  it('refuses without a reason', () => {
    expect(AMEND).toMatch(/if \(!voidReason\)/)
    expect(AMEND).toMatch(/VOID_NEEDS_REASON/)
  })

  it('consumes the token against the line_void purpose specifically', () => {
    expect(AMEND).toMatch(/expectedPurpose: 'line_void'/)
    // Fails closed: a thrown error is treated as a rejection, not allowed to escape as a 401.
    expect(AMEND).toMatch(/consumed = \{ ok: false, reason: 'not_found' \}/)
    expect(AMEND).toMatch(/if \(!consumed\.ok\)/)
  })

  it('every refusal happens BEFORE the RPC that voids anything', () => {
    for (const guard of ['VOID_NEEDS_AUTHORIZATION', 'VOID_NEEDS_REASON', 'AUTHORIZATION_INVALID']) {
      expect(at(guard)).toBeLessThan(at("rpc('amend_order_lines'"))
    }
  })

  it('an amendment that reduces NOTHING is unaffected', () => {
    // Guarded on reducesALine, so an increase still needs no PIN and no reason.
    expect(AMEND).toMatch(/if \(reducesALine\) \{/)
  })
})

describe('a void records a human', () => {
  it('passes the PIN-verified user to the RPC, not null', () => {
    expect(AMEND).toMatch(/p_actor_user_id: attributedStaffUserId/)
    expect(AMEND).not.toMatch(/p_actor_user_id: null/)
  })

  it('that user is set only after the token is consumed', () => {
    expect(at('consumeAuthorizationToken')).toBeLessThan(at('attributedStaffUserId = staffUserId'))
  })
})

describe('the reason goes on the fulfilment record, not the kitchen note', () => {
  it('is stored on order_line_events', () => {
    expect(REASON_MIG).toMatch(/ALTER TABLE public\.order_line_events/)
    expect(REASON_MIG).toMatch(/ADD COLUMN IF NOT EXISTS void_reason text/)
  })

  it('never writes to order_lines.line_note', () => {
    /**
     * That column is the KITCHEN PREP NOTE, and amend_order_lines COPIES it onto the replacement
     * line — a void reason there would reach a chef on the next amendment of the same dish.
     *
     * ASSERTED AS "NOT WRITTEN", NOT "NOT MENTIONED". The migration's COMMENT ON COLUMN names
     * line_note deliberately, to tell the next reader why it is the wrong home; a blunt
     * `not.toMatch(/line_note/)` failed on that documentation, which is exactly the sentence
     * worth keeping. Forbidding the note that makes the rule findable is backwards.
     */
    expect(REASON_MIG).not.toMatch(/ALTER TABLE\s+(public\.)?order_lines\b/i)
    expect(REASON_MIG).not.toMatch(/^\s*(ADD|ALTER|DROP)\s+COLUMN[^;]*line_note/im)
    expect(AMEND).not.toMatch(/line_note\s*[:=]/)
    // ...and the reason's actual destination is the fulfilment record.
    expect(AMEND).toMatch(/from\('order_line_events'\)/)
  })

  it('is written only onto the lines THIS call voided, and only where none is set', () => {
    expect(AMEND).toMatch(/\.eq\('to_state', 'voided'\)/)
    expect(AMEND).toMatch(/\.is\('void_reason', null\)/)
    expect(AMEND).toMatch(/\.in\('order_line_id', voidedLineIds\)/)
    expect(AMEND).toMatch(/a\.action === 'voided'/)
  })

  it('a failed reason write does not fail the void', () => {
    // The customer's bill has already changed. A missing reason reads as NOT RECORDED, which the
    // column documents; a void that silently did not happen would be worse.
    const after = AMEND.slice(at("from('order_line_events')"))
    expect(after).not.toMatch(/throw /)
    expect(after).toMatch(/console\.error/)
  })

  it('the column is nullable, because most events are not voids', () => {
    expect(REASON_MIG).not.toMatch(/void_reason text NOT NULL/)
  })
})
