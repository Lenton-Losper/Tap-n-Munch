import { Ticket } from 'lucide-react'
import { cn } from '@/lib/utils'

import type { CustomerOrderState } from '@/lib/orders/customer-status'

/**
 * #309: keyed by the SHARED customer state, not by a private label string.
 *
 * It used to be `Record<ReceiptStatusBadge, ...>` with `?? STYLES['NEW ORDER']` as its fallback,
 * so an unrecognised label was drawn in the brand-new-order colour. Keying by the state makes the
 * record exhaustive over a closed union - a state added to CUSTOMER_ORDER_STATES fails the build
 * here rather than silently rendering green.
 */
const STYLES: Record<CustomerOrderState, { wrap: string; icon: string; label: string }> = {
  waiting: { wrap: 'bg-purple-50 border-purple-100', icon: 'text-purple-600', label: 'text-purple-800' },
  accepted: { wrap: 'bg-blue-50 border-blue-100', icon: 'text-blue-600', label: 'text-blue-800' },
  preparing: { wrap: 'bg-sky-50 border-sky-100', icon: 'text-sky-600', label: 'text-sky-800' },
  ready: { wrap: 'bg-emerald-50 border-emerald-100', icon: 'text-emerald-600', label: 'text-emerald-800' },
  paid: { wrap: 'bg-green-50 border-green-100', icon: 'text-green-600', label: 'text-green-800' },
  /**
   * THE FOUR THAT REPLACED `needs_you`, and they are not one colour.
   *
   * A refusal, a cancellation, an order waiting at the terminal and a failed card were all red
   * because they were all one state. Only the last is a PROBLEM the customer must act on; the
   * middle two are neutral facts about an order that is over, and `awaiting_payment` is a
   * perfectly normal step. Colouring them alike is how the badge came to read as an alarm.
   */
  declined: { wrap: 'bg-stone-50 border-stone-200', icon: 'text-stone-500', label: 'text-stone-700' },
  cancelled: { wrap: 'bg-stone-50 border-stone-200', icon: 'text-stone-500', label: 'text-stone-700' },
  awaiting_payment: { wrap: 'bg-amber-50 border-amber-100', icon: 'text-amber-600', label: 'text-amber-800' },
  payment_failed: { wrap: 'bg-red-50 border-red-100', icon: 'text-red-600', label: 'text-red-800' },
  unknown: { wrap: 'bg-slate-50 border-slate-200', icon: 'text-slate-500', label: 'text-slate-700' },
}

export type StatusBadgeProps = {
  label: string
  state: CustomerOrderState
  className?: string
}

export function StatusBadge({ label, state, className }: StatusBadgeProps) {
  const style = STYLES[state]
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 flex items-start gap-3',
        style.wrap,
        className
      )}
    >
      <Ticket className={cn('h-5 w-5 shrink-0 mt-0.5', style.icon)} aria-hidden />
      <div className="text-left min-w-0">
        <p className={cn('text-sm font-bold tracking-wide', style.label)}>{label}</p>
      </div>
    </div>
  )
}
