'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getOrder, subscribeToOrder, Order } from '@/lib/firebase/orders'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, Clock, ChefHat, Package, XCircle, Banknote, CreditCard } from 'lucide-react'
import Link from 'next/link'

export default function OrderConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const orderId = params.orderId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  
  const [order, setOrder] = useState<Order | null>(null)
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [orderData, restaurantData] = await Promise.all([
          getOrder(orderId),
          getRestaurant(restaurantId),
        ])
        
        if (!orderData) {
          router.push(`/menu/${restaurantId}`)
          return
        }
        
        setOrder(orderData)
        setRestaurant(restaurantData)
        setLoading(false)
      } catch (err) {
        console.error('Failed to load order:', err)
        setLoading(false)
      }
    }
    
    if (orderId && restaurantId) {
      loadData()
    }
  }, [orderId, restaurantId, router])

  useEffect(() => {
    if (!orderId) return

    // Subscribe to real-time order updates
    const unsubscribe = subscribeToOrder(orderId, (updatedOrder) => {
      if (updatedOrder) {
        setOrder(updatedOrder)
      }
    })

    return () => unsubscribe()
  }, [orderId])

  const getStatusInfo = (status: Order['status']) => {
    switch (status) {
      case 'new':
        return {
          icon: Clock,
          color: 'text-red-600',
          bgColor: 'bg-red-50',
          text: 'New Order',
          description: 'Your order has been received',
        }
      case 'accepted':
        return {
          icon: CheckCircle2,
          color: 'text-blue-600',
          bgColor: 'bg-blue-50',
          text: 'Order Accepted',
          description: 'The kitchen has accepted your order',
        }
      case 'preparing':
        return {
          icon: ChefHat,
          color: 'text-orange-600',
          bgColor: 'bg-orange-50',
          text: 'Being Prepared',
          description: 'Your order is being prepared',
        }
      case 'ready':
        return {
          icon: Package,
          color: 'text-green-600',
          bgColor: 'bg-green-50',
          text: 'Ready!',
          description: 'Your order is ready for pickup',
        }
      case 'completed':
        return {
          icon: CheckCircle2,
          color: 'text-green-600',
          bgColor: 'bg-green-50',
          text: 'Completed',
          description: 'Thank you for your order!',
        }
      case 'cancelled':
        return {
          icon: XCircle,
          color: 'text-red-600',
          bgColor: 'bg-red-50',
          text: 'Cancelled',
          description: 'This order has been cancelled',
        }
      default:
        return {
          icon: Clock,
          color: 'text-gray-600',
          bgColor: 'bg-gray-50',
          text: 'Processing',
          description: 'Your order is being processed',
        }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Order Not Found</h1>
          <p className="text-gray-600 mb-4">The order you're looking for doesn't exist.</p>
          <Link href={`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
            <Button>Back to Menu</Button>
          </Link>
        </div>
      </div>
    )
  }

  const statusInfo = getStatusInfo(order.status)
  const StatusIcon = statusInfo.icon

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        {/* Success Icon */}
        <div className={`w-16 h-16 ${statusInfo.bgColor} rounded-full flex items-center justify-center mx-auto mb-4`}>
          <StatusIcon className={`w-8 h-8 ${statusInfo.color}`} />
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold mb-2">Order Placed!</h1>
        
        {/* Order Details */}
        <div className="space-y-2 mb-6">
          <p className="text-lg">
            Order <span className="font-semibold">#{order.order_number}</span>
          </p>
          {tableNumber > 0 && (
            <p className="text-gray-600">Table {tableNumber}</p>
          )}
          <p className="text-sm text-gray-500">
            {new Date(order.placed_at).toLocaleString()}
          </p>
        </div>

        {/* Status Badge */}
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full ${statusInfo.bgColor} mb-4`}>
          <StatusIcon className={`w-5 h-5 ${statusInfo.color}`} />
          <span className={`font-semibold ${statusInfo.color}`}>
            {statusInfo.text}
          </span>
        </div>

        <p className="text-gray-600 mb-4">{statusInfo.description}</p>

        {/* Payment Information */}
        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Payment Method:</span>
            <div className="flex items-center gap-2">
              {order.payment_method === 'cash' ? (
                <Banknote className="h-4 w-4 text-gray-600" />
              ) : (
                <CreditCard className="h-4 w-4 text-gray-600" />
              )}
              <span className="text-sm font-semibold capitalize">{order.payment_method}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Payment Status:</span>
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
          {order.payment_status === 'pending' && (
            <p className="text-xs text-gray-600 mt-2">
              {order.payment_method === 'cash'
                ? 'Your order has been placed! A waiter will bring your bill when your order is ready. Please have cash ready.'
                : 'Your order has been placed! A waiter will bring the card machine to your table when your order is ready.'}
            </p>
          )}
        </div>

        {/* Order Summary */}
        <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
          <h3 className="font-semibold mb-2">Order Summary</h3>
          <div className="space-y-1 text-sm">
            {order.items.map((item, index) => (
              <div key={index} className="flex justify-between">
                <span>
                  {item.quantity}× {item.name}
                </span>
                <span>{restaurant?.currency || 'N$'}{item.subtotal.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t mt-2 pt-2 flex justify-between font-semibold">
            <span>Total</span>
            <span className="text-[#FF6B35]">
              {restaurant?.currency || 'N$'}{order.total.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          <Link href={`/menu/${restaurantId}/browse${tableNumber > 0 ? `?table=${tableNumber}` : ''}`} className="block">
            <Button className="w-full bg-[#FF6B35] hover:bg-[#e55a28]">
              Order More 🍽️
            </Button>
          </Link>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.print()}
          >
            View Receipt
          </Button>
        </div>

        {/* Real-time status updates will appear here automatically */}
        {order.status === 'ready' && (
          <div className="mt-4 p-3 bg-green-50 rounded-lg">
            <p className="text-sm text-green-800 font-medium">
              🎉 Your order is ready! A staff member will come to your table shortly.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

