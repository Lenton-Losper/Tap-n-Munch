export type RefundMethod = 'cash' | 'card'

export type CreateRefundInput = {
  orderId: string
  paymentId: string
  amount: number
  reason?: string
  refundMethod?: RefundMethod
  /** Required for cash refunds (client idempotency). */
  requestId?: string
  /** Required for card refunds (gateway reversal reference). */
  gatewayReference?: string | null
}

export type CreateRefundResult = {
  refundId: string
  orderId: string
  paymentId: string
  amount: number
  reason: string | null
  refundMethod: RefundMethod
  gatewayReference: string | null
  paymentAmount: number
  totalRefunded: number
  remainingRefundable: number
  alreadyProcessed: boolean
}
