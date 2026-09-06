/**
 * `orders:void` AND THE `line_void` PURPOSE — THE DEFINITION HALF.
 *
 * ============================================================================================
 * WHAT WAS WRONG BEFORE
 * ============================================================================================
 *
 * Taking food off a bill needed nothing: any waiter, no PIN, no reason, and `amend_order_lines`
 * was called with `p_actor_user_id: null` so the record named NO HUMAN AT ALL. There was a
 * permission called `orders:delete` — granted to 15 role rows on production and never checked
 * anywhere. A permission nobody enforces is a label.
 *
 * ============================================================================================
 * THIS FILE COVERS THE PARTS THAT ARE INERT ON THEIR OWN
 * ============================================================================================
 *
 * The permission, the purpose mapping, the grant, the CHECK, the reason column, the staff page.
 * NONE of it changes the behaviour of any request until the amend route gates on it — which is
 * exactly why this half could ship on 2026-09-06 while the route half waited for a terminal
 * build that knows to ask for a PIN.
 *
 * THE ROUTE HALF IS IN __tests__/void-gate.test.ts, and ships with it.
 *
 * ============================================================================================
 * THESE ASSERT CONDITIONS, NOT MARKER STRINGS
 * ============================================================================================
 *
 * A test that greps a file for a name passes when the name is present and the capability is not.
 * That mistake produced five defects on 2026-09-05 and 09-06, the last of them a permission with
 * a perfectly good label that no page offered. So the CONDITIONS are what is asserted.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS } from '@/lib/permissions'
import { TERMINAL_AUTHORIZATION_PURPOSES, resolveTerminalAuthorizationPermission } from '@/lib/terminal-auth/purpose-permissions'
import { PERMISSION_GROUPS } from '@/lib/restaurant-roles/permission-labels'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '')

const CHECK_MIG = sql(read('supabase', 'migrations', '20260906120000_authorization_purpose_line_void.sql'))

/**
 * THE CONSTRAINT AS IT ENDS UP, WHICH IS THE LATEST purpose migration — NOT THIS ONE.
 *
 * Each of these migrations DROPs the constraint by name and rebuilds it whole, so the live
 * allow-list is whatever the highest-versioned one says. Asserting the application map against
 * THIS file's snapshot was right until a seventh purpose was added, at which point it failed on
 * correct code: 20260906120000 has no reason to know about `cash_up`.
 *
 * Reading the newest by filename is what makes this invariant survive the next purpose. A test
 * that has to be edited every time somebody adds one is a test that gets edited without being
 * read.
 */
const LATEST_PURPOSE_MIG = sql(
  read(
    'supabase',
    'migrations',
    readdirSync(join(ROOT, 'supabase', 'migrations'))
      .filter((f) => /_authorization_purpose_.*\.sql$/.test(f))
      .sort()
      .at(-1)!,
  ),
)
const REASON_MIG = sql(read('supabase', 'migrations', '20260906120100_order_line_events_void_reason.sql'))
const GRANT_MIG = sql(read('supabase', 'migrations', '20260906120200_grant_orders_void.sql'))
const ROLES = JSON.parse(read('lib', 'permissions', 'role-permissions.config.json'))

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
    // line_void is THIS migration's own subject, so it is asserted here...
    expect(CHECK_MIG).toContain(`'line_void'::text`)
    // ...and the full agreement is asserted against the constraint as it actually ends up.
    for (const purpose of Object.keys(TERMINAL_AUTHORIZATION_PURPOSES)) {
      expect(LATEST_PURPOSE_MIG).toContain(`'${purpose}'::text`)
    }
  })

  it('the two allow-lists agree exactly — neither has a value the other lacks', () => {
    const inSql = [...LATEST_PURPOSE_MIG.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()
    const inApp = Object.keys(TERMINAL_AUTHORIZATION_PURPOSES).sort()
    expect(inSql).toEqual(inApp)
  })
})

describe('the reason column, which ships before anything writes to it', () => {
  it('is added to order_line_events — the FULFILMENT record', () => {
    expect(REASON_MIG).toMatch(/ALTER TABLE public\.order_line_events/)
    expect(REASON_MIG).toMatch(/ADD COLUMN IF NOT EXISTS void_reason text/)
  })

  it('never touches order_lines.line_note', () => {
    /**
     * That column is the KITCHEN PREP NOTE, and amend_order_lines COPIES it onto the replacement
     * line — a void reason there would reach a chef on the next amendment of the same dish.
     *
     * ASSERTED AS "NOT WRITTEN", NOT "NOT MENTIONED". The migration's COMMENT ON COLUMN names
     * line_note deliberately, to tell the next reader why it is the wrong home; a blunt
     * `not.toMatch(/line_note/)` failed on that documentation, which is exactly the sentence worth
     * keeping. Forbidding the note that makes the rule findable is backwards.
     */
    expect(REASON_MIG).not.toMatch(/ALTER TABLE\s+(public\.)?order_lines/i)
    expect(REASON_MIG).not.toMatch(/^\s*(ADD|ALTER|DROP)\s+COLUMN[^;]*line_note/im)
  })

  it('is nullable, because most events are not voids', () => {
    // And because it ships EMPTY: nothing writes to it until the route half lands, so NOT NULL
    // would refuse every ordinary line event from the moment this migration applied.
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
