'use client'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'

export default function KioskSuccessPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableParam = searchParams.get('table') || '99'
  const customerName = searchParams.get('name') || 'Guest'
  const orderNumber = searchParams.get('orderNumber') || ''

  const [countdown, setCountdown] = useState(12)

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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <CheckCircle2 className="w-24 h-24 text-green-500" />
        <h1 className="text-3xl font-bold text-gray-900">Order placed!</h1>
        {orderNumber && (
          <div className="text-6xl font-bold text-gray-900">{orderNumber}</div>
        )}
        <p className="text-xl text-gray-600">
          Thank you, <span className="font-semibold">{customerName}</span>.<br />
          Your order is being prepared.
        </p>
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
