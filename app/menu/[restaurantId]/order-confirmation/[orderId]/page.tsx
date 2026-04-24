'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Clock, ChefHat, Package, XCircle, Banknote, CreditCard } from 'lucide-react'
import Link from 'next/link'
import { ReadyToPayTerminalButton } from '@/components/ready-to-pay-terminal'
import { getCurrentSession } from '@/lib/session'

type Order = {
  id: string
  order_number: number
  status: 'new' | 'accepted' | 'preparing' | 'ready' | 'ready_for_terminal' | 'completed' | 'cancelled'
  placed_at: string
  payment_method: string
  payment_status: string
  payment_channel?: string | null
  total: number
  table_number?: number
  items: Array<{ quantity: number; name: string; subtotal: number }>
}

export default function OrderConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const orderId = params.orderId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  const terminalNotice = searchParams.get('notice') === 'terminal'
  
  const [order, setOrder] = useState<Order | null>(null)
  const [restaurant, setRestaurant] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [orderResult, restaurantData] = await Promise.all([
          supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single(),
          getRestaurant(restaurantId),
        ])
        const orderData = (orderResult.data as Order | null) || null
        
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

    const channel = supabase
      .channel(`order-confirmation-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        async () => {
          const { data: updatedOrder } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single()
          if (updatedOrder) {
            setOrder(updatedOrder as Order)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orderId, restaurantId])

  const effectiveTableNumber =
    tableNumber > 0 ? tableNumber : Number((order as Order | null)?.table_number || 0)

  const getStatusInfo = (status: Order['status']) => {
    switch (status) {
      case 'new':
        return {
          icon: Clock,
          text: 'New Order',
          description: 'Your order has been received',
        }
      case 'accepted':
        return {
          icon: CheckCircle2,
          text: 'Order Accepted',
          description: 'The kitchen has accepted your order',
        }
      case 'preparing':
        return {
          icon: ChefHat,
          text: 'Being Prepared',
          description: 'Your order is being prepared',
        }
      case 'ready':
        return {
          icon: Package,
          text: 'Ready!',
          description: 'Your order is ready for pickup',
        }
      case 'ready_for_terminal':
        return {
          icon: CreditCard,
          text: 'Ready for card machine',
          description: 'Staff have been notified to bring the terminal to your table',
        }
      case 'completed':
        return {
          icon: CheckCircle2,
          text: 'Completed',
          description: 'Thank you for your order!',
        }
      case 'cancelled':
        return {
          icon: XCircle,
          text: 'Cancelled',
          description: 'This order has been cancelled',
        }
      default:
        return {
          icon: Clock,
          text: 'Processing',
          description: 'Your order is being processed',
        }
      }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-2xl font-serif font-bold text-foreground mb-4">Order Not Found</h1>
          <p className="text-muted-foreground font-sans mb-6">The order you're looking for doesn't exist.</p>
          <Link href={`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
            <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans">Back to Menu</Button>
          </Link>
        </div>
      </div>
    )
  }

  const statusInfo = getStatusInfo(order.status)
  const StatusIcon = statusInfo.icon

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-card border border-border p-8 text-center">
        {/* Status Icon */}
        <div className="w-16 h-16 bg-muted flex items-center justify-center mx-auto mb-6">
          <StatusIcon className="w-8 h-8 text-foreground stroke-[1.5]" />
        </div>

        {/* Title */}
        <h1 className="text-2xl font-serif font-bold text-foreground mb-2">Order Placed!</h1>
        
        {/* Order Details */}
        <div className="space-y-2 mb-6">
          <p className="text-lg font-sans text-foreground">
            Order <span className="font-bold">#{order.order_number}</span>
          </p>
          {effectiveTableNumber > 0 && (
            <p className="text-muted-foreground font-sans">Table {effectiveTableNumber}</p>
          )}
          <p className="text-sm text-muted-foreground font-sans">
            {new Date(order.placed_at).toLocaleString()}
          </p>
        </div>

        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-muted mb-4">
          <StatusIcon className="w-5 h-5 text-foreground stroke-[1.5]" />
          <span className="font-semibold text-foreground font-sans uppercase text-sm tracking-wide">
            {statusInfo.text}
          </span>
        </div>

        <p className="text-muted-foreground font-sans mb-6">{statusInfo.description}</p>

        {terminalNotice && (
          <div className="mb-6 rounded-md border border-border bg-muted/80 p-4 text-left">
            <p className="text-sm font-sans text-foreground leading-relaxed">
              {
                "Your waiter will bring the card machine to your table when you're ready to pay."
              }
            </p>
          </div>
        )}

        {/* Payment Information */}
        <div className="bg-muted p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-sans text-muted-foreground">Payment Method:</span>
            <div className="flex items-center gap-2">
              {order.payment_method === 'cash' ? (
                <Banknote className="h-4 w-4 text-foreground stroke-[1.5]" />
              ) : (
                <CreditCard className="h-4 w-4 text-foreground stroke-[1.5]" />
              )}
              <span className="text-sm font-sans font-semibold text-foreground capitalize">{order.payment_method}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-sans text-muted-foreground">Payment Status:</span>
            {order.payment_status === 'paid' ? (
              <span className="inline-flex items-center px-2 py-1 bg-foreground text-background text-xs font-semibold uppercase">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Paid
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-1 border border-border text-foreground text-xs font-semibold uppercase">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </span>
            )}
          </div>
          {order.payment_status === 'pending' && (
            <p className="text-xs text-muted-foreground font-sans mt-3">
              {order.payment_method === 'cash'
                ? 'A waiter will bring your bill when your order is ready.'
                : String((order as Order & { payment_channel?: string }).payment_channel || '').toLowerCase() ===
                    'terminal'
                  ? 'Tap “Ready to Pay” below when you would like the card machine brought to your table.'
                  : 'Complete payment using the secure link if you have not already.'}
            </p>
          )}
        </div>

        {order.payment_method === 'card' &&
          String((order as Order & { payment_channel?: string }).payment_channel || '').toLowerCase() ===
            'terminal' &&
          String(order.payment_status || '').toLowerCase() !== 'paid' && (
            <div className="mb-6">
              <ReadyToPayTerminalButton
                restaurantId={restaurantId}
                orderId={order.id}
                tableNumber={effectiveTableNumber}
                sessionId={getCurrentSession()}
              />
            </div>
          )}

        {/* Order Summary */}
        <div className="bg-muted p-4 mb-6 text-left">
          <h3 className="font-semibold font-sans text-foreground mb-3">Order Summary</h3>
          <div className="space-y-2 text-sm font-sans">
            {order.items.map((item, index) => (
              <div key={index} className="flex justify-between">
                <span className="text-muted-foreground">
                  {item.quantity}× {item.name}
                </span>
                <span className="text-foreground font-semibold">{restaurant?.currency || 'N$'}{item.subtotal.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-border mt-3 pt-3 flex justify-between font-semibold font-sans">
            <span className="text-foreground">Total</span>
            <span className="text-foreground">
              {restaurant?.currency || 'N$'}{order.total.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          <Link href={`/menu/${restaurantId}/browse${tableNumber > 0 ? `?table=${tableNumber}` : ''}`} className="block">
            <Button className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6">
              Order More
            </Button>
          </Link>
          <Button
            variant="outline"
            className="w-full border-border font-sans"
            onClick={() => window.print()}
          >
            View Receipt
          </Button>
        </div>

        {/* Ready notification */}
        {order.status === 'ready' && (
          <div className="mt-6 p-4 bg-muted border border-border">
            <p className="text-sm text-foreground font-sans font-semibold">
              🎉 Your order is ready! A staff member will come to your table shortly.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
