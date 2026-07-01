'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StockAdjustmentModal } from '@/components/stock/stock-adjustment-modal'
import { formatLastDelivery, formatStockQuantity } from '@/lib/stock/format'
import type { StockOverviewData } from '@/lib/stock/queries'

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">{label}</p>
      <p className="mt-2 font-serif text-3xl font-semibold text-[#37352F]">{value}</p>
    </div>
  )
}

export function StockOverviewPanel({
  data,
  successMessage: initialSuccessMessage,
  canAdjust = false,
}: {
  data: StockOverviewData
  successMessage?: string | null
  canAdjust?: boolean
}) {
  const router = useRouter()
  const [successMessage, setSuccessMessage] = useState<string | null>(initialSuccessMessage ?? null)
  const [adjustItemId, setAdjustItemId] = useState<string | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)

  const openAdjustment = (stockItemId: string) => {
    setAdjustItemId(stockItemId)
    setAdjustOpen(true)
  }

  const handleAdjustmentSaved = (message: string) => {
    setSuccessMessage(message)
    router.refresh()
  }

  const displayMessage = successMessage ?? initialSuccessMessage

  return (
    <div className="space-y-6">
      {displayMessage ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {displayMessage}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Tracked items" value={data.trackedItems} />
        <SummaryCard label="Low stock" value={data.lowStock} />
        <SummaryCard label="Last delivery" value={formatLastDelivery(data.lastDeliveryAt)} />
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white">
        <div className="border-b border-[#E9E9E7] px-5 py-4">
          <h2 className="font-serif text-xl font-semibold text-[#37352F]">Current stock</h2>
          <p className="mt-1 text-sm text-[#6B675F]">Tracked items with current balances.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Current stock</th>
                <th className="px-5 py-3">Base unit</th>
                <th className="px-5 py-3">Status</th>
                {canAdjust ? <th className="px-5 py-3 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={canAdjust ? 5 : 4} className="px-5 py-8 text-center text-[#6B675F]">
                    No tracked items yet. Receive stock to get started.
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr key={row.id} className="border-t border-[#E9E9E7]">
                    <td className="px-5 py-3 font-medium text-[#37352F]">{row.name}</td>
                    <td className="px-5 py-3 text-[#37352F]">
                      {formatStockQuantity(row.currentStock, row.unit_label)}
                    </td>
                    <td className="px-5 py-3 text-[#6B675F]">{row.unit_label}</td>
                    <td className="px-5 py-3">
                      {row.isLow ? (
                        <Badge className="border-amber-200 bg-amber-50 text-amber-800">Low</Badge>
                      ) : (
                        <span className="text-[#6B675F]">—</span>
                      )}
                    </td>
                    {canAdjust ? (
                      <td className="px-5 py-3 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-[#E9E9E7]"
                          onClick={() => openAdjustment(row.id)}
                        >
                          Adjust
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <StockAdjustmentModal
        stockItemId={adjustItemId}
        open={adjustOpen && canAdjust}
        onOpenChange={setAdjustOpen}
        onSaved={handleAdjustmentSaved}
      />
    </div>
  )
}
