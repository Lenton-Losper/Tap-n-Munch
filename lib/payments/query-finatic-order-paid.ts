import { queryPaymentOrder } from '@/payments/paycloud'

export type FinaticOrderPaidResult = {
  paid: boolean
  merchantOrderNo: string
  status: string
  transactionId: string | null
  amount: number | null
  raw: Record<string, unknown>
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

  const amount = toMoney(
    orderData?.amount ??
      orderData?.order_amount ??
      orderData?.paid_amount ??
      raw.amount ??
      raw.order_amount ??
      raw.paid_amount,
  )

  return {
    paid,
    merchantOrderNo,
    status: statusText,
    transactionId,
    amount,
    raw,
  }
}
