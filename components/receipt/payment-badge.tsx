import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PaymentBadgeProps = {
  status: 'Paid' | 'Pending' | 'Failed' | string
  className?: string
}

export function PaymentBadge({ status, className }: PaymentBadgeProps) {
  const normalized = String(status)
  const isPaid = normalized === 'Paid'
  const isFailed = normalized === 'Failed'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide',
        isPaid && 'bg-green-50 text-[#16A34A]',
        !isPaid && !isFailed && 'bg-amber-50 text-[#F59E0B]',
        isFailed && 'bg-red-50 text-[#DC2626]',
        className
      )}
    >
      {isPaid ? (
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      ) : isFailed ? (
        <XCircle className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Clock className="h-3.5 w-3.5" aria-hidden />
      )}
      {normalized}
    </span>
  )
}
