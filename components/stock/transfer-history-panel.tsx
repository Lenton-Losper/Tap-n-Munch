'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  OrganizationStockItemOption,
  TransferListRow,
  TransferStatus,
} from '@/lib/stock/transfer-queries'

function statusBadgeClass(status: TransferStatus) {
  return status === 'RECEIVED'
    ? 'border-green-200 bg-green-50 text-green-800'
    : 'border-red-200 bg-red-50 text-red-800'
}

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function TransferHistoryPanel({
  rows,
  orgItems,
  restaurantId,
}: {
  rows: TransferListRow[]
  orgItems: OrganizationStockItemOption[]
  restaurantId: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const itemId = searchParams.get('itemId') ?? 'all'
  const dateRange = searchParams.get('dateRange') ?? '30d'

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all' || (key === 'dateRange' && value === '30d')) {
      params.delete(key)
    } else {
      params.set(key, value)
    }
    const query = params.toString()
    router.replace(query ? `/stock/transfers/history?${query}` : '/stock/transfers/history')
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#6B675F]">Item</label>
            <Select value={itemId} onValueChange={(value) => updateFilter('itemId', value)}>
              <SelectTrigger className="w-full border-[#E9E9E7]">
                <SelectValue placeholder="All items" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All items</SelectItem>
                {orgItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#6B675F]">Date range</label>
            <Select value={dateRange} onValueChange={(value) => updateFilter('dateRange', value)}>
              <SelectTrigger className="w-full border-[#E9E9E7]">
                <SelectValue placeholder="Last 30 days" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Transfer</th>
                <th className="px-5 py-3">Direction</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Items</th>
                <th className="px-5 py-3">Completed</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-[#6B675F]">
                    No completed transfers match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const outgoing = row.fromRestaurantId === restaurantId
                  return (
                    <tr key={row.id} className="border-t border-[#E9E9E7]">
                      <td className="px-5 py-3 font-medium text-[#37352F]">{row.transferNumber}</td>
                      <td className="px-5 py-3 text-[#37352F]">
                        {outgoing ? `To ${row.toRestaurantName}` : `From ${row.fromRestaurantName}`}
                      </td>
                      <td className="px-5 py-3">
                        <Badge className={statusBadgeClass(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="px-5 py-3 text-[#37352F]">{row.itemCount}</td>
                      <td className="px-5 py-3 text-[#6B675F]">
                        {formatDate(row.status === 'RECEIVED' ? row.receivedAt : row.createdAt)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
