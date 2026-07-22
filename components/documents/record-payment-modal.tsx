'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'

type RecordPaymentModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentId: string
  documentNumber: string
  balance: number
  onRecorded: () => void
}

export function RecordPaymentModal({
  open,
  onOpenChange,
  documentId,
  documentNumber,
  balance,
  onRecorded,
}: RecordPaymentModalProps) {
  const { toast } = useToast()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setError(null)
    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Amount must be greater than 0')
      return
    }
    if (!method.trim()) {
      setError('Method is required')
      return
    }

    try {
      setSaving(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: parsedAmount,
          method: method.trim(),
          reference: reference.trim() || undefined,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to record payment')
      }

      toast({ title: 'Payment recorded', description: `NAD ${parsedAmount.toFixed(2)} recorded against ${documentNumber}.` })
      setAmount('')
      setMethod('')
      setReference('')
      onOpenChange(false)
      onRecorded()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record payment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment — {documentNumber}</DialogTitle>
          <DialogDescription>Remaining balance: NAD {balance.toFixed(2)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="payment-amount">Amount *</Label>
            <Input
              id="payment-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={saving}
              placeholder={balance.toFixed(2)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-method">Method *</Label>
            <Input
              id="payment-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={saving}
              placeholder="e.g. EFT, Cash, Card"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-reference">Reference (optional)</Label>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={saving}
              placeholder="e.g. bank transaction ref"
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => void handleSubmit()}
              disabled={saving}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Recording...
                </>
              ) : (
                'Record payment'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
