'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getStockItemLevelAction, saveAdjustmentAction } from '@/lib/stock/actions'
import { ADJUSTMENT_TYPES, formatStockQuantity, type AdjustmentType } from '@/lib/stock/format'
import type { StockItemLevel } from '@/lib/stock/queries'

type StockAdjustmentModalProps = {
  stockItemId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (message: string) => void
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-[#6B675F]">{label}</span>
      <span className="font-medium text-[#37352F]">{value}</span>
    </div>
  )
}

function StockAdjustmentForm({
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
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('waste')
  const [quantityChange, setQuantityChange] = useState('')
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

  const parsedQuantity = Number(quantityChange)
  const hasValidQuantity =
    quantityChange.trim() !== '' && Number.isFinite(parsedQuantity) && parsedQuantity !== 0
  const previewAdjustment = hasValidQuantity ? parsedQuantity : 0
  const previewNewBalance = level ? level.currentStock + previewAdjustment : 0

  const previewValues = useMemo(() => {
    if (!level) {
      return null
    }
    return {
      current: formatStockQuantity(level.currentStock, level.unit_label),
      adjustment: hasValidQuantity
        ? formatStockQuantity(previewAdjustment, level.unit_label)
        : '—',
      newBalance: hasValidQuantity
        ? formatStockQuantity(previewNewBalance, level.unit_label)
        : '—',
    }
  }, [hasValidQuantity, level, previewAdjustment, previewNewBalance])

  const handleSave = () => {
    if (!level) return
    setSubmitError(null)

    startTransition(async () => {
      const result = await saveAdjustmentAction({
        stockItemId,
        adjustmentType,
        quantityDelta: parsedQuantity,
        notes: note,
      })

      if (result.error || !result.data) {
        setSubmitError(result.error ?? 'Failed to save adjustment.')
        return
      }

      onSaved(
        `Adjustment recorded. New balance: ${formatStockQuantity(result.data.newBalance, result.data.baseUnit)}.`,
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
            <p className="mt-1 text-sm text-[#6B675F]">
                Current stock: {formatStockQuantity(level.currentStock, level.unit_label)}
            </p>
          </div>

          {submitError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {submitError}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select
              value={adjustmentType}
              onValueChange={(value) => setAdjustmentType(value as AdjustmentType)}
            >
              <SelectTrigger className="w-full border-[#E9E9E7]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_TYPES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="quantity-change">Quantity change</Label>
            <Input
              id="quantity-change"
              type="number"
              step="any"
              value={quantityChange}
              onChange={(event) => setQuantityChange(event.target.value)}
              className="border-[#E9E9E7]"
              placeholder="e.g. -2 or 5"
            />
            <p className="text-xs text-[#6B675F]">Positive adds stock; negative removes stock.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adjustment-note">Note (optional)</Label>
            <Input
              id="adjustment-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="border-[#E9E9E7]"
            />
          </div>

          <div className="space-y-2 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">Preview</p>
            {previewValues ? (
              <div className="space-y-2">
                <PreviewRow label="Current" value={previewValues.current} />
                <PreviewRow label="Adjustment" value={previewValues.adjustment} />
                <PreviewRow label="New balance" value={previewValues.newBalance} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={loadingLevel || !!loadError || !level || !hasValidQuantity || isPending}
          className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
        >
          {isPending ? 'Saving...' : 'Save adjustment'}
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
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>
            Record a manual adjustment. This writes directly to the stock ledger.
          </DialogDescription>
        </DialogHeader>

        {open && stockItemId ? (
          <StockAdjustmentForm
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
