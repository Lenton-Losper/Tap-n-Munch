 'use client'

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { getOrder, Order } from '@/lib/firebase/orders'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, Clock, Banknote, CreditCard } from 'lucide-react'
import Link from 'next/link'

function OrderConfirmationContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const orderId = searchParams.get('orderId')

  const [order, setOrder] = useState<Order | null>(null)
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      if (!orderId) {
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        const orderData = await getOrder(orderId)
        if (!orderData) {
          setLoading(false)
          return
        }

        setOrder(orderData)

        if (orderData.restaurant_id) {
          const restaurantData = await getRestaurant(orderData.restaurant_id)
          setRestaurant(restaurantData)
        }

        setLoading(false)
      } catch (err) {
        console.error('Failed to load order:', err)
        setLoading(false)
      }
    }

    loadData()
  }, [orderId])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  if (!orderId || !order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Order Not Found</h1>
          <p className="text-gray-600 mb-4">
            We couldn't find that order. Please check with a staff member if you're unsure.
          </p>
          <Button onClick={() => router.back()}>Go Back</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-8 h-8 text-green-600" />
        </div>

        <h1 className="text-2xl font-bold mb-2">Order received 🎉</h1>
        <p className="text-gray-600 mb-4">
          Your order has been received by the restaurant. A staff member will start preparing it shortly.
        </p>

        <div className="space-y-2 mb-6">
          <p className="text-lg">
            Order <span className="font-semibold">#{order.order_number}</span>
          </p>
          {order.table_number > 0 && (
            <p className="text-gray-600">Table {order.table_number}</p>
          )}
          <p className="text-sm text-gray-500 flex items-center justify-center gap-1">
            <Clock className="w-4 h-4" />
            {new Date(order.placed_at).toLocaleString()}
          </p>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
          <h3 className="font-semibold mb-2">Payment</h3>
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="text-gray-700">Method:</span>
            <div className="flex items-center gap-2">
              {order.payment_method === 'cash' ? (
                <Banknote className="h-4 w-4 text-gray-600" />
              ) : (
                <CreditCard className="h-4 w-4 text-gray-600" />
              )}
              <span className="font-semibold capitalize">
                {order.payment_method}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700">Status:</span>
            {order.payment_status === 'paid' ? (
              <Badge className="bg-green-500 text-white">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Paid
              </Badge>
            ) : (
              <Badge variant="outline" className="border-yellow-500 text-yellow-700 bg-yellow-50">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </Badge>
            )}
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
          <h3 className="font-semibold mb-2">Order summary</h3>
          <div className="space-y-1 text-sm">
            {order.items.map((item, index) => (
              <div key={index} className="flex justify-between">
                <span>
                  {item.quantity}× {item.name}
                </span>
                <span>
                  {restaurant?.currency || 'N$'}
                  {item.subtotal.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t mt-2 pt-2 flex justify-between font-semibold">
            <span>Total</span>
            <span className="text-[#FF6B35]">
              {restaurant?.currency || 'N$'}
              {order.total.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {order.restaurant_id && (
            <Link href={`/menu/${order.restaurant_id}/browse`} className="block">
              <Button className="w-full bg-[#FF6B35] hover:bg-[#e55a28]">
                Order more
              </Button>
            </Link>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.print()}
          >
            View receipt
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading order confirmation...</p>
          </div>
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  )
}




