import { chargedLineAmount, formatCurrency, type ReceiptLineItem } from './receipt-types'
import { cn } from '@/lib/utils'
import { lineConfigurationSummary } from '@/lib/orders/line-configuration'

export type OrderSummaryProps = {
  items: ReceiptLineItem[]
  currency?: string
  subtotal?: number
  serviceFee?: number
  vat?: number
  total: number
  className?: string
}

export function OrderSummary({
  items,
  currency = 'NAD',
  subtotal,
  serviceFee,
  vat,
  total,
  className,
}: OrderSummaryProps) {
  const computedSubtotal =
    subtotal ?? items.reduce((sum, item) => sum + (Number(item.subtotal) || 0), 0)

  return (
    <div className={cn('text-left', className)}>
      <h3 className="text-base font-bold text-[#111827] mb-4">Order Summary</h3>
      <ul className="space-y-3">
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex items-center gap-3">
            <span className="flex h-7 min-w-[2rem] items-center justify-center rounded-md bg-green-50 text-xs font-bold text-green-700">
              {item.quantity}×
            </span>
            <span className="flex-1 min-w-0 text-sm text-[#111827]">
              <span className="block truncate">{item.name}</span>
              {/* #298: the configuration is what tells two same-named lines apart. */}
              {lineConfigurationSummary(item) ? (
                <span className="block truncate text-xs text-[#6B7280]">
                  {lineConfigurationSummary(item)}
                </span>
              ) : null}
            </span>
            <span className="text-sm font-medium text-[#111827] tabular-nums shrink-0">
              {formatCurrency(chargedLineAmount(item), currency)}
            </span>
          </li>
        ))}
      </ul>

      {(serviceFee != null && serviceFee > 0) || (vat != null && vat > 0) ? (
        <div className="mt-4 pt-4 border-t border-dashed border-[#E5E7EB] space-y-2 text-sm">
          <div className="flex justify-between text-[#6B7280]">
            <span>Subtotal</span>
            <span className="text-[#111827] tabular-nums">{formatCurrency(computedSubtotal, currency)}</span>
          </div>
          {serviceFee != null && serviceFee > 0 ? (
            <div className="flex justify-between text-[#6B7280]">
              <span>Service Fee</span>
              <span className="text-[#111827] tabular-nums">{formatCurrency(serviceFee, currency)}</span>
            </div>
          ) : null}
          {vat != null && vat > 0 ? (
            <div className="flex justify-between text-[#6B7280]">
              <span>VAT</span>
              <span className="text-[#111827] tabular-nums">{formatCurrency(vat, currency)}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 pt-4 border-t border-dashed border-[#E5E7EB] flex justify-between items-center">
        <span className="text-sm font-bold uppercase tracking-wide text-[#111827]">Total</span>
        <span className="text-xl font-bold text-[#16A34A] tabular-nums">
          {formatCurrency(total, currency)}
        </span>
      </div>
    </div>
  )
}
