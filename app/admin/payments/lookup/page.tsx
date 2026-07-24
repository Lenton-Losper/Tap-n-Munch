'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type OrderMatch = {
  id: string
  restaurant_id?: string
  restaurant_name?: string
  restaurants?: { name?: string } | Array<{ name?: string }> | null
  merchant_order_no?: string
  paycloud_merchant_order_no?: string
  business_order_no?: string
  order_number?: string
  voucher?: string
  voucher_code?: string
  payment_voucher?: string
  payment_voucher_no?: string
  payment_status?: string
  status?: string
  total?: number | string
  paid_at?: string
  placed_at?: string
}

function money(value: unknown) {
  return `N$${Number(value || 0).toLocaleString('en-NA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function restaurantName(order: OrderMatch) {
  const relation = Array.isArray(order.restaurants) ? order.restaurants[0] : order.restaurants
  return order.restaurant_name || relation?.name || 'View restaurant'
}

export default function PaymentLookupPage() {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [orders, setOrders] = useState<OrderMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const search = useCallback(async (value: string) => {
    const q = value.trim()
    if (!q) return
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      setSearched(q)
      if (!token) throw new Error('Not signed in')
      const response = await fetch(
        `/api/platform/payments/lookup?q=${encodeURIComponent(q)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        },
      )
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Payment lookup failed')
      setOrders(
        Array.isArray(body.orders)
          ? body.orders
          : Array.isArray(body.results)
            ? body.results
            : Array.isArray(body.matches)
              ? body.matches
              : [],
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Payment lookup failed')
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => {
      const initial = new URLSearchParams(window.location.search).get('q') || ''
      setQuery(initial)
      if (initial) void search(initial)
    })
  }, [search])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void search(query)
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/payments" className="text-sm font-medium text-[#C0392B] hover:underline">
          ← Payments
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-[#1A1A1A]">
          Payment lookup
        </h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Search merchant order number, voucher, gateway reference, or internal order ID.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-col gap-2 rounded-xl border border-[#E8E6E1] bg-white p-4 sm:flex-row"
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="FT…, merchant order, voucher, or UUID"
          className="border-[#E8E6E1]"
          autoFocus
        />
        <Button
          type="submit"
          disabled={loading || !query.trim()}
          className="bg-[#C0392B] text-white hover:bg-[#A93226]"
        >
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {!loading && searched && orders.length === 0 && !error ? (
        <EmptyState
          title="No matching payments"
          body={`No orders matched “${searched}”. Check the reference and try again.`}
        />
      ) : null}

      {orders.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-[#E8E6E1] bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3">Merchant order</th>
                  <th className="px-4 py-3">Voucher</th>
                  <th className="px-4 py-3">Payment status</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Restaurant</th>
                  <th className="px-4 py-3">Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="px-4 py-3 font-mono text-xs text-[#1A1A1A]">
                      {order.merchant_order_no ||
                        order.paycloud_merchant_order_no ||
                        order.business_order_no ||
                        order.order_number ||
                        order.id}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[#5C574E]">
                      {order.voucher ||
                        order.voucher_code ||
                        order.payment_voucher ||
                        order.payment_voucher_no ||
                        '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                        {order.payment_status || order.status || 'unknown'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-[#1A1A1A]">
                      {money(order.total)}
                    </td>
                    <td className="px-4 py-3">
                      {order.restaurant_id ? (
                        <Link
                          href={`/admin/restaurants/${order.restaurant_id}?tab=payments`}
                          className="font-medium text-[#C0392B] hover:underline"
                        >
                          {restaurantName(order)}
                        </Link>
                      ) : (
                        order.restaurant_name || '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-[#8A867C]">
                      {order.paid_at || order.placed_at
                        ? new Date(String(order.paid_at || order.placed_at)).toLocaleString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
