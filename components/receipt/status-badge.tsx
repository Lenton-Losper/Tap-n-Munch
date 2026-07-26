import { Ticket } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReceiptStatusBadge } from './receipt-types'

const STYLES: Record<
  ReceiptStatusBadge,
  { wrap: string; icon: string; label: string }
> = {
  'WAITING FOR CONFIRMATION': {
    wrap: 'bg-purple-50 border-purple-100',
    icon: 'text-purple-600',
    label: 'text-purple-800',
  },
  DECLINED: {
    wrap: 'bg-red-50 border-red-100',
    icon: 'text-red-600',
    label: 'text-red-800',
  },
  'NEW ORDER': {
    wrap: 'bg-green-50 border-green-100',
    icon: 'text-green-600',
    label: 'text-green-800',
  },
  ACCEPTED: {
    wrap: 'bg-blue-50 border-blue-100',
    icon: 'text-blue-600',
    label: 'text-blue-800',
  },
  PREPARING: {
    wrap: 'bg-sky-50 border-sky-100',
    icon: 'text-sky-600',
    label: 'text-sky-800',
  },
  READY: {
    wrap: 'bg-emerald-50 border-emerald-100',
    icon: 'text-emerald-600',
    label: 'text-emerald-800',
  },
  COMPLETED: {
    wrap: 'bg-green-50 border-green-100',
    icon: 'text-green-600',
    label: 'text-green-800',
  },
  CANCELLED: {
    wrap: 'bg-red-50 border-red-100',
    icon: 'text-red-600',
    label: 'text-red-800',
  },
}

export type StatusBadgeProps = {
  label: ReceiptStatusBadge
  description: string
  className?: string
}

export function StatusBadge({ label, description, className }: StatusBadgeProps) {
  const style = STYLES[label] ?? STYLES['NEW ORDER']
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
        <p className="text-sm text-[#6B7280] mt-0.5 leading-snug">{description}</p>
      </div>
    </div>
  )
}
