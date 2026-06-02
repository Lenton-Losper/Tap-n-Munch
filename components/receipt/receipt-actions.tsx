import { Download, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ReceiptActionsProps = {
  onViewReceipt?: () => void
  onDownloadPdf?: () => void
  orderMoreHref?: string
  className?: string
}

export function ReceiptActions({
  onViewReceipt,
  onDownloadPdf,
  orderMoreHref,
  className,
}: ReceiptActionsProps) {
  const handlePrint = onDownloadPdf ?? onViewReceipt ?? (() => window.print())

  return (
    <div
      className={cn(
        'bg-white rounded-2xl border border-[#E5E7EB] shadow-sm p-5 sm:p-6 print:hidden',
        className
      )}
    >
      <h3 className="text-lg font-bold text-[#111827]">Digital Receipt</h3>
      <p className="text-sm text-[#6B7280] mt-1 mb-5">
        View or download your receipt anytime.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          type="button"
          variant="outline"
          className="flex-1 h-12 border-[#16A34A] text-[#16A34A] hover:bg-green-50 font-semibold gap-2"
          onClick={onViewReceipt ?? handlePrint}
        >
          <Eye className="h-4 w-4" aria-hidden />
          View Receipt
        </Button>
        <Button
          type="button"
          className="flex-1 h-12 bg-[#16A34A] hover:bg-green-700 text-white font-semibold gap-2"
          onClick={handlePrint}
        >
          <Download className="h-4 w-4" aria-hidden />
          Download PDF
        </Button>
      </div>
      {orderMoreHref ? (
        <a
          href={orderMoreHref}
          className="mt-4 block w-full text-center text-sm font-semibold text-[#2563EB] hover:underline"
        >
          Order More
        </a>
      ) : null}
    </div>
  )
}
