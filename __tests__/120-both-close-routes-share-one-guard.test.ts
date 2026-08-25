import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * #120 — THE TWO CLOSE ROUTES MUST NOT BE ABLE TO DISAGREE.
 *
 * The original defect was not "the dashboard forgot a check". It was that the terminal and the
 * dashboard do ONE job through TWO routes, and the rule about what blocks a close was written
 * inside one of them. That shape guarantees drift: the day someone tightens one, the other keeps
 * the old behaviour, and nobody finds out until a bill is wrong.
 *
 * So the assertion is not "both routes have a guard" — that is satisfiable by two copies that
 * disagree, which is exactly the state this is fixing. It is "NEITHER route contains the rule".
 *
 * Source-text assertions on purpose: what regressed is which module owns the decision, and that is
 * a property of the source, not of a response.
 */
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const TERMINAL_CLOSE = 'app/api/terminal/tables/[tableId]/close/route.ts'
const DASHBOARD_CLOSE = 'app/api/tables/[tableNumber]/close/route.ts'
const SHARED = 'lib/tabs/pending-order-requests.ts'

const TERMINAL_RELEASE = 'app/api/terminal/order-requests/[requestId]/release/route.ts'
const DASHBOARD_RELEASE = 'app/api/order-requests/[requestId]/release/route.ts'
const SHARED_RELEASE = 'lib/order-requests/release-stranded-claim.ts'

/** Comments quote the rule they describe; only code decides anything. */
const codeOf = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('both close routes call the shared guard', () => {
  it.each([TERMINAL_CLOSE, DASHBOARD_CLOSE])('%s calls guardTableClose', (file) => {
    expect(codeOf(file)).toMatch(/guardTableClose\(/)
  })

  it.each([TERMINAL_CLOSE, DASHBOARD_CLOSE])(
    '%s does NOT re-implement the rule — it must not decide for itself',
    (file) => {
      const code = codeOf(file)
      // The three moving parts of the decision. Any of them appearing in a ROUTE means that route
      // can now disagree with its sibling, which is the defect, not a style preference.
      expect(code).not.toMatch(/\bblocksSettlement\b/)
      expect(code).not.toMatch(/\bsummarisePendingForTab\b/)
      expect(code).not.toMatch(/\bfetchPendingOrderRequests\b/)
      expect(code).not.toMatch(/PENDING_ORDER_REQUESTS/)
    },
  )

  it('the rule really does live in the shared module — CONTROL for the negatives above', () => {
    // Without this, those `not.toMatch` assertions would pass just as happily if the guard had been
    // deleted from the codebase entirely.
    const shared = codeOf(SHARED)
    expect(shared).toMatch(/export async function guardTableClose/)
    expect(shared).toMatch(/\bblocksSettlement\b/)
    expect(shared).toMatch(/PENDING_ORDER_REQUESTS/)
    expect(shared).toMatch(/PENDING_REQUEST_CHECK_FAILED/)
  })

  it('the guard fails CLOSED: an unreadable tabs list is not an empty one', () => {
    const shared = codeOf(SHARED)
    // 503 on a failed read, never a silent pass-through to the close.
    expect(shared).toMatch(/status:\s*503/)
    expect(shared).toMatch(/tabsError/)
  })

  it('the blocked payload carries per-row status, so a caller can tell the two states apart', () => {
    expect(codeOf(SHARED)).toMatch(/status:\s*r\.status/)
  })
})

describe('both release routes call the shared rule', () => {
  it.each([TERMINAL_RELEASE, DASHBOARD_RELEASE])('%s calls releaseStrandedClaim', (file) => {
    expect(codeOf(file)).toMatch(/releaseStrandedClaim\(/)
  })

  it.each([TERMINAL_RELEASE, DASHBOARD_RELEASE])(
    '%s does NOT decide what may be released or what it becomes',
    (file) => {
      const code = codeOf(file)
      // A route that names either status is a route that can drift from its sibling.
      expect(code).not.toMatch(/'waiting_review'/)
      expect(code).not.toMatch(/'accepting'/)
      expect(code).not.toMatch(/from\('order_requests'\)/)
    },
  )

  it('the release rule lives in the shared module — CONTROL', () => {
    const shared = codeOf(SHARED_RELEASE)
    expect(shared).toMatch(/export async function releaseStrandedClaim/)
    expect(shared).toMatch(/RELEASED_TO_STATUS = 'waiting_review'/)
    expect(shared).toMatch(/STRANDED_CLAIM_STATUS = 'accepting'/)
    // The conditional claim, which is the whole safety of the operation.
    expect(shared).toMatch(/\.eq\('status', STRANDED_CLAIM_STATUS\)/)
  })

  it('releases to waiting_review and NEVER to accepted or declined', () => {
    const shared = codeOf(SHARED_RELEASE)
    expect(shared).toMatch(/RELEASED_TO_STATUS = 'waiting_review'/)
    expect(shared).not.toMatch(/RELEASED_TO_STATUS = 'accepted'/)
    expect(shared).not.toMatch(/RELEASED_TO_STATUS = 'declined'/)
  })
})

describe('the two surfaces differ ONLY in authentication', () => {
  it('the terminal routes authenticate as a terminal', () => {
    expect(codeOf(TERMINAL_CLOSE)).toMatch(/requireTerminalAuth/)
    expect(codeOf(TERMINAL_RELEASE)).toMatch(/requireTerminalAuth/)
  })

  it('the dashboard routes authenticate as staff, on the permission that gates closing', () => {
    for (const file of [DASHBOARD_CLOSE, DASHBOARD_RELEASE]) {
      const code = codeOf(file)
      expect(code).toMatch(/requireStaffPermission/)
      expect(code).toMatch(/TABLES_MANAGE/)
    }
  })

  it('CONTROL: the four routes are distinct files that all still exist', () => {
    const files = [TERMINAL_CLOSE, DASHBOARD_CLOSE, TERMINAL_RELEASE, DASHBOARD_RELEASE]
    expect(new Set(files).size).toBe(4)
    for (const f of files) expect(read(f).length).toBeGreaterThan(200)
  })
})
