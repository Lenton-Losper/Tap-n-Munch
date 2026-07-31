'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { EditStockItemDialog } from '@/components/stock/edit-stock-item-dialog'
import { StockAdjustmentModal } from '@/components/stock/stock-adjustment-modal'
import { setStockItemActiveAction } from '@/lib/stock/actions'
import { formatLastDelivery, formatStockQuantity } from '@/lib/stock/format'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { InventorySetupData } from '@/lib/recipes/queries'
import type { StockOverviewData, StockOverviewRow } from '@/lib/stock/queries'
import { InventorySetupStockCard } from '@/components/menu/inventory-setup-ui'

function StockStatusBadge({ row }: { row: StockOverviewRow }) {
  if (!row.is_active) {
    return <span className="text-[#6B675F]">—</span>
  }

  switch (row.stockStatus) {
    case 'out_of_stock':
      return <Badge className="border-red-200 bg-red-50 text-red-800">Out of Stock</Badge>
    case 'low_stock':
      return <Badge className="border-amber-200 bg-amber-50 text-amber-800">Low Stock</Badge>
    case 'healthy':
      return <Badge className="border-green-200 bg-green-50 text-green-800">Healthy</Badge>
    case 'not_tracked':
      // computeStockStatus returns 'not_tracked' purely because par_level IS NULL -- it says
      // nothing about whether any menu item is linked to this stock item. Labelling it
      // "Not tracked" collided with Menu Management's tracking badge and had a merchant
      // believing a correct, actively-deducting link had failed. Name the actual condition.
      return (
        <Badge
          variant="outline"
          title="No par level set for this item, so it cannot be reported as low or healthy. This does not affect whether menu items deduct it."
          className="border-[#E9E9E7] text-[#6B675F]"
        >
          No par level
        </Badge>
      )
    default:
      return <span className="text-[#6B675F]">—</span>
  }
}

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
  canManage = false,
  showInactive = false,
  measurementUnits = [],
  inventorySetup = null,
}: {
  data: StockOverviewData
  successMessage?: string | null
  canAdjust?: boolean
  canManage?: boolean
  showInactive?: boolean
  measurementUnits?: MeasurementUnitOption[]
  inventorySetup?: InventorySetupData | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [successMessage, setSuccessMessage] = useState<string | null>(initialSuccessMessage ?? null)
  const [adjustItemId, setAdjustItemId] = useState<string | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [editItem, setEditItem] = useState<StockOverviewRow | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [measurementUnitsState, setMeasurementUnitsState] = useState(measurementUnits)

  const showActions = canAdjust || canManage

  const openAdjustment = (stockItemId: string) => {
    setAdjustItemId(stockItemId)
    setAdjustOpen(true)
  }

  const openEdit = (row: StockOverviewRow) => {
    setEditItem(row)
    setEditOpen(true)
  }

  const handleAdjustmentSaved = (message: string) => {
    setSuccessMessage(message)
    router.refresh()
  }

  const handleItemSaved = (message: string) => {
    setSuccessMessage(message)
    router.refresh()
  }

  const handleShowInactiveChange = (checked: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    if (checked) {
      params.set('showInactive', '1')
    } else {
      params.delete('showInactive')
    }
    const query = params.toString()
    router.push(query ? `/stock?${query}` : '/stock')
  }

  const handleSetActive = async (row: StockOverviewRow, isActive: boolean) => {
    setTogglingId(row.id)
    setActionError(null)
    const result = await setStockItemActiveAction({ stockItemId: row.id, isActive })
    setTogglingId(null)

    if (result.error) {
      setActionError(result.error)
      return
    }

    setSuccessMessage(
      isActive ? `Reactivated ${row.name}.` : `Deactivated ${row.name}. It is hidden from new deliveries and ingredient lists.`,
    )
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
      {actionError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {actionError}
        </div>
      ) : null}

      <div className={`grid gap-4 ${inventorySetup ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
        <SummaryCard label="Tracked items" value={data.trackedItems} />
        <SummaryCard label="Low stock" value={data.lowStock} />
        <SummaryCard label="Last delivery" value={formatLastDelivery(data.lastDeliveryAt)} />
        {inventorySetup ? <InventorySetupStockCard setup={inventorySetup} /> : null}
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white">
        <div className="flex flex-col gap-3 border-b border-[#E9E9E7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold text-[#37352F]">Current stock</h2>
            <p className="mt-1 text-sm text-[#6B675F]">Tracked items with current balances.</p>
          </div>
          {canManage ? (
            <div className="flex items-center gap-2">
              <Switch
                id="show-inactive-items"
                checked={showInactive}
                onCheckedChange={handleShowInactiveChange}
              />
              <Label htmlFor="show-inactive-items" className="text-sm text-[#6B675F]">
                Show inactive items
              </Label>
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Current stock</th>
                <th className="px-5 py-3">Unit</th>
                <th className="px-5 py-3">Status</th>
                {showActions ? <th className="px-5 py-3 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={showActions ? 5 : 4} className="px-5 py-8 text-center text-[#6B675F]">
                    {showInactive
                      ? 'No inactive items.'
                      : 'No tracked items yet. Record a delivery to get started.'}
                  </td>
                </tr>
              ) : (
                data.rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-t border-[#E9E9E7] ${!row.is_active ? 'bg-[#FAFAF8]/80' : ''}`}
                  >
                    <td className="px-5 py-3 font-medium text-[#37352F]">
                      <span>{row.name}</span>
                      {!row.is_active ? (
                        <Badge className="ml-2 border-[#E9E9E7] bg-white text-[#6B675F]">Inactive</Badge>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-[#37352F]">
                      {formatStockQuantity(row.currentStock, row.unit_label)}
                    </td>
                    <td className="px-5 py-3 text-[#6B675F]">{row.unit_label}</td>
                    <td className="px-5 py-3">
                      <StockStatusBadge row={row} />
                    </td>
                    {showActions ? (
                      <td className="px-5 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {canManage && row.is_active ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-[#E9E9E7]"
                                onClick={() => openEdit(row)}
                              >
                                Edit
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-[#E9E9E7] text-amber-800 hover:bg-amber-50"
                                disabled={togglingId === row.id}
                                onClick={() => void handleSetActive(row, false)}
                              >
                                {togglingId === row.id ? 'Saving...' : 'Deactivate'}
                              </Button>
                            </>
                          ) : null}
                          {canManage && !row.is_active ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="border-[#E9E9E7]"
                              disabled={togglingId === row.id}
                              onClick={() => void handleSetActive(row, true)}
                            >
                              {togglingId === row.id ? 'Saving...' : 'Reactivate'}
                            </Button>
                          ) : null}
                          {canAdjust && row.is_active ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="border-[#E9E9E7]"
                              onClick={() => openAdjustment(row.id)}
                            >
                              Count Inventory
                            </Button>
                          ) : null}
                        </div>
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

      {canManage ? (
        <EditStockItemDialog
          item={editItem}
          open={editOpen}
          onOpenChange={setEditOpen}
          measurementUnits={measurementUnitsState}
          onMeasurementUnitsChange={setMeasurementUnitsState}
          onSaved={handleItemSaved}
        />
      ) : null}
    </div>
  )
}
