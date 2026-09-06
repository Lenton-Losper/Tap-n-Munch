/**
 * EVERY TERMINAL ROUTE MUST REQUIRE A PERMISSION THE TERMINAL TOKEN CAN ACTUALLY CARRY.
 *
 * ================================================================================================
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 * ================================================================================================
 *
 * On 2026-09-08, prepare-split-payment and record-split-payment shipped to production gated on
 * `payments:process`. Terminal tokens carry exactly three permissions -- `orders:read`,
 * `orders:update`, `tables:read` -- spread literally out of TERMINAL_JWT_PERMISSIONS by
 * signTerminalJwt with no per-restaurant, per-terminal or per-role variation. So the gate could
 * never open. Not for the venue that reported it, not for any venue: split card was unreachable
 * for every device in the estate the moment it shipped.
 *
 * `payments:process` is a USER-ROLE permission (owner, manager, cashier). A terminal JWT is a
 * DEVICE identity. Requiring one of the other is not a tuning mistake, it is a category error, and
 * nothing in the codebase noticed because every route suite mocks requireTerminalAuth and hands
 * itself whatever permission list makes its own tests pass. A fabricated token cannot disagree
 * with the route it was fabricated for.
 *
 * So this test reads the SOURCE, not a mock.
 *
 * ================================================================================================
 * WHY IT IS WRITTEN AGAINST THE FILES AND NOT THE HANDLERS
 * ================================================================================================
 *
 * Importing the routes is not an option -- several pull in `jose`, which is ESM-only and cannot be
 * loaded under ts-jest here. More importantly, executing a handler would only tell us what one
 * fabricated request does. The question is a static one: does any route on disk name a permission
 * the signer cannot mint? That is answerable by reading, and only by reading.
 *
 * ================================================================================================
 * BOTH CONTROLS, BECAUSE THIS IS AN "ALL CLEAR" TEST
 * ================================================================================================
 *
 * A checker that finds nothing passes just as quietly as one that works: point the regex slightly
 * wrong and every route is clean forever. Two controls run before any verdict is trusted --
 *
 *   POSITIVE  it must find gates in files known to have them, and a plausible total. If the
 *             extractor silently matches nothing, that is a failure, not a pass.
 *   NEGATIVE  a synthetic route body naming a permission outside the token must be REJECTED by the
 *             same predicate the real check uses. If the rule cannot fail, it cannot pass.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const TERMINAL_ROUTES_DIR = join(process.cwd(), 'app', 'api', 'terminal')
const SIGNER = join(process.cwd(), 'lib', 'terminals', 'terminal-jwt.ts')

/**
 * The permissions a terminal token can ever hold, PARSED OUT OF THE SIGNER'S SOURCE.
 *
 * Not imported. lib/terminals/terminal-jwt.ts pulls in `jose`, which is ESM-only and cannot be
 * loaded under ts-jest here -- the same wall that stops the terminal-auth route suites importing
 * their own handlers.
 *
 * Reading the source is the better answer anyway, not a workaround. This whole suite exists
 * because a MOCKED permission list agreed with the route that fabricated it. Deriving the truth
 * from the file that defines it keeps one source and no second statement of the list to drift.
 *
 * A FAILED PARSE FAILS LOUD. An empty set makes every gate in the codebase an offender, so a
 * broken regex is a wall of failures rather than a silent all-clear. The control below pins the
 * parsed contents so garbage cannot masquerade as a valid parse either.
 */
function mintablePermissions(): string[] {
  const src = readFileSync(SIGNER, 'utf8')
  const block = /export const TERMINAL_JWT_PERMISSIONS\s*=\s*\[([\s\S]*?)\]/.exec(src)
  if (!block) return []
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const MINTABLE_LIST = mintablePermissions()
const MINTABLE = new Set<string>(MINTABLE_LIST)

type Gate = { file: string; permission: string; line: number }

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full))
    } else if (name === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

/**
 * Every `terminal.permissions.includes('x')` in a file.
 *
 * Deliberately anchored on `permissions.includes(` rather than on a bare quoted string: matching
 * any `'orders:update'` anywhere would sweep up comments and doc blocks, and a checker that reads
 * prose as code is how a mutation lands on a comment and reports a false green.
 */
function gatesIn(file: string): Gate[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out: Gate[] = []
  lines.forEach((text, i) => {
    // Skip comment lines outright -- a permission NAMED in prose is not a permission REQUIRED.
    const trimmed = text.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    const re = /permissions\s*\.\s*includes\(\s*'([^']+)'\s*\)/g
    let m
    while ((m = re.exec(text))) {
      out.push({ file, permission: m[1], line: i + 1 })
    }
  })
  return out
}

