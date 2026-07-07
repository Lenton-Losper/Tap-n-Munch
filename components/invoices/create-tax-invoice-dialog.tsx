'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TaxInvoiceRequestFields } from '@/components/invoices/tax-invoice-request-fields'
import {
  buildInvoiceDetailsFromForm,
  EMPTY_TAX_INVOICE_FORM,
  showFnbCorporateFields,
  type TaxInvoiceFormValues,
} from '@/lib/invoices/invoice-preference'
import { getAccessToken } from '@/lib/onboarding/api-client'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  restaurantShortCode?: string | null
  onSuccess?: (result: { is_resend?: boolean; invoice_number?: string | null }) => void
}

export function CreateTaxInvoiceDialog({
  open,
  onOpenChange,
  orderId,
  restaurantShortCode,
  onSuccess,
}: Props) {
  const [enabled, setEnabled] = useState(true)
  const [values, setValues] = useState<TaxInvoiceFormValues>(EMPTY_TAX_INVOICE_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showFnbFields = showFnbCorporateFields(restaurantShortCode)

  const handleSubmit = async () => {
    if (!enabled) {
      setError('Enable the tax invoice option to continue.')
      return
    }

    const email = values.email.trim()
    if (!email) {
      setError('Invoice email is required.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const token = await getAccessToken()
      const details = buildInvoiceDetailsFromForm(values, showFnbFields)
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email: details.email,
          company_name: details.company_name,
          vat_number: details.vat_number,
          metadata: details.metadata,
        }),
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to request tax invoice')
      }

      onSuccess?.({
        is_resend: data?.is_resend === true,
        invoice_number: data?.invoice_number ?? null,
      })
      onOpenChange(false)
      setValues(EMPTY_TAX_INVOICE_FORM)
      setEnabled(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request tax invoice')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Tax Invoice</DialogTitle>
          <DialogDescription>
            Send a company tax invoice for this paid order. If one was already requested, we will resend it.
          </DialogDescription>
        </DialogHeader>

        <TaxInvoiceRequestFields
          enabled={enabled}
          onEnabledChange={setEnabled}
          values={values}
          onChange={setValues}
          showFnbFields={showFnbFields}
          disabled={submitting}
        />

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Send Tax Invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
