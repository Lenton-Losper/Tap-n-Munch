export type OrderStatusKey =
  | 'pending'
  | 'accepted'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

export type ReceiptStatusBadge = 'NEW ORDER' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED'

export type PaymentStatusKey = 'paid' | 'pending' | 'failed' | 'cancelled' | string

export type ReceiptLineItem = {
  quantity: number
  name: string
  subtotal: number
}

export function formatReceiptDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date} • ${time}`
}

export function formatCurrency(amount: number, currency = 'NAD'): string {
  const code = currency.replace(/\$/g, '').trim() || 'NAD'
  return `${code} ${amount.toFixed(2)}`
}

export function mapOrderStatusToBadge(status: OrderStatusKey): {
  label: ReceiptStatusBadge
  description: string
} {
  switch (status) {
    case 'pending':
      return {
        label: 'NEW ORDER',
        description: 'Your order has been received and sent to the restaurant.',
      }
    case 'accepted':
      return {
        label: 'ACCEPTED',
        description: 'The kitchen has accepted your order.',
      }
    case 'ready':
      return {
        label: 'PREPARING',
        description: 'Your order is being prepared.',
      }
    case 'ready_for_terminal':
      return {
        label: 'READY',
        description: 'Staff have been notified to bring the card machine to your table.',
      }
    case 'completed':
      return {
        label: 'COMPLETED',
        description: 'Thank you for your order!',
      }
    case 'cancelled':
      return {
        label: 'CANCELLED',
        description: 'This order has been cancelled.',
      }
    default:
      return {
        label: 'NEW ORDER',
        description: 'Your order is being processed.',
      }
  }
}

export function normalizePaymentMethod(method: string): 'Card' | 'Cash' | 'Wallet' | 'Other' | string {
  const m = String(method || '').toLowerCase()
  if (m === 'cash') return 'Cash'
  if (m === 'wallet') return 'Wallet'
  if (m === 'other') return 'Other'
  if (m === 'card') return 'Card'
  return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Card'
}

export function normalizePaymentStatus(status: string): 'Paid' | 'Pending' | 'Failed' | string {
  const s = String(status || '').toLowerCase()
  if (s === 'paid') return 'Paid'
  if (s === 'failed' || s === 'cancelled') return 'Failed'
  return 'Pending'
}
