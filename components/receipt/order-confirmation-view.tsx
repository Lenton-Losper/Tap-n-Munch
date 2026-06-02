'use client'

import {
  CheckCircle2,
  Clock,
  CreditCard,
  Banknote,
  Wallet,
  Table2,
  Heart,
  Shield,
} from 'lucide-react'
import { ReceiptCard } from './receipt-card'
import { StatusBadge } from './status-badge'
import { PaymentBadge } from './payment-badge'
import { InfoBanner } from './info-banner'
import { OrderSummary } from './order-summary'
import { ReceiptActions } from './receipt-actions'
import {
  formatReceiptDate,
  mapOrderStatusToBadge,
  normalizePaymentMethod,
  normalizePaymentStatus,
  type OrderStatusKey,
  type ReceiptLineItem,
} from './receipt-types'
import { cn } from '@/lib/utils'

export type OrderConfirmationViewProps = {
  orderNumber: number
  tableNumber?: number
  createdAt: string
  orderStatus: OrderStatusKey
  paymentMethod: string
  paymentStatus: string
  paymentChannel?: string | null
  items: ReceiptLineItem[]
  total: number
  subtotal?: number
  tax?: number
  currency?: string
  showTerminalPayMessage?: boolean
  showReadyToPayHint?: boolean
  waiterNotified?: boolean
  readyToPaySlot?: React.ReactNode
  cashReadySlot?: React.ReactNode
  cashNotifiedSlot?: React.ReactNode
  orderReadyBanner?: React.ReactNode
  orderMoreHref?: string
  className?: string
}

function PaymentMethodIcon({ method }: { method: string }) {
  const m = String(method).toLowerCase()
  if (m === 'cash') return <Banknote className="h-4 w-4 text-[#6B7280]" aria-hidden />
  if (m === 'wallet') return <Wallet className="h-4 w-4 text-[#6B7280]" aria-hidden />
  return <CreditCard className="h-4 w-4 text-[#6B7280]" aria-hidden />
}

export function OrderConfirmationView({
  orderNumber,
  tableNumber,
  createdAt,
  orderStatus,
  paymentMethod,
  paymentStatus,
  paymentChannel,
  items,
  total,
  subtotal,
  tax,
  currency = 'NAD',
  showTerminalPayMessage = false,
  showReadyToPayHint = false,
  waiterNotified = false,
  readyToPaySlot,
  cashReadySlot,
  cashNotifiedSlot,
  orderReadyBanner,
  orderMoreHref,
  className,
}: OrderConfirmationViewProps) {
  const statusBadge = mapOrderStatusToBadge(orderStatus)
  const methodLabel = normalizePaymentMethod(paymentMethod)
  const statusLabel = normalizePaymentStatus(paymentStatus)
  const isTerminal =
    String(paymentChannel || '').toLowerCase() === 'terminal' ||
    (paymentMethod === 'card' && showTerminalPayMessage)

  return (
    <div className={cn('min-h-screen bg-[#F8FAFC] print:bg-white', className)}>
      <div className="max-w-lg mx-auto px-4 py-8 sm:py-10 pb-12 space-y-6 print:max-w-none print:p-0">
        <ReceiptCard>
          {/* Success header */}
          <div className="text-center mb-6">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-9 w-9 text-[#16A34A]" strokeWidth={2} aria-hidden />
            </div>
            <h1 className="text-2xl sm:text-3xl font-serif font-bold text-[#111827]">
              Order Placed!
            </h1>
            <p className="mt-2 text-lg text-[#111827]">
              Order{' '}
              <span className="font-bold text-[#16A34A]">#{orderNumber}</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-[#6B7280]">
              {tableNumber != null && tableNumber > 0 ? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <Table2 className="h-4 w-4" aria-hidden />
                    Table {tableNumber}
                  </span>
                  <span className="text-[#D1D5DB]" aria-hidden>
                    •
                  </span>
                </>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Clock className="h-4 w-4" aria-hidden />
                {formatReceiptDate(createdAt)}
              </span>
            </div>
          </div>

          <StatusBadge label={statusBadge.label} description={statusBadge.description} />

          {(showTerminalPayMessage || isTerminal) && (
            <InfoBanner className="mt-4" variant="info">
              Your waiter will bring the card machine to your table when you&apos;re ready to pay.
            </InfoBanner>
          )}

          {/* Payment row */}
          <div className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-[#E5E7EB] bg-[#F8FAFC]/60 p-4">
            <div>
              <p className="text-xs font-medium text-[#6B7280] mb-1.5">Payment Method</p>
              <div className="flex items-center gap-2 text-sm font-semibold text-[#111827]">
                <PaymentMethodIcon method={methodLabel} />
                {methodLabel}
              </div>
            </div>
            <div className="text-right sm:text-left">
              <p className="text-xs font-medium text-[#6B7280] mb-1.5">Payment Status</p>
              <PaymentBadge status={statusLabel} />
            </div>
          </div>

          {showReadyToPayHint && statusLabel === 'Pending' && (
            <p className="mt-3 text-xs text-center text-[#6B7280] leading-relaxed">
              {methodLabel === 'Cash'
                ? 'A waiter will bring your bill when your order is ready.'
                : isTerminal
                  ? "Tap 'Ready to Pay' below when you would like the card machine brought to your table."
                  : 'Complete payment using the secure link if you have not already.'}
            </p>
          )}

          {readyToPaySlot ? <div className="mt-4">{readyToPaySlot}</div> : null}

          {waiterNotified && (
            <InfoBanner className="mt-4" variant="notify">
              Waiter has been notified — card machine coming soon.
            </InfoBanner>
          )}

          {cashReadySlot ? <div className="mt-4">{cashReadySlot}</div> : null}
          {cashNotifiedSlot ? <div className="mt-4">{cashNotifiedSlot}</div> : null}

          <div className="my-6 border-t border-dashed border-[#E5E7EB]" />

          <OrderSummary
            items={items}
            currency={currency}
            subtotal={subtotal}
            vat={tax}
            total={total}
          />

          <div className="mt-8 pt-6 text-center border-t border-dashed border-[#E5E7EB]">
            <p className="font-serif text-2xl text-[#111827] italic flex items-center justify-center gap-2">
              Thank you!
              <Heart className="h-5 w-5 text-[#16A34A] fill-green-100" aria-hidden />
            </p>
            <p className="text-sm text-[#6B7280] mt-1">We appreciate your support</p>
          </div>

          {orderReadyBanner ? <div className="mt-4">{orderReadyBanner}</div> : null}
        </ReceiptCard>

        <ReceiptActions orderMoreHref={orderMoreHref} />

        <footer className="text-center space-y-1 print:hidden pb-4">
          <p className="text-xs text-[#6B7280] inline-flex items-center justify-center gap-1.5">
            <Shield className="h-3.5 w-3.5" aria-hidden />
            Secure • Fast • Contactless
          </p>
          <p className="text-xs text-[#9CA3AF]">Powered by FlashTap</p>
        </footer>
      </div>
    </div>
  )
}
