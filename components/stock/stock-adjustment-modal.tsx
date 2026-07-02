'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getStockItemLevelAction, saveStockCountAction } from '@/lib/stock/actions'
import { formatSignedStockDelta, formatStockQuantity } from '@/lib/stock/format'
import type { StockItemLevel } from '@/lib/stock/queries'

type StockAdjustmentModalProps = {
  stockItemId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (message: string) => void
}

function StockCountForm({
  stockItemId,
  onOpenChange,
  onSaved,
}: {
  stockItemId: string
  onOpenChange: (open: boolean) => void
  onSaved: (message: string) => void
}) {
  const [level, setLevel] = useState<StockItemLevel | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingLevel, setLoadingLevel] = useState(true)
  const [actualCount, setActualCount] = useState('')
  const [note, setNote] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  /* eslint-disable react-hooks/set-state-in-effect -- load stock level when modal opens */
  useEffect(() => {
    let cancelled = false
    setLoadingLevel(true)
    setLoadError(null)
    setLevel(null)

    void getStockItemLevelAction(stockItemId).then((result) => {
      if (cancelled) return
      setLoadingLevel(false)
      if (result.error || !result.data) {
        setLoadError(result.error ?? 'Failed to load stock level.')
        return
      }
      setLevel(result.data)
    })

    return () => {
      cancelled = true
    }
  }, [stockItemId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const parsedActualCount = Number(actualCount)
  const hasValidActualCount =
    actualCount.trim() !== '' && Number.isFinite(parsedActualCount) && parsedActualCount >= 0

  const previewDelta = useMemo(() => {
    if (!level || !hasValidActualCount) return null
    return parsedActualCount - level.currentStock
  }, [hasValidActualCount, level, parsedActualCount])

  const noChange = previewDelta === 0

  const handleSave = () => {
    if (!level || !hasValidActualCount || noChange) return
    setSubmitError(null)

    startTransition(async () => {
      const result = await saveStockCountAction({
        stockItemId,
        actualCount: parsedActualCount,
        notes: note,
      })

      if (result.error || !result.data) {
        setSubmitError(result.error ?? 'Failed to save count.')
        return
      }

      onSaved(
        `Count saved. ${result.data.itemName} is now ${formatStockQuantity(result.data.newBalance, result.data.baseUnit)}.`,
      )
      onOpenChange(false)
    })
  }

  return (
    <>
      {loadingLevel ? (
        <p className="text-sm text-[#6B675F]">Loading current stock…</p>
      ) : loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : level ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] px-4 py-3">
            <p className="font-medium text-[#37352F]">{level.name}</p>
            <p className="mt-1 text-sm text-[#6B675F]">Unit: {level.unit_label}</p>
            <p className="mt-1 text-sm text-[#37352F]">
              System shows: {formatStockQuantity(level.currentStock, level.unit_label)}
            </p>
          </div>

          {submitError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {submitError}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="actual-count">Actual Count</Label>
            <Input
              id="actual-count"
              type="number"
              min="0"
              step="any"
              value={actualCount}
              onChange={(event) => setActualCount(event.target.value)}
              className="border-[#E9E9E7]"
              placeholder={`e.g. ${level.currentStock}`}
            />
            <p className="text-xs text-[#6B675F]">
              Enter the quantity you physically counted — not a plus/minus adjustment.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="count-note">Note (optional)</Label>
            <Input
              id="count-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="border-[#E9E9E7]"
              placeholder="e.g. Weekly shelf count"
            />
          </div>

          {hasValidActualCount ? (
            <div
              className={`rounded-xl border px-4 py-3 text-sm ${
                noChange
                  ? 'border-[#E9E9E7] bg-[#FAFAF8] text-[#6B675F]'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              {noChange ? (
                <p>No change — actual count matches system stock.</p>
              ) : previewDelta != null ? (
                <p>
                  This will adjust stock by{' '}
                  <span className="font-medium">
                    {formatSignedStockDelta(previewDelta, level.unit_label)}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={
            loadingLevel ||
            !!loadError ||
            !level ||
            !hasValidActualCount ||
            noChange ||
            isPending
          }
          className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
        >
          {isPending ? 'Saving...' : noChange && hasValidActualCount ? 'No change' : 'Save Count'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function StockAdjustmentModal({
  stockItemId,
  open,
  onOpenChange,
  onSaved,
}: StockAdjustmentModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#E9E9E7] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Count Inventory</DialogTitle>
          <DialogDescription>
            Enter what you physically counted. We&apos;ll compute the adjustment from the system
            balance.
          </DialogDescription>
        </DialogHeader>

        {open && stockItemId ? (
          <StockCountForm
            key={stockItemId}
            stockItemId={stockItemId}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
