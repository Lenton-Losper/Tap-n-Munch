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
  needs_you: { wrap: 'bg-red-50 border-red-100', icon: 'text-red-600', label: 'text-red-800' },
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
