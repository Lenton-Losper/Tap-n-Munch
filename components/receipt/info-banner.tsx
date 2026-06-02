import { Bell, Droplets, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Variant = 'info' | 'success' | 'notify'

const VARIANTS: Record<
  Variant,
  { wrap: string; icon: typeof Droplets; iconClass: string; textClass: string }
> = {
  info: {
    wrap: 'bg-green-50/80 border-green-200',
    icon: Droplets,
    iconClass: 'text-green-600',
    textClass: 'text-[#111827]',
  },
  success: {
    wrap: 'bg-green-100 border-green-200',
    icon: CheckCircle2,
    iconClass: 'text-green-700',
    textClass: 'text-green-800 font-semibold',
  },
  notify: {
    wrap: 'bg-green-50 border-green-200',
    icon: Bell,
    iconClass: 'text-green-600',
    textClass: 'text-green-800 font-semibold',
  },
}

export type InfoBannerProps = {
  children: React.ReactNode
  variant?: Variant
  className?: string
}

export function InfoBanner({ children, variant = 'info', className }: InfoBannerProps) {
  const v = VARIANTS[variant]
  const Icon = v.icon
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 flex items-start gap-3 text-sm leading-relaxed',
        v.wrap,
        className
      )}
      role={variant === 'notify' || variant === 'success' ? 'status' : undefined}
    >
      <Icon className={cn('h-5 w-5 shrink-0 mt-0.5', v.iconClass)} aria-hidden />
      <p className={cn('flex-1', v.textClass)}>{children}</p>
    </div>
  )
}
