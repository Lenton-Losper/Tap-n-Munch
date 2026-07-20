'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ConfigureCanonicalItemDialog,
  type ConfigureCanonicalItemTarget,
} from '@/components/stock/configure-canonical-item-dialog'
import { cancelTransferAction, dispatchTransferAction, type UnconfiguredItemInfo } from '@/lib/stock/transfer-actions'
import type { TransferListRow } from '@/lib/stock/transfer-queries'

function statusBadgeClass(status: string) {
  switch (status) {
    case 'DRAFT':
      return 'border-[#E9E9E7] bg-[#FAFAF8] text-[#37352F]'
    case 'IN_TRANSIT':
      return 'border-blue-200 bg-blue-50 text-blue-800'
    default:
      return 'border-[#E9E9E7] bg-[#FAFAF8] text-[#37352F]'
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function OutgoingTransfersPanel({
  transfers,
  canDispatch,
  canCancel,
}: {
  transfers: TransferListRow[]
  canDispatch: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [unconfiguredByRow, setUnconfiguredByRow] = useState<Record<string, UnconfiguredItemInfo[]>>({})
  const [configureTarget, setConfigureTarget] = useState<ConfigureCanonicalItemTarget | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleDispatch = (transferId: string) => {
    setBusyId(transferId)
    setRowErrors((current) => ({ ...current, [transferId]: '' }))
    setUnconfiguredByRow((current) => ({ ...current, [transferId]: [] }))

    startTransition(async () => {
      const result = await dispatchTransferAction(transferId)
      setBusyId(null)
      if ('error' in result) {
        setRowErrors((current) => ({ ...current, [transferId]: result.error }))
        if (result.unconfiguredItems?.length) {
          setUnconfiguredByRow((current) => ({ ...current, [transferId]: result.unconfiguredItems! }))
        }
        return
      }
      router.refresh()
    })
  }

  const handleCancel = (transferId: string) => {
    if (!window.confirm('Cancel this draft transfer? This cannot be undone.')) return
    setBusyId(transferId)
    setRowErrors((current) => ({ ...current, [transferId]: '' }))

    startTransition(async () => {
      const result = await cancelTransferAction(transferId)
      setBusyId(null)
      if ('error' in result) {
        setRowErrors((current) => ({ ...current, [transferId]: result.error }))
        return
      }
      router.refresh()
    })
  }

  if (transfers.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-8 text-center text-sm text-[#6B675F]">
        No outgoing transfers in progress.
      </div>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {transfers.map((transfer) => {
          const busy = busyId === transfer.id && isPending
          const rowError = rowErrors[transfer.id]
          const unconfigured = unconfiguredByRow[transfer.id] ?? []

          return (
            <div key={transfer.id} className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#37352F]">{transfer.transferNumber}</span>
                    <Badge className={statusBadgeClass(transfer.status)}>{transfer.status.replace('_', ' ')}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-[#6B675F]">
                    To {transfer.toRestaurantName} · {transfer.itemCount}{' '}
                    {transfer.itemCount === 1 ? 'item' : 'items'} · Created {formatDate(transfer.createdAt)}
                  </p>
                </div>

                {transfer.status === 'DRAFT' ? (
                  <div className="flex flex-wrap gap-2">
                    {canDispatch ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleDispatch(transfer.id)}
                        className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
                      >
                        {busy ? 'Dispatching...' : 'Dispatch'}
                      </Button>
                    ) : null}
                    {canCancel ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => handleCancel(transfer.id)}
                        className="border-[#E9E9E7]"
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {rowError ? (
                <div className="mt-3 space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <p>{unconfigured.length ? 'Some items in this transfer are not configured yet:' : rowError}</p>
                  {unconfigured.map((item) => (
                    <div
                      key={`${item.organizationStockItemId}-${item.missingAtRestaurantId}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-white px-3 py-2"
                    >
                      <span>
                        <span className="font-medium">{item.itemName}</span> is not configured at{' '}
                        {item.missingAtRestaurantName}
                      </span>
                      <button
                        type="button"
                        className="text-xs font-medium text-[#FF6B35] hover:underline"
                        onClick={() => {
                          setConfigureTarget({
                            organizationStockItemId: item.organizationStockItemId,
                            itemName: item.itemName,
                            baseUnitId: item.baseUnitId,
                            baseUnitLabel: item.baseUnitLabel,
                            restaurantId: item.missingAtRestaurantId,
                            restaurantName: item.missingAtRestaurantName,
                          })
                          setConfigureOpen(true)
                        }}
                      >
                        Configure at {item.missingAtRestaurantName}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <ConfigureCanonicalItemDialog
        target={configureTarget}
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        onConfigured={() => {
          router.refresh()
        }}
      />
    </>
  )
}
