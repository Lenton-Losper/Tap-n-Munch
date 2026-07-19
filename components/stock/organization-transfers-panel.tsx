'use client'

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { OrganizationRestaurantOption, TransferListRow } from '@/lib/stock/transfer-queries'

function statusBadgeClass(status: string) {
  switch (status) {
    case 'DRAFT':
      return 'border-[#E9E9E7] bg-[#FAFAF8] text-[#37352F]'
    case 'IN_TRANSIT':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    case 'RECEIVED':
      return 'border-green-200 bg-green-50 text-green-800'
    case 'CANCELLED':
      return 'border-red-200 bg-red-50 text-red-800'
    default:
      return 'border-[#E9E9E7] bg-[#FAFAF8] text-[#37352F]'
  }
}

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function OrganizationTransfersPanel({
  transfers,
  restaurants,
}: {
  transfers: TransferListRow[]
  restaurants: OrganizationRestaurantOption[]
}) {
  const [locationId, setLocationId] = useState('all')

  const filtered = useMemo(() => {
    if (locationId === 'all') return transfers
    return transfers.filter((t) => t.fromRestaurantId === locationId || t.toRestaurantId === locationId)
  }, [transfers, locationId])

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-4 sm:p-5">
        <div className="max-w-xs space-y-1.5">
          <label className="text-xs font-medium text-[#6B675F]">Location</label>
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger className="w-full border-[#E9E9E7]">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {restaurants.map((restaurant) => (
                <SelectItem key={restaurant.id} value={restaurant.id}>
                  {restaurant.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Transfer</th>
                <th className="px-5 py-3">From</th>
                <th className="px-5 py-3">To</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Items</th>
                <th className="px-5 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-[#6B675F]">
                    No transfers for this location.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr key={row.id} className="border-t border-[#E9E9E7]">
                    <td className="px-5 py-3 font-medium text-[#37352F]">{row.transferNumber}</td>
                    <td className="px-5 py-3 text-[#37352F]">{row.fromRestaurantName}</td>
                    <td className="px-5 py-3 text-[#37352F]">{row.toRestaurantName}</td>
                    <td className="px-5 py-3">
                      <Badge className={statusBadgeClass(row.status)}>{row.status.replace('_', ' ')}</Badge>
                    </td>
                    <td className="px-5 py-3 text-[#37352F]">{row.itemCount}</td>
                    <td className="px-5 py-3 text-[#6B675F]">{formatDate(row.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
