'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '@/components/ui/button'
import { buildOnboardingTableQrUrl } from '@/lib/onboarding/qr-url'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import { subscribeRestaurantOrdersRealtime } from '@/lib/supabase/orders'
import type { StepHandle } from './types'

type StepTestOrderProps = {
  restaurantId: string
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
  onComplete: () => void
}

type OrderFeedItem = {
  id: string
  order_number?: number | null
  table_number?: number | null
  status?: string | null
  total?: number | null
  placed_at?: string | null
}

export const StepTestOrder = forwardRef<StepHandle, StepTestOrderProps>(function StepTestOrder(
  { restaurantId, onError, setSaving, onComplete },
  ref
) {
  const [orders, setOrders] = useState<OrderFeedItem[]>([])
  const [completed, setCompleted] = useState(false)
  const completingRef = useRef(false)
  const tableOneUrl = buildOnboardingTableQrUrl(restaurantId, 1)

  useEffect(() => {
    const unsubscribe = subscribeRestaurantOrdersRealtime(restaurantId, {
      onInitial: (initialOrders) => {
        setOrders(initialOrders as OrderFeedItem[])
      },
      onChange: (payload) => {
        const record = (payload.new || payload.old) as OrderFeedItem | null
        if (!record?.id) return

        setOrders((prev) => {
          const eventType = String(payload.eventType || '').toUpperCase()
          if (eventType === 'DELETE') {
            return prev.filter((order) => order.id !== record.id)
          }
          const index = prev.findIndex((order) => order.id === record.id)
          if (index >= 0) {
            const next = [...prev]
            next[index] = { ...next[index], ...record }
            return next
          }
          return [record, ...prev]
        })
      },
    })

    return unsubscribe
  }, [restaurantId])

  const markComplete = async () => {
    if (completingRef.current || completed) return
    completingRef.current = true
    setSaving(true)
    onError('')

    try {
      await onboardingFetch('/api/admin/setup-status', {
        method: 'PATCH',
        body: JSON.stringify({ flag: 'test_order_completed' }),
      })
      setCompleted(true)
      onComplete()
    } catch (error: unknown) {
      completingRef.current = false
      onError(error instanceof Error ? error.message : 'Failed to complete test order step')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (orders.length > 0 && !completed) {
      void markComplete()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.length, completed])

  const handleManualConfirm = async () => {
    await markComplete()
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!completed) {
        onError('Place a test order or confirm manually to finish')
        return false
      }
      return true
    },
  }))

  if (completed) {
    return (
      <div className="space-y-6 text-center">
        <p className="text-2xl font-semibold text-[#37352F]">Your restaurant is ready!</p>
        <p className="text-sm text-[#6B675F]">
          You&apos;ve completed setup. Head to your dashboard to manage live orders.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center rounded-lg border border-[#E9E9E7] bg-white p-6">
        <p className="mb-4 text-sm text-[#6B675F]">
          Scan this QR code with your phone and place a test order at Table 1.
        </p>
        <QRCodeSVG value={tableOneUrl} size={200} />
        <p className="mt-3 break-all text-center text-xs text-[#9B978E]">{tableOneUrl}</p>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleManualConfirm}
        className="rounded-lg border-[#E9E9E7]"
      >
        I&apos;ve placed a test order
      </Button>

      <div className="rounded-lg border border-[#E9E9E7]">
        <div className="border-b border-[#E9E9E7] px-4 py-2 text-sm font-medium text-[#37352F]">
          Live orders
        </div>
        {orders.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[#6B675F]">
            Waiting for your first test order...
          </p>
        ) : (
          <ul className="divide-y divide-[#E9E9E7]">
            {orders.slice(0, 5).map((order) => (
              <li key={order.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-[#37352F]">
                    Order #{order.order_number ?? '—'}
                  </p>
                  <p className="text-[#6B675F]">
                    Table {order.table_number ?? '—'} · {order.status ?? 'pending'}
                  </p>
                </div>
                <p className="font-medium text-[#37352F]">
                  {Number(order.total || 0).toFixed(2)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
})
