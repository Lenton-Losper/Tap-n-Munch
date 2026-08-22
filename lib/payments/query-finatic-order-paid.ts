import { queryPaymentOrder } from '@/payments/paycloud'

export type FinaticOrderPaidResult = {
  paid: boolean
  /**
   * Whether the gateway's status was a value we know how to read.
   *
   * `paid: false` alone cannot distinguish "the gateway told us it failed" from "the gateway said
   * something we have never seen". A caller that CANCELS on not-paid must check this first --
   * unknown never authorises a cancel. See the note at the assignment site.
   */
  statusRecognised: boolean
  merchantOrderNo: string
  status: string
  transactionId: string | null
  amount: number | null
  raw: Record<string, unknown>
}

/**
 * Finatic answered "no record of this merchant_order_no" (gateway code E04111).
 *
 * `queryPaymentOrder` throws a `PaycloudRequestError` with `phase: 'business'` for any
 * non-success `body.code`, so without this check E04111 is indistinguishable from a
 * network timeout at every catch site.
 *
 * IMPORTANT: this is NOT proof that no payment exists. E04111 is time-dependent -- order
 * #149 returned E04111 at 13:58:48 and was confirmed PAID on the same reference 22 seconds
 * later (docs/finatic-questions-for-vernon.md). It means "not registered at the gateway
 * *yet*". A single observation is never a terminal answer.
 */
export function isFinaticMerchantOrderInvalidError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    message?: unknown
    responseBody?: { code?: unknown; msg?: unknown } | null
  }
  const code = String(candidate.responseBody?.code ?? '').toUpperCase()
  const message = String(candidate.message ?? '').toUpperCase()
  return code === 'E04111' || message.includes('E04111')
}

/** Structural gateway code off a thrown PaycloudRequestError, for logs and audits. */
export function finaticErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as { responseBody?: unknown }).responseBody
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const code = (body as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase()
    if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  }
  return null
}

function toMoney(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

function parseOrderData(raw: Record<string, unknown>): Record<string, unknown> | null {
  let orderData: unknown = raw.data
  if (typeof orderData === 'string') {
    try {
      orderData = JSON.parse(orderData)
    } catch {
      return null
    }
  }
  if (orderData && typeof orderData === 'object' && !Array.isArray(orderData)) {
    return orderData as Record<string, unknown>
  }
  return null
}

/**
 * Query Finatic order.query and interpret paid / not-paid.
 * Shared by staff reconcile and terminal verify-payment.
 */
export async function queryFinaticOrderPaid(params: {
  merchantOrderNo: string
  merchantNo: string
  storeNo: string
}): Promise<FinaticOrderPaidResult> {
  const merchantOrderNo = params.merchantOrderNo.trim()
  const query = await queryPaymentOrder({
    orderId: merchantOrderNo,
    merchantNo: params.merchantNo,
    storeNo: params.storeNo,
  })
  const raw = (query.rawResponse || {}) as Record<string, unknown>
  const orderData = parseOrderData(raw)

  const transStatus = orderData?.trans_status ?? raw.trans_status
  const tradeOrStatus = String(
    orderData?.trade_status ?? orderData?.status ?? raw.trade_status ?? raw.status ?? '',
  ).toLowerCase()

  const paid =
    transStatus === 2 ||
    transStatus === '2' ||
    ['paid', 'success', 'succeeded'].includes(tradeOrStatus)

  /**
   * IS THIS A STATUS WE ACTUALLY RECOGNISE? Ruled 2026-08-22.
   *
   * `paid` is a boolean, so every value the gateway could ever return collapses into "not paid".
   * That is not safe in both directions: auto-cancel-stale-pos-orders.ts cancels an order outright
   * on `paid === false`, so a status nobody has ever seen would CANCEL A REAL CUSTOMER ORDER on a
   * card that may have cleared.
   *
   * NOBODY HAS THE ENUM. Measured 2026-08-21: no vendor documentation of `trans_status` exists on
   * either drive -- not in the Wise SDK javadocs (those are the on-device SDK, a different
   * surface), not in this repo, and the PayCloud REST reference directories are tracked but empty.
   * Across 43 live order.query calls spanning three restaurants and four weeks, exactly two values
   * were ever observed: 2 (paid, money fields populated) and 1 (failed, paid_amount "0", carrying
   * a trans_error_code). Everything else is unknown territory.
   *
   * So this reports whether the status was one we know how to read. `paid` keeps its exact meaning
   * -- this is additive, and no existing caller changes behaviour unless it opts in.
   *
   * Same asymmetry as the 2026-08-05 E04111 ruling: UNKNOWN NEVER AUTHORISES A CANCEL.
   */
  const RECOGNISED_PAID = [2, '2']
  const RECOGNISED_NOT_PAID = [1, '1']
  const RECOGNISED_TRADE_STATUS = ['paid', 'success', 'succeeded', 'failed', 'fail', 'closed']
  const statusRecognised =
    RECOGNISED_PAID.includes(transStatus as never) ||
    RECOGNISED_NOT_PAID.includes(transStatus as never) ||
    RECOGNISED_TRADE_STATUS.includes(tradeOrStatus)

  const statusText =
    tradeOrStatus ||
    (transStatus != null && String(transStatus).trim() ? String(transStatus) : 'unknown')

  const transactionId =
    String(
      orderData?.transactionID ??
        orderData?.transaction_id ??
        raw.psn ??
        raw.transaction_id ??
        '',
    ).trim() || null

  /**
   * paid_amount FIRST, and that ordering is the whole fix. Ruled 2026-08-22.
   *
   * This used to read `amount ?? order_amount ?? paid_amount`. Measured 2026-08-21: real
   * order.query responses carry NO `amount` key at all, so `order_amount` always won and
   * `paid_amount` was never reached.
   *
   * `order_amount` IS THE FIGURE WE SENT, echoed back. So every amountsMatch() gate downstream --
   * 24 call sites -- was comparing our own number against our own number. A gate that cannot fail.
   * On a real failed row (#563, N$25) the old expression extracted 25 from a transaction whose
   * paid_amount was "0".
   *
   * `paid_amount` is what the gateway says it actually took, which is what an amount gate is for.
   * Latent until now only because paid_amount == order_amount on all 13 paid rows measured; a tip,
   * a partial capture or an FX difference separates them and the gate silently passes the wrong
   * figure. order_amount is kept as a fallback for a response shape that omits paid_amount.
   */
  const amount = toMoney(
    orderData?.paid_amount ??
      orderData?.amount ??
      orderData?.order_amount ??
      raw.paid_amount ??
      raw.amount ??
      raw.order_amount,
  )

  return {
    paid,
    statusRecognised,
    merchantOrderNo,
    status: statusText,
    transactionId,
    amount,
    raw,
  }
}
