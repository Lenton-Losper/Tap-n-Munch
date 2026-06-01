'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { getRestaurant, resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Clock, Banknote, CreditCard } from 'lucide-react'

type Order = any

export default function AdminOrdersPage() {
  const [restaurantId, setRestaurantId] = useState('')
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [restaurantName, setRestaurantName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadOrders = async (id: string) => {
    try {
      setLoading(true)
      setError(null)
      const restaurantUuid = await resolveRestaurantUuid(id)
      const [ordersRes, restaurantData] = await Promise.all([
        supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', restaurantUuid)
          .order('placed_at', { ascending: false })
          .limit(200),
        getRestaurant(id),
      ])
      const ordersData = (ordersRes.data || []) as Order[]
      setOrders(ordersData)
      setRestaurantName(restaurantData?.name || null)
      setLoading(false)
    } catch (err: any) {
      console.error('Failed to load orders:', err)
      setError(err?.message || 'Failed to load orders')
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!restaurantId.trim()) return
    await loadOrders(restaurantId.trim())
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-card border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold">Orders (Admin)</h1>
          <p className="text-sm text-muted-foreground">
            Enter a restaurant ID to view its recent orders. Authentication is not required in this pilot view.
          </p>
          <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
            <input
              type="text"
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              placeholder="Restaurant ID (e.g. rest_123)"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button type="submit" disabled={loading || !restaurantId.trim()}>
              {loading ? 'Loading...' : 'Load orders'}
            </Button>
          </form>
          {restaurantName && (
            <p className="mt-2 text-sm text-gray-700">
              Showing orders for: <span className="font-semibold">{restaurantName}</span>
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {orders.length === 0 && !loading ? (
          <div className="bg-card border rounded-lg p-8 text-center text-sm text-muted-foreground">
            No orders to display. Enter a restaurant ID above and click &quot;Load orders&quot;.
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => (
              <div
                key={order.id}
                className="bg-card border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">#{order.order_number}</span>
                    <Badge variant="secondary">Table {order.table_number}</Badge>
                    <Badge>{order.status}</Badge>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(order.placed_at).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="text-sm font-semibold">
                    {order.total.toFixed(2)}
                  </div>
                </div>

                <div className="text-xs text-muted-foreground">
                  {order.payment_method === 'cash' ? (
                    <span className="inline-flex items-center gap-1">
                      <Banknote className="h-3 w-3" />
                      Cash
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <CreditCard className="h-3 w-3" />
                      Card
                    </span>
                  )}
                  {' • '}
                  Payment: {order.payment_status}
                </div>

                <div className="border-t pt-2 space-y-1 text-sm">
                  {order.items.map((item: any, index: number) => (
                    <div key={index} className="flex justify-between">
                      <span>
                        {item.quantity}× {item.name}
                      </span>
                      <span>{item.subtotal.toFixed(2)}</span>
                    </div>
                  ))}
                </div>

                {order.order_instructions && (
                  <div className="mt-2 text-xs text-yellow-900 bg-yellow-50 border border-yellow-200 rounded-md p-2">
                    <span className="font-semibold">Notes:</span> {order.order_instructions}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}



