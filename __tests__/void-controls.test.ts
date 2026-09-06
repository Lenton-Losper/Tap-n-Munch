/**
 * TAKING FOOD OFF A BILL NEEDS A SECOND, NAMED PERSON.
 *
 * ============================================================================================
 * WHAT WAS WRONG BEFORE
 * ============================================================================================
 *
 * `amend_order_lines` voids and replaces lines, and the route called it with
 * `p_actor_user_id: null` — so every void recorded that "a terminal" did it and NO HUMAN AT ALL.
 * There was no permission on the action either: `orders:delete` existed, was granted to 15 role
 * rows on production, and was never checked anywhere. A permission nobody enforces is a label.
 *
 * ============================================================================================
 * THESE ASSERT CONDITIONS, NOT MARKER STRINGS
 * ============================================================================================
 *
 * A test that greps for `VOID_NEEDS_AUTHORIZATION` passes after the guard around it becomes
 * `if (false)` — the code is still sitting there in dead code. That mistake produced four defects
 * on 2026-09-05, every one of which looked covered. So the CONDITIONS are what is asserted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS } from '@/lib/permissions'
import { TERMINAL_AUTHORIZATION_PURPOSES, resolveTerminalAuthorizationPermission } from '@/lib/terminal-auth/purpose-permissions'
import { PERMISSION_GROUPS } from '@/lib/restaurant-roles/permission-labels'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '')

const AMEND = code(read('app', 'api', 'terminal', 'tabs', '[tabId]', 'amend', 'route.ts'))
const CHECK_MIG = sql(read('supabase', 'migrations', '20260906120000_authorization_purpose_line_void.sql'))
const REASON_MIG = sql(read('supabase', 'migrations', '20260906120100_order_line_events_void_reason.sql'))
const GRANT_MIG = sql(read('supabase', 'migrations', '20260906120200_grant_orders_void.sql'))
const ROLES = JSON.parse(read('lib', 'permissions', 'role-permissions.config.json'))

const at = (needle: string) => {
  const i = AMEND.indexOf(needle)
  expect(i).toBeGreaterThan(-1)
  return i
}

describe('the permission exists and is manager/owner only', () => {
  it('orders:void is defined', () => {
    expect(PERMISSIONS.ORDERS_VOID).toBe('orders:void')
  })

  it('owner and manager hold it; nobody else does', () => {
    expect(ROLES.owner).toContain('orders:void')
    expect(ROLES.manager).toContain('orders:void')
    for (const role of ['cashier', 'waiter', 'kitchen', 'bar']) {
      // The waiter who took the order is the one with a reason to remove it. A control they can
      // sign off themselves is not a control.
      expect(ROLES[role]).not.toContain('orders:void')
    }
  })

  it('the data migration grants it to exactly those two roles, idempotently', () => {
    // The config file only reaches NEWLY SEEDED venues; existing ones need this or authorize()
    // refuses the capability for everyone, owners included.
    expect(GRANT_MIG).toMatch(/array_append\(permissions, 'orders:void'\)/)
    expect(GRANT_MIG).toMatch(/role_slug IN \('manager', 'owner'\)/)
    // Without the containment test, re-running would duplicate the entry.
    expect(GRANT_MIG).toMatch(/NOT \(permissions @> ARRAY\['orders:void'\]::text\[\]\)/)
  })
})

describe('the line_void purpose reaches BOTH allow-lists', () => {
  it('the application maps line_void to orders:void', () => {
    expect(TERMINAL_AUTHORIZATION_PURPOSES.line_void).toBe(PERMISSIONS.ORDERS_VOID)
    expect(resolveTerminalAuthorizationPermission('line_void')).toBe('orders:void')
  })

  it('gates on orders:void, NOT orders:update', () => {
    // orders:update rides on the terminal's own JWT and every waiter holds it — gating there
    // would mean anyone who can ring a dish up can make it disappear.
    expect(TERMINAL_AUTHORIZATION_PURPOSES.line_void).not.toBe(PERMISSIONS.ORDERS_UPDATE)
  })

  it('the database CHECK carries EVERY existing value plus line_void', () => {
    /**
     * The constraint has been forgotten three times (service_session, menu_availability,
     * walkout_close). When it is, /api/terminal/authorize passes every application check and then
     * fails on the INSERT with a 23514 — a correct PIN, told authorization failed, every time.
     */
    for (const purpose of Object.keys(TERMINAL_AUTHORIZATION_PURPOSES)) {
      expect(CHECK_MIG).toContain(`'${purpose}'::text`)
    }
  })

  it('the two allow-lists agree exactly — neither has a value the other lacks', () => {
    const inSql = [...CHECK_MIG.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()
    const inApp = Object.keys(TERMINAL_AUTHORIZATION_PURPOSES).sort()
    expect(inSql).toEqual(inApp)
  })
})

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

describe('the permission is surfaced to whoever edits roles', () => {
  /**
   * THIS ORIGINALLY GREPPED THE LABELS FILE, AND THAT WAS THE SAME MISTAKE A FIFTH TIME.
   *
   * `expect(labels).toMatch(/PERMISSIONS\.ORDERS_VOID/)` passed on a permission that had a label
   * and appeared in NO PERMISSION GROUP — so the staff page never rendered a checkbox for it, and
   * nobody could grant or revoke a void from the UI at all. The string was present; the capability
   * was not. Asserted through the exported structure now, which is what the page actually renders.
   */
  it('is offered in the Orders group, so the staff page can grant it', () => {
    const orders = PERMISSION_GROUPS.find((g) => g.domain === 'Orders')
    expect(orders).toBeDefined()
    expect(orders!.permissions.map((p) => p.key)).toContain(PERMISSIONS.ORDERS_VOID)
  })

  it('carries text that says a PIN is needed, not a bare key', () => {
    // A checkbox reading "orders:void" tells an owner nothing about what they are handing out.
    const entry = PERMISSION_GROUPS.flatMap((g) => g.permissions).find(
      (p) => p.key === PERMISSIONS.ORDERS_VOID
    )
    expect(entry).toBeDefined()
    expect(entry!.label).not.toBe(PERMISSIONS.ORDERS_VOID)
    expect(entry!.label.length).toBeGreaterThan(0)
    expect(entry!.description).toMatch(/PIN/)
  })
})