const files = routeFiles(TERMINAL_ROUTES_DIR)
const gates = files.flatMap(gatesIn)
const rel = (f: string) => f.slice(process.cwd().length + 1).split('\\').join('/')

describe('the checker can actually see', () => {
  it('finds terminal route files at all', () => {
    // If this directory walk breaks, every assertion below passes on an empty list.
    expect(files.length).toBeGreaterThan(20)
  })

  it('POSITIVE CONTROL: it finds gates, in plausible numbers', () => {
    expect(gates.length).toBeGreaterThan(15)
  })

  it('POSITIVE CONTROL: it finds the gate on a route known to have one', () => {
    /**
     * A named anchor, so "the extractor found 20 things" cannot be satisfied by 20 wrong things.
     * settle is the whole-order card path -- the route that takes real card money -- and it is the
     * comparator the split-card gate should have been copied from in the first place.
     */
    const settle = gates.filter((g) => g.file.includes('settle') && !g.file.includes('allocations'))
    expect(settle.length).toBeGreaterThan(0)
    expect(settle.map((g) => g.permission)).toContain('orders:update')
  })

  it('NEGATIVE CONTROL: the rule rejects a permission outside the token', () => {
    /**
     * The rule must be capable of failing. `payments:process` is the real one that shipped, so it
     * is the one used here -- if this ever starts passing, the token has been widened and this
     * whole suite needs re-reading rather than deleting.
     */
    expect(MINTABLE.has('payments:process')).toBe(false)
    expect(MINTABLE.has('menu:write')).toBe(false)
    expect(MINTABLE.has('reports:cash_up')).toBe(false)
  })

  it('NEGATIVE CONTROL: the extractor reads code, not comments', () => {
    // A permission named in a doc block is not a permission required. If prose counted, every file
    // explaining this defect would itself trip the check.
    const commentOnly = [
      '/**',
      " * Gated on orders:update. Introducing terminal.permissions.includes('payments:hold') would",
      ' * refuse every device in the field.',
      ' */',
      "// if (!terminal.permissions.includes('payments:refund')) {}",
      'const x = 1',
    ].join('\n')

    const tmp = join(process.cwd(), '__tests__', '.tmp-comment-probe.ts')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writeFileSync, unlinkSync } = require('fs')
    writeFileSync(tmp, commentOnly, 'utf8')
    try {
      expect(gatesIn(tmp)).toEqual([])
    } finally {
      unlinkSync(tmp)
    }
  })
})

describe('THE INVARIANT: no terminal route may require a permission the signer cannot mint', () => {
  it('every gate names a permission in TERMINAL_JWT_PERMISSIONS', () => {
    /**
     * WHAT A FAILURE HERE MEANS. The route is not "too strict" -- it is UNREACHABLE. Every terminal
     * in the estate gets a 403 forever, and because the refusal looks like an ordinary permission
     * error rather than a wiring fault, it reads as a venue configuration problem and gets
     * diagnosed at the wrong end.
     *
     * THE FIX IS ALMOST NEVER TO WIDEN THE TOKEN. Adding a permission to TERMINAL_JWT_PERMISSIONS
     * grants it to every device in the field, takes effect silently on the next refresh at venues
     * that never asked for it, and refuses every device until that refresh happens. Two recorded
     * rulings say so -- lib/terminal-auth/purpose-permissions.ts and
     * app/api/terminal/held-payments/route.ts. Either reuse a permission the device already holds,
     * or require a named human through the authorization-token mechanism.
     */
    const offenders = gates
      .filter((g) => !MINTABLE.has(g.permission))
      .map((g) => `${rel(g.file)}:${g.line} requires '${g.permission}'`)

    expect(offenders).toEqual([])
  })

  it('the two split-card routes specifically', () => {
    /**
     * Named rather than left to the sweep above, because these are the two that shipped broken and
     * a regression here has a customer standing at the table with a card in their hand.
     */
    for (const name of ['prepare-split-payment', 'record-split-payment']) {
      const forRoute = gates.filter((g) => g.file.includes(name))
      expect({ name, gates: forRoute.map((g) => g.permission) }).toEqual({
        name,
        gates: ['orders:update'],
      })
    }
  })

  it('the token itself is still the three it has always been', () => {
    /**
     * Pinned so that widening the token is a DECISION somebody makes on purpose and defends here,
     * rather than the quiet way a future route makes its own gate pass.
     *
     * It doubles as the parser's control: if the regex above ever returns garbage or nothing, this
     * fails with the parsed contents in the message rather than letting an empty set through.
     */
    expect([...MINTABLE_LIST].sort()).toEqual(['orders:read', 'orders:update', 'tables:read'])
  })
})
