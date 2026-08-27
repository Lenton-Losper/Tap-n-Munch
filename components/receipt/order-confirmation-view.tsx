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
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import { orderIdentityLabel, hasAllocatedOrderNumber } from '@/lib/orders/order-identity'
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
  /** `null` until staff Accept allocates one. Never coerce a missing number to 0. */
  orderNumber: number | null
  tableNumber?: number
  createdAt: string
  orderStatus: OrderStatusKey
  paymentMethod: string
  paymentStatus: string
  paymentChannel?: string | null
  /**
   * Is this order on a TAB? Ruled 2026-08-19: the payment block is removed for tab orders.
   *
   * On a tab the customer is not asked how they will pay -- that happens at the table when the
   * tab is settled -- so before payment exists there is no true value either field can show. The
   * method was invented ('cash', from a route fallback since removed) and the status was derived
   * from that invention, so "PENDING" sent a customer to ask staff about a transaction that did
   * not exist. Payment lives on the Tab.
   *
   * Non-tab orders KEEP the block: there the method IS chosen at submission and both fields are
   * facts the customer supplied.
   */
  isTabOrder?: boolean
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
  /**
   * Customer order editing. Sits directly under the item summary, because the thing being
   * changed is the list of items and the customer should be looking at it when they decide.
   * The slot renders nothing of its own when the order is past editing.
   */
  editSlot?: React.ReactNode
  className?: string
}

function PaymentMethodIcon({ method }: { method: string }) {
  const m = String(method).toLowerCase()
  if (m === 'cash') return <Banknote className="h-4 w-4 text-[#6B7280]" aria-hidden />
  if (m === 'wallet') return <Wallet className="h-4 w-4 text-[#6B7280]" aria-hidden />
  if (m === 'other') return <Wallet className="h-4 w-4 text-[#6B7280]" aria-hidden />
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
  isTabOrder = false,
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
  editSlot,
  orderReadyBanner,
  className,
}: OrderConfirmationViewProps) {
  const statusBadge = mapOrderStatusToBadge(orderStatus)
  const methodLabel = normalizePaymentMethod(paymentMethod)
  const statusLabel = normalizePaymentStatus(paymentStatus)
  const channelLower = String(paymentChannel || '').toLowerCase()
  const isTerminal =
    channelLower === 'terminal' ||
    (paymentMethod === 'card' && showTerminalPayMessage && channelLower !== 'card_manual')
  const isCardManual = channelLower === 'card_manual'
  const isOtherChannel = channelLower === 'other'

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
              {MENU_COPY.confirmOrderPlaced}
            </h1>
            {/*
              #296: NO INVENTED NUMBER.
              An order_request has no `order_number` at all -- the column does not exist on that
              table. A number is allocated when staff Accept. This used to render
              `Number(row.order_number || 0)`, so every submitted-but-unaccepted request said
              "Order #0": a number that is not secondary, not real, and not the customer's.

              The decision is REUSED, not re-invented: `order_number != null ? #n : notYetNumbered`
              is exactly what the Tab screen does at tab/page.tsx, with the same copy constant.
              Before acceptance the submission is identified by its status, its items and its
              time, all of which this screen already shows.

              Demoted to the muted metadata line: a real number is worth showing and is not the
              headline.

              2026-08-19: THIS BRANCH USED `orderNumber != null` AND SHIPPED "Order #0" ANYWAY.
              A real customer saw it on production. `!= null` admits `0`, and the guest-order
              mapper was handing every order_request a literal `order_number: 0`.

              `hasAllocatedOrderNumber` is the ONLY test for this question anywhere now, and a
              CI scan (scripts/check-order-number-guard.ts) fails the build on any file that
              compares an order number to null without it. Three instances was enough.
            */}
            {hasAllocatedOrderNumber({ order_number: orderNumber }) ? (
              <p className="mt-2 text-sm text-[#6B7280]">
                Order <span className="font-semibold text-[#111827]">#{orderNumber}</span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-[#6B7280]">
                {/* Routed through the shared function 2026-08-18: this branch is reachable with a
                    DECLINED order, because fetchGuestOrderById applies no status filter, and it
                    told the customer a number was still coming. */}
                {orderIdentityLabel({ order_number: orderNumber, status: orderStatus, payment_status: paymentStatus })}
              </p>
            )}
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

          <StatusBadge label={statusBadge.label} state={statusBadge.state} />

          {(showTerminalPayMessage || isTerminal) && !isCardManual && !isOtherChannel && (
            <InfoBanner className="mt-4" variant="info">
              Your waiter will bring the card machine to your table when you&apos;re ready to pay.
            </InfoBanner>
          )}

          {isCardManual && (
            <InfoBanner className="mt-4" variant="info">
              {MENU_COPY.confirmHaveYourCardReady}
            </InfoBanner>
          )}

          {isOtherChannel && (
            <InfoBanner className="mt-4" variant="info">
              {MENU_COPY.confirmStaffWillAssistAtTable}
            </InfoBanner>
          )}

          {/* Payment row — hidden on a tab order; see the isTabOrder prop. */}
          {!isTabOrder && (
          <div className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-[#E5E7EB] bg-[#F8FAFC]/60 p-4">
            <div>
              <p className="text-xs font-medium text-[#6B7280] mb-1.5">{MENU_COPY.confirmPaymentMethod}</p>
              <div className="flex items-center gap-2 text-sm font-semibold text-[#111827]">
                <PaymentMethodIcon method={methodLabel} />
                {methodLabel}
              </div>
            </div>
            <div className="text-right sm:text-left">
              <p className="text-xs font-medium text-[#6B7280] mb-1.5">{MENU_COPY.confirmPaymentStatus}</p>
              <PaymentBadge status={statusLabel} />
            </div>
          </div>
          )}

          {!isTabOrder && showReadyToPayHint && statusLabel === 'Pending' && (
            <p className="mt-3 text-xs text-center text-[#6B7280] leading-relaxed">
              {methodLabel === 'Cash'
                ? MENU_COPY.confirmWaiterWillBringYourBill
                : isTerminal
                  ? MENU_COPY.confirmTapReadyToPay
                  : MENU_COPY.confirmCompletePaymentSecureLink}
            </p>
          )}

          {readyToPaySlot ? <div className="mt-4">{readyToPaySlot}</div> : null}

          {waiterNotified && (
            <InfoBanner className="mt-4" variant="notify">
              {MENU_COPY.confirmWaiterNotifiedCardMachineComing}
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

          {editSlot ? <div className="mt-6 print:hidden">{editSlot}</div> : null}

          <div className="mt-8 pt-6 text-center border-t border-dashed border-[#E5E7EB]">
            <p className="font-serif text-2xl text-[#111827] italic flex items-center justify-center gap-2">
              {MENU_COPY.confirmThankYou}
              <Heart className="h-5 w-5 text-[#16A34A] fill-green-100" aria-hidden />
            </p>
            <p className="text-sm text-[#6B7280] mt-1">{MENU_COPY.confirmWeAppreciateYourSupport}</p>
          </div>

          {orderReadyBanner ? <div className="mt-4">{orderReadyBanner}</div> : null}
        </ReceiptCard>

        <footer className="text-center space-y-1 print:hidden pb-4">
          <p className="text-xs text-[#6B7280] inline-flex items-center justify-center gap-1.5">
            <Shield className="h-3.5 w-3.5" aria-hidden />
            {MENU_COPY.confirmSecureFastContactless}
          </p>
          <p className="text-xs text-[#9CA3AF]">{MENU_COPY.poweredByFlashtap}</p>
        </footer>
      </div>
    </div>
  )
}
