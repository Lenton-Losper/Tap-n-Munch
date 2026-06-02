import { cn } from '@/lib/utils'

export type ReceiptCardProps = {
  children: React.ReactNode
  className?: string
}

/** Premium digital receipt shell with perforated bottom edge. */
export function ReceiptCard({ children, className }: ReceiptCardProps) {
  return (
    <div
      className={cn(
        'relative bg-white rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] border border-[#E5E7EB] overflow-hidden',
        className
      )}
    >
      <div className="px-5 sm:px-8 pt-8 pb-10">{children}</div>
      <div
        className="h-4 w-full receipt-perforation"
        aria-hidden
      />
    </div>
  )
}
