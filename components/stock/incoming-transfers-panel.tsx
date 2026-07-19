'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { receiveTransferAction, type ReceivedQuantityInput } from '@/lib/stock/transfer-actions'
import { formatStockQuantity } from '@/lib/stock/format'
import type { TransferDetail } from '@/lib/stock/transfer-queries'

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

type DraftQuantities = Record<string, string>
type DraftReasons = Record<string, string>

function ReportDifferenceForm({
  transfer,
  onSubmitted,
  onCancel,
}: {
  transfer: TransferDetail
  onSubmitted: () => void
  onCancel: () => void
}) {
  const [quantities, setQuantities] = useState<DraftQuantities>(() =>
    Object.fromEntries(transfer.items.map((item) => [item.id, String(item.quantitySent)])),
  )
  const [reasons, setReasons] = useState<DraftReasons>({})
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    setError(null)

    const overrides: ReceivedQuantityInput[] = []
    for (const item of transfer.items) {
      const raw = quantities[item.id] ?? String(item.quantitySent)
      const quantityReceived = Number(raw)
      if (!Number.isFinite(quantityReceived) || quantityReceived < 0) {
        setError(`Enter a valid received quantity for ${item.itemName}.`)
        return
      }
      const varianceReason = reasons[item.id]?.trim() ?? ''
      if (quantityReceived !== item.quantitySent && !varianceReason) {
        setError(`A reason is required for ${item.itemName} — sent ${item.quantitySent}, received ${quantityReceived}.`)
        return
      }
      overrides.push({
        stockTransferItemId: item.id,
        quantityReceived,
        varianceReason: varianceReason || undefined,
      })
    }

    startTransition(async () => {
      const result = await receiveTransferAction(transfer.id, overrides)
      if ('error' in result) {
        setError(result.error)
        return
      }
      onSubmitted()
    })
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4">
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      ) : null}
      {transfer.items.map((item) => {
        const quantityReceived = Number(quantities[item.id] ?? item.quantitySent)
        const varies = quantityReceived !== item.quantitySent
        return (
          <div key={item.id} className="grid gap-3 rounded-lg border border-[#E9E9E7] bg-white p-3 sm:grid-cols-[2fr_1fr_2fr]">
            <div>
              <p className="font-medium text-[#37352F]">{item.itemName}</p>
              <p className="text-xs text-[#6B675F]">Sent: {formatStockQuantity(item.quantitySent, item.unitLabel)}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`received-${item.id}`}>Received</Label>
              <Input
                id={`received-${item.id}`}
                type="number"
                min="0"
                step="any"
                value={quantities[item.id] ?? ''}
                onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                className="border-[#E9E9E7] bg-white"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`reason-${item.id}`}>
                Variance reason{varies ? ' (required)' : ' (optional)'}
              </Label>
              <Input
                id={`reason-${item.id}`}
                value={reasons[item.id] ?? ''}
                onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))}
                placeholder={varies ? 'e.g. Damaged in transit' : ''}
                className="border-[#E9E9E7] bg-white"
              />
            </div>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={handleSubmit}
          className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
        >
          {isPending ? 'Saving...' : 'Submit received quantities'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} className="border-[#E9E9E7]">
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function IncomingTransfersPanel({
  transfers,
  canReceive,
}: {
  transfers: TransferDetail[]
  canReceive: boolean
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [reportingId, setReportingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleConfirmAll = (transferId: string) => {
    setBusyId(transferId)
    setRowErrors((current) => ({ ...current, [transferId]: '' }))

    startTransition(async () => {
      const result = await receiveTransferAction(transferId)
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
        No incoming transfers awaiting receipt.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {transfers.map((transfer) => {
        const busy = busyId === transfer.id && isPending
        const rowError = rowErrors[transfer.id]
        const reporting = reportingId === transfer.id

        return (
          <div key={transfer.id} className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[#37352F]">{transfer.transferNumber}</span>
                  <Badge className="border-blue-200 bg-blue-50 text-blue-800">IN TRANSIT</Badge>
                </div>
                <p className="mt-1 text-sm text-[#6B675F]">
                  From {transfer.fromRestaurantName} · {transfer.itemCount}{' '}
                  {transfer.itemCount === 1 ? 'item' : 'items'} · Dispatched {formatDate(transfer.dispatchedAt)}
                </p>
              </div>

              {!reporting && canReceive ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleConfirmAll(transfer.id)}
                    className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
                  >
                    {busy ? 'Confirming...' : 'Confirm all received'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setReportingId(transfer.id)}
                    className="border-[#E9E9E7]"
                  >
                    Report difference
                  </Button>
                </div>
              ) : null}
            </div>

            {rowError ? (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {rowError}
              </div>
            ) : null}

            {reporting ? (
              <ReportDifferenceForm
                transfer={transfer}
                onCancel={() => setReportingId(null)}
                onSubmitted={() => {
                  setReportingId(null)
                  router.refresh()
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
