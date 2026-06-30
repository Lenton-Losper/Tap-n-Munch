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
import { MOVEMENT_REASONS, formatReasonLabel, formatRelativeMovementTime, formatUnitCost } from '@/lib/stock/format'
import type { MovementHistoryRow } from '@/lib/stock/queries'
import type { StockItemOption } from '@/lib/stock/queries'

function reasonBadgeClass(reason: string) {
  switch (reason) {
    case 'received':
      return 'border-green-200 bg-green-50 text-green-800'
    case 'loss':
    case 'theft':
      return 'border-red-200 bg-red-50 text-red-800'
    case 'adjustment':
    case 'recount':
      return 'border-amber-200 bg-amber-50 text-amber-800'
    case 'sale':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    default:
      return 'border-[#E9E9E7] bg-[#FAFAF8] text-[#37352F]'
  }
}

export function MovementHistoryPanel({
  rows,
  stockItems,
  showUnitCost = false,
}: {
  rows: MovementHistoryRow[]
  stockItems: StockItemOption[]
  showUnitCost?: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const stockItemId = searchParams.get('stockItemId') ?? 'all'
  const reason = searchParams.get('reason') ?? 'all'
  const dateRange = searchParams.get('dateRange') ?? '30d'

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all' || (key === 'dateRange' && value === '30d')) {
      params.delete(key)
    } else {
      params.set(key, value)
    }
    const query = params.toString()
    router.replace(query ? `/stock/history?${query}` : '/stock/history')
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#6B675F]">Stock item</label>
            <Select value={stockItemId} onValueChange={(value) => updateFilter('stockItemId', value)}>
              <SelectTrigger className="w-full border-[#E9E9E7]">
                <SelectValue placeholder="All items" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All items</SelectItem>
                {stockItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#6B675F]">Reason</label>
            <Select value={reason} onValueChange={(value) => updateFilter('reason', value)}>
              <SelectTrigger className="w-full border-[#E9E9E7]">
                <SelectValue placeholder="All reasons" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {MOVEMENT_REASONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {formatReasonLabel(option)}
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
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Change</th>
                <th className="px-5 py-3">Reason</th>
                <th className="px-5 py-3">Reference</th>
                {showUnitCost ? <th className="px-5 py-3">Unit cost</th> : null}
                <th className="px-5 py-3">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={showUnitCost ? 6 : 5} className="px-5 py-8 text-center text-[#6B675F]">
                    No movements match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const positive = row.quantityDelta > 0
                  const signed =
                    row.quantityDelta > 0
                      ? `+${row.quantityDelta}`
                      : String(row.quantityDelta)
                  return (
                    <tr key={row.id} className="border-t border-[#E9E9E7]">
                      <td className="px-5 py-3 font-medium text-[#37352F]">{row.itemName}</td>
                      <td
                        className={`px-5 py-3 font-medium ${
                          positive ? 'text-green-700' : row.quantityDelta < 0 ? 'text-red-700' : 'text-[#37352F]'
                        }`}
                      >
                        {signed}
                      </td>
                      <td className="px-5 py-3">
                        <Badge className={reasonBadgeClass(row.reason)}>
                          {formatReasonLabel(row.reason)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 text-[#37352F]">{row.referenceLabel}</td>
                      {showUnitCost ? (
                        <td className="px-5 py-3 text-[#37352F]">{formatUnitCost(row.unitCost)}</td>
                      ) : null}
                      <td className="px-5 py-3 text-[#6B675F]">
                        {formatRelativeMovementTime(row.createdAt)}
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
