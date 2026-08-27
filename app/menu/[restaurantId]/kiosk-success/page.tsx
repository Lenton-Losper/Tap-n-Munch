'use client'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { CheckCircle2, Download, Mail } from 'lucide-react'
import { heldSessionIds } from '@/lib/tab-storage'
import { fetchGuestOrderById, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function KioskSuccessPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableParam = searchParams.get('table') || '99'
  const tableNumber = parseInt(tableParam, 10)
  const customerName = searchParams.get('name') || 'Guest'
  const orderNumber = searchParams.get('orderNumber') || ''
  const orderId = searchParams.get('orderId') || ''

  const [countdown, setCountdown] = useState(12)
  const [isPaid, setIsPaid] = useState(false)
  const [emailValue, setEmailValue] = useState('')
  const [emailStatus, setEmailStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [emailError, setEmailError] = useState('')

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          router.replace(`/menu/${restaurantId}/kiosk?table=${tableParam}&reset=true`)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [restaurantId, tableParam, router])

  useEffect(() => {
    if (!orderId || isPaid) return
    let cancelled = false

    const poll = async () => {
      try {
        const row = await fetchGuestOrderById(orderId, {
          restaurantId,
          tableNumber: Number.isFinite(tableNumber) ? tableNumber : undefined,
          sessionIds: heldSessionIds(),
        })
        if (cancelled || !row) return
        if (String(row.payment_status || '').toLowerCase() === 'paid') {
          setIsPaid(true)
        }
      } catch {
        // Best-effort polling; ignore transient failures and retry next tick.
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), GUEST_ORDER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [orderId, isPaid, tableNumber, restaurantId])

  /**
   * #304. EVERY id this browser holds, one repeated `session_id` param each -- `append`, not
   * `set`, and `heldSessionIds()` rather than `getCurrentSession()` alone.
   *
   * The email route now authorises a delivery on OWNERSHIP only; the table number no longer
   * admits anyone, because it is printed on the QR code. Ownership is decided by `ownsOrder`,
   * which matches EVERY id the client holds against BOTH `session_id` and `member_session_id` --
   * the app mints two ids in different storages (lib/session.ts and lib/tab-storage.ts) and an
   * order carries whichever the placing screen held. Presenting one of the two was the #278 class
   * of bug, and it was already the asymmetry on this page: the poll above uses heldSessionIds()
   * while this query used only one of them.
   *
   * This widens what the CLIENT presents, never what the SERVER accepts.
   */
  const receiptQuery = () => {
    const qs = new URLSearchParams({ restaurantId })
    if (Number.isFinite(tableNumber)) qs.set('table_number', String(tableNumber))
    for (const id of heldSessionIds()) qs.append('session_id', id)
    return qs.toString()
  }

  const handleDownload = () => {
    if (!orderId) return
    window.open(`/api/guest/orders/${encodeURIComponent(orderId)}/receipt?${receiptQuery()}`, '_blank')
  }

  const handleEmailReceipt = async () => {
    if (!orderId || !EMAIL_RE.test(emailValue.trim())) {
      setEmailStatus('error')
      setEmailError(MENU_COPY.enterValidEmailAddress)
      return
    }
    setEmailStatus('sending')
    setEmailError('')
    try {
      const response = await fetch(
        `/api/guest/orders/${encodeURIComponent(orderId)}/receipt/email?${receiptQuery()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailValue.trim() }),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || MENU_COPY.failedSendReceipt)
      setEmailStatus('sent')
    } catch (err) {
      setEmailStatus('error')
      setEmailError(err instanceof Error ? err.message : MENU_COPY.failedSendReceipt)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <CheckCircle2 className="w-24 h-24 text-green-500" />
        <h1 className="text-3xl font-bold text-gray-900">
          {isPaid ? MENU_COPY.orderConfirmed : MENU_COPY.orderRequestSent}
        </h1>
        {orderNumber && (
          <div className="text-6xl font-bold text-gray-900">{orderNumber}</div>
        )}
        <p className="text-xl text-gray-600">
          {MENU_COPY.thankYou} <span className="font-semibold">{customerName}</span>.<br />
          {isPaid ? MENU_COPY.yourPaymentWasReceived : MENU_COPY.waitingRestaurantConfirmYourOrder}
        </p>

        {isPaid && orderId && (
          <div className="w-full max-w-sm flex flex-col gap-3 items-center border-t border-gray-100 pt-6">
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-2 px-5 py-3 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-800"
            >
              <Download className="w-4 h-4" />
              {MENU_COPY.downloadReceipt}
            </button>

            <div className="flex w-full gap-2">
              <input
                type="email"
                placeholder="you@example.com"
                value={emailValue}
                onChange={(e) => {
                  setEmailValue(e.target.value)
                  if (emailStatus !== 'idle') setEmailStatus('idle')
                }}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleEmailReceipt()}
                disabled={emailStatus === 'sending'}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 font-medium text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                <Mail className="w-4 h-4" />
                {emailStatus === 'sending' ? 'Sending...' : 'Email'}
              </button>
            </div>
            {emailStatus === 'sent' && (
              <p className="text-sm text-green-600">Receipt sent to {emailValue.trim()}</p>
            )}
            {emailStatus === 'error' && emailError && (
              <p className="text-sm text-red-600">{emailError}</p>
            )}
          </div>
        )}

        <p className="text-gray-400 text-sm">
          Returning to start in {countdown} second{countdown !== 1 ? 's' : ''}...
        </p>
        <div className="w-48 h-1 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-1000"
            style={{ width: `${(countdown / 12) * 100}%` }}
          />
        </div>
      </div>
    </div>
  )
}
