export type AmendmentAction = 'removed' | 'added' | 'quantity_changed' | 'discount_applied'

export type StockAction = 'reversed' | 'waste' | 'none'

export type AmendmentChangeInput = {
  item_id: string
  action: AmendmentAction
  quantity_delta?: number
  price_delta?: number
  reason?: string
}

export type ResolvedAmendmentChange = AmendmentChangeInput & {
  stock_action: StockAction
}

export type AmendOrderInput = {
  orderId: string
  changes: AmendmentChangeInput[]
  reason?: string
}

export type AmendOrderResult = {
  revisionId: string
  revisionNumber: number
  financialDelta: number
  changes: ResolvedAmendmentChange[]
  order: {
    id: string
    subtotal: number
    total: number
    items: unknown[]
    status: string
    payment_status: string
  }
}
