/**
 * #223 + #268 — the CALL SITE, not the derivation.
 *
 * `paid-audit-records-whose-figure.test.ts` already proves the derivation seven ways:
 * `amountMeaning` is `'gateway_reported'` when `gatewayAmount` is passed, `'order_total'` when it
 * is not, a mismatch stays visible, and a gateway that reported 0 is distinguished from a caller
 * that had no figure. **Every one of those would stay green if the stale-POS cron stopped passing
 * the argument**, because they call `markOrderPaidConfirmed` directly.
 *
 * That is the gap this file closes, and it is the reason the 2026-08-17 conflict needed a ruling.
 * `gatewayAmount` is OPTIONAL on `MarkOrderPaidConfirmedParams`, so dropping it from the cron
 * COMPILES, `tsc` is silent, no existing test moves, and the payment audit trail then records
 * `amountMeaning: 'order_total'` for a figure that came from the gateway. A false statement about
 * provenance in the ledger — the #306 class, one layer down.
 *
 * WHAT THIS CAN AND CANNOT SEE. It reads shipped source, in the shape
 * `edit-emptiness-call-sites.test.ts` established, because a test bound to the shared rule cannot
 * see whether anything calls it (#232) and `tsc` cannot either. It proves the argument is passed
 * and that `amount` is the gateway figure rather than the order-total fallback. It does NOT
 * execute the cron — the behavioural proof that the gate fires is
 * `exploiter-223-original-repro.test.ts`, which was verified to FAIL with the quarantine removed.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const CRON = join(process.cwd(), 'lib', 'orders', 'auto-cancel-stale-pos-orders.ts')
const MARK = join(process.cwd(), 'lib', 'payments', 'mark-order-paid-confirmed.ts')

/**
 * Comments stripped. Load-bearing here specifically: the resolution's own docblock QUOTES
 * `finaticResult.amount ?? Number(order.total)` while explaining why it was removed, so a
 * `not.toContain` assertion run against raw source would match the comment describing the fix and
 * report the defect it was written to prevent.
 */
const codeOnly = (s: string) =>
  s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const cron = codeOnly(readFileSync(CRON, 'utf8'))
const mark = codeOnly(readFileSync(MARK, 'utf8'))

describe('the stale-POS cron tells the truth about whose figure it wrote', () => {
  it('found real files, so an empty scan cannot report green', () => {
    expect(cron).toContain('markOrderPaidConfirmed')
    expect(mark).toContain('amountMeaning')
    // The comment stripper must actually strip, or every assertion below is measuring prose.
    expect(codeOnly("// amount: finaticResult.amount ?? Number(order.total)\nconst a = 1")).not.toContain(
      'finaticResult.amount ??',
    )
  })

  it('passes gatewayAmount as a first-class argument, not only as audit metadata', () => {
    // The whole point. `amountMeaning` is derived from the PARAMETER, before
    // `...extraAuditMetadata` is spread, so burying the figure in extraAuditMetadata would record
    // the number and still lie about where it came from.
    const call = cron.slice(cron.indexOf('markOrderPaidConfirmed(supabase, {'))
    const args = call.slice(0, call.indexOf('extraAuditMetadata'))
    expect(args).toMatch(/^\s*gatewayAmount,\s*$/m)
  })

  it('writes the gateway figure as the amount, never the order-total fallback', () => {
    expect(cron).toMatch(/amount:\s*gatewayAmount\s*,/)
    // #223: this is the exact expression that marked an N$200 order paid on a confirmed N$20
    // payment. It must not come back, in this file, in any form.
    expect(cron).not.toContain('finaticResult.amount ?? Number(order.total)')
    expect(cron).not.toMatch(/amount:\s*finaticResult\.amount\s*\?\?/)
  })

  it('only reaches that write on the agreeing path, so the amount cannot disagree', () => {
    // Without the quarantine, `amount: gatewayAmount` alone would write an unagreed figure -- a
    // different defect wearing the fix's clothes.
    expect(cron).toMatch(/const amountAgrees\s*=/)
    expect(cron).toMatch(/if \(!amountAgrees\)/)
    expect(cron).toContain('holdForAmountReview')
    expect(cron).toContain('GATEWAY_AMOUNT_TOLERANCE_CENTS')
    // The quarantine must come BEFORE the paid write, or it quarantines nothing.
    expect(cron.indexOf('if (!amountAgrees)')).toBeLessThan(cron.indexOf('amount: gatewayAmount'))
  })

  it('still derives amountMeaning from the parameter, ahead of the metadata spread', () => {
    expect(mark).toMatch(/amountMeaning:\s*gatewayAmount != null \? 'gateway_reported' : 'order_total'/)
    // If extraAuditMetadata were spread first, a caller could overwrite the provenance claim.
    expect(mark.indexOf('amountMeaning:')).toBeLessThan(mark.indexOf('...extraAuditMetadata'))
  })
})
