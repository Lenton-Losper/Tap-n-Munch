'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type OrderItem = {
  name?: string
  display_name?: string
  quantity?: number
}

type HistoryOrder = {
  id: string
  order_number?: number | null
  table_number?: number | null
  total?: number | null
  status?: string | null
  payment_method?: string | null
  placed_at?: string | null
  items?: OrderItem[] | null
  memberName?: string
}

type HistoryResponse = {
  orders: HistoryOrder[]
  total: number
  page: number
  pageSize: number
  totalRevenue: number
  totalOrders: number
  avgOrderValue: number
  error?: string
}

function todayIso() {
  return new Date().toISOString().split('T')[0]
}

function currency(value: number, symbol: string) {
  return `${symbol}${value.toFixed(2)}`
}

function formatPlacedAt(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

function formatItemsSummary(items: unknown) {
  if (!Array.isArray(items) || items.length === 0) return '—'
  return items
    .map((item) => {
      const name = String(item?.display_name || item?.name || 'Item')
      const qty = Number(item?.quantity) || 1
      return qty > 1 ? `${qty}× ${name}` : name
    })
    .join(', ')
}

function formatPaymentMethod(method: string | null | undefined) {
  if (!method) return '—'
  return String(method).replace(/_/g, ' ')
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const normalized = String(status || '').toLowerCase()
  switch (normalized) {
    case 'pending':
      return <Badge variant="destructive">Pending</Badge>
    case 'completed':
      return <Badge variant="secondary">Completed</Badge>
    case 'cancelled':
      return <Badge className="bg-red-100 text-red-800 border-red-200">Cancelled</Badge>
    default:
      return <Badge variant="outline">{status || '—'}</Badge>
  }
}

function OrderHistoryContent() {
  const { restaurant, restaurantId } = useAuth()
  const currencySymbol = String(restaurant?.currency || 'N$')

  const [startDate, setStartDate] = useState(todayIso)
  const [endDate, setEndDate] = useState(todayIso)
  const [tableNumber, setTableNumber] = useState('')
  const [status, setStatus] = useState('all')
  const [orderNumber, setOrderNumber] = useState('')
  const [page, setPage] = useState(1)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<HistoryResponse | null>(null)

  const loadHistory = useCallback(async () => {
    if (!restaurantId) {
      setData(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams({
        restaurantId,
        startDate,
        endDate,
        page: String(page),
      })
      if (tableNumber.trim()) params.set('table', tableNumber.trim())
      if (status) params.set('status', status)
      if (orderNumber.trim()) params.set('orderNumber', orderNumber.trim())

      const res = await fetch(`/api/orders/history?${params.toString()}`)
      const json = (await res.json()) as HistoryResponse
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load order history')
      }
      setData(json)
    } catch (err: unknown) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Failed to load order history')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [restaurantId, startDate, endDate, tableNumber, status, orderNumber, page])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    setPage(1)
  }, [startDate, endDate, tableNumber, status, orderNumber])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Order History</h1>
            <p className="mt-1 text-sm text-[#6B675F]">Browse and filter past orders for your venue.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadHistory()}
            disabled={loading}
            className="border-[#E9E9E7]"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Start date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">End date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Table (optional)</label>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 5"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Status</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-full border-[#E9E9E7]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Order #</label>
              <Input
                type="number"
                min={1}
                placeholder="Search order number"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl border border-[#E9E9E7] bg-white" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800">{error}</div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Revenue</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(data?.totalRevenue || 0, currencySymbol)}
                </p>
                <p className="mt-1 text-xs text-[#8A867E]">Paid orders in range</p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Orders</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">{data?.totalOrders || 0}</p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Average Order Value</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(data?.avgOrderValue || 0, currencySymbol)}
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[#E9E9E7] bg-white">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-[#E9E9E7] bg-[#FAFAF8] text-xs uppercase tracking-wide text-[#6B675F]">
                    <tr>
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Order #</th>
                      <th className="px-4 py-3 font-medium">Table</th>
                      <th className="px-4 py-3 font-medium">Member</th>
                      <th className="px-4 py-3 font-medium">Items</th>
                      <th className="px-4 py-3 font-medium">Total</th>
                      <th className="px-4 py-3 font-medium">Payment</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.orders || []).length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-12 text-center text-[#6B675F]">
                          No orders found for the selected filters.
                        </td>
                      </tr>
                    ) : (
                      (data?.orders || []).map((order) => (
                        <tr key={order.id} className="border-b border-[#F1F0EC] last:border-0">
                          <td className="px-4 py-3 whitespace-nowrap text-[#37352F]">
                            {formatPlacedAt(order.placed_at)}
                          </td>
                          <td className="px-4 py-3 font-medium text-[#37352F]">
                            #{order.order_number ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-[#37352F]">{order.table_number ?? '—'}</td>
                          <td className="px-4 py-3 text-[#37352F]">{order.memberName || '—'}</td>
                          <td className="max-w-xs px-4 py-3 text-[#6B675F]">
                            <span className="line-clamp-2">{formatItemsSummary(order.items)}</span>
                          </td>
                          <td className="px-4 py-3 font-medium text-[#37352F]">
                            {currency(Number(order.total) || 0, currencySymbol)}
                          </td>
                          <td className="px-4 py-3 capitalize text-[#37352F]">
                            {formatPaymentMethod(order.payment_method)}
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={order.status} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-[#E9E9E7] px-4 py-3">
                <p className="text-sm text-[#6B675F]">
                  Page {data?.page || 1} of {totalPages}
                  {data?.total ? ` · ${data.total} order${data.total === 1 ? '' : 's'}` : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="border-[#E9E9E7]"
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                    className="border-[#E9E9E7]"
                  >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function OrderHistoryPage() {
  return <OrderHistoryContent />
}
