import type { ComponentType } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ButtonSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} aria-hidden />
}

/**
 * Shared icon+label content for an in-flight-aware Button. The resting
 * icon/label/trailingIcon stay rendered (just dimmed) while `loading` is
 * true, so the button's box never resizes -- a spinner overlays on top via
 * absolute positioning instead of replacing the label. `loadingLabel`, if
 * given, is announced to screen readers through a visually-hidden status
 * region rather than swapped in visibly.
 */
export function ActionButtonContent({
  loading,
  icon: Icon,
  trailingIcon: TrailingIcon,
  label,
  loadingLabel,
}: {
  loading: boolean
  icon?: ComponentType<{ className?: string }>
  /** Icon rendered after the label (e.g. a "Next" chevron) instead of before it. */
  trailingIcon?: ComponentType<{ className?: string }>
  label: string
  loadingLabel?: string
}) {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={cn('inline-flex items-center', loading && 'opacity-40')}>
        {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
        {label}
        {TrailingIcon ? <TrailingIcon className="ml-1 h-4 w-4" /> : null}
      </span>
      {loading ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          role="status"
          aria-live="polite"
        >
          <ButtonSpinner />
          <span className="sr-only">{loadingLabel || label}</span>
        </span>
      ) : null}
    </span>
  )
}
