import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * THE #868 ROOT CAUSE: `success` meant three different things.
 *
 * On 2026-08-21 the reader reported FNB ChowNow order #868 as DECLINED. The server could not
 * confirm that against Finatic, correctly left the order `pending` — and answered **`success:
 * true`**, the same value it returns for `corrected_to_paid` (payment confirmed) and for
 * `cancelled` (payment definitively not taken). N$33 of food was released on a payment that never
 * cleared.
 *
 * WHAT THIS FILE PINS. Not the money logic — that is unchanged and is covered by
 * terminal-payment-failed-amount-guard and terminal-user-cancel-bypass. This pins the CONTRACT: an
 * unresolved outcome must not claim success, and a client reading only the response body must be
 * able to tell the three states apart.
 *
 * ASSERTED AGAINST SOURCE. Both routes need a terminal JWT, a Supabase client and a live Finatic
 * seam to exercise end-to-end; the thing worth pinning is the literal shape each branch returns.
 * Comments are stripped first — the docblocks in those routes quote the old `success: true` while
 * explaining why it was wrong, and a scan that matched its own explanation would pass forever.
 */
export {} // module scope

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const PAYMENT = strip(read('app/api/terminal/orders/[orderId]/payment/route.ts'))
const STATUS = strip(read('app/api/terminal/orders/[orderId]/status/route.ts'))

/** The literal object a branch returns, so assertions are about that branch and not the file. */
function branchBody(code: string, outcome: string): string {
  const marker = `outcome: '${outcome}'`
  const at = code.indexOf(marker)
  if (at === -1) throw new Error(`no branch returning outcome '${outcome}'`)
  const open = code.lastIndexOf('NextResponse.json({', at)
  if (open === -1) throw new Error(`no NextResponse.json before outcome '${outcome}'`)
  return code.slice(open, code.indexOf('})', at) + 2)
}

describe.each([
  ['payment route', PAYMENT],
  ['status route', STATUS],
])('%s — the success contract', (_name, code) => {
  it('an UNCERTAIN outcome does not claim success', () => {
    const body = branchBody(code, 'left_pending_finatic_uncertain')
    expect(body).toMatch(/success:\s*false/)
    expect(body).not.toMatch(/success:\s*true/)
  })

  it('a CONFIRMED PAID outcome still claims success', () => {
    // The fix must not swing the other way: correcting a false failure to paid IS a resolution.
    const body = branchBody(code, 'corrected_to_paid')
    expect(body).toMatch(/success:\s*true/)
  })

  it('a CANCELLED outcome still claims success', () => {
    // Definitively not taken is also a resolution — the order reached a terminal state.
    const body = branchBody(code, 'cancelled')
    expect(body).toMatch(/success:\s*true/)
  })

  /**
   * The two-sided proof the ruling asked for: a client that reads ONLY the response body can tell
   * an uncertain outcome from a confirmed-paid one. Two independent fields now disagree between
   * them, so a client branching on either is correct.
   */
  it('uncertain and confirmed-paid are distinguishable from the body alone', () => {
    const uncertain = branchBody(code, 'left_pending_finatic_uncertain')
    const paid = branchBody(code, 'corrected_to_paid')

    // 1. success differs — the field a client naively branches on.
    expect(uncertain).toMatch(/success:\s*false/)
    expect(paid).toMatch(/success:\s*true/)

    // 2. outcome differs — the precise discriminator, for a client that enumerates states.
    expect(uncertain).toContain("outcome: 'left_pending_finatic_uncertain'")
    expect(paid).toContain("outcome: 'corrected_to_paid'")

    // 3. and the bodies are not accidentally identical.
    expect(uncertain).not.toEqual(paid)
  })

  it('the uncertain branch carries a reason, so the client can say WHY', () => {
    expect(branchBody(code, 'left_pending_finatic_uncertain')).toMatch(/reason:/)
  })
})

describe('the stale comment that hid this', () => {
  it('no longer claims the cron will resolve these', () => {
    // The comment said "Do not cancel; cron with verifyWithFinatic will resolve later." It cannot:
    // auto-cancel-stale-pos-orders partitions on paycloud_merchant_order_no, and an order WITH a
    // reference goes to the Finatic branch, answers E04111, and is skipped every run forever.
    // A stale comment promising a later fix is how this stayed invisible, so it is asserted gone.
    const raw = read('app/api/terminal/orders/[orderId]/payment/route.ts')
    expect(raw).not.toMatch(/cron with verifyWithFinatic will resolve later/)
  })
})
