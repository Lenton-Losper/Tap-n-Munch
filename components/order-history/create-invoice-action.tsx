'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
/**
 * `getAccessToken` from the onboarding client, NOT `getSettingsAccessToken`. The two are
 * byte-for-byte the same function, but settings-utils constructs a browser Supabase client at
 * MODULE LOAD, which throws under jest's node environment and took
 * __tests__/order-history-date-filters.test.tsx down with 'Test suite failed to run' the moment
 * this component was imported into the page. order-history-content.tsx already imports this one.
 */
import { getAccessToken } from '@/lib/onboarding/api-client'

/**
 * "Create invoice" on an Order History row.
 *
 * ================================================================================================
 * THIS IS A DOCUMENT CONTROL. IT IS NOT A PAYMENT CONTROL.
 * ================================================================================================
 *
 * It calls exactly one endpoint, POST /api/admin/documents/from-order, which creates one
 * business_documents row. It cannot charge a card, cannot mark an order paid, and cannot request
 * payment from anyone. Order History remains a reporting surface with a document action on it, not
 * a payment-collection page — that is a separate feature and is deliberately not started here.
 *
 * The only figures shown come back from the server. Nothing about the amount, the VAT or the total
 * is computed in this component, and nothing about them is sent to the server.
 */

const FIELD_LABELS: Record<string, string> = {
  registration_number: 'Company registration number',
  vat_number: 'VAT number',
}

type BillTo = { name: string; email: string; address: string }

type Created = { id: string; document_number: string; status: string }

export function CreateInvoiceAction({
  orderId,
  restaurantId,
  orderStatus,
  orderNumber,
}: {
  orderId: string
  restaurantId: string | null
  orderStatus: string | null | undefined
  orderNumber: number | null | undefined
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [billTo, setBillTo] = useState<BillTo>({ name: '', email: '', address: '' })

  /**
   * The server is the authority on eligibility and refuses anything else with a reason. This only
   * avoids offering a control that is certain to be refused — it is not the check.
   */
  const looksEligible =
    String(orderStatus ?? '').toLowerCase() === 'completed' && Boolean(restaurantId)
  if (!looksEligible) return <span className="text-xs text-[#8A867E]">—</span>

  async function createInvoice() {
    if (busy) return
    setBusy(true)
    try {
      const token = await getAccessToken()
      const response = await fetch('/api/admin/documents/from-order', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          restaurant_id: restaurantId,
          bill_to: {
            name: billTo.name.trim(),
            email: billTo.email.trim(),
            address: billTo.address.trim(),
          },
        }),
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        /**
         * An incomplete billing profile is the one refusal a manager can act on immediately, so it
         * says exactly which Settings fields are missing rather than "not configured".
         */
        if (payload?.code === 'BILLING_PROFILE_INCOMPLETE') {
          const missing: string[] = Array.isArray(payload.missingBillingFields)
            ? payload.missingBillingFields
            : []
          toast({
            title: 'Add your business details first',
            description: missing.length
              ? `Settings → Billing still needs: ${missing
                  .map((f) => FIELD_LABELS[f] ?? f)
                  .join(', ')}.`
              : String(payload.error ?? 'Billing details are incomplete.'),
            variant: 'destructive',
          })
          return
        }
        if (payload?.code === 'INVOICE_ALREADY_EXISTS' && payload.existingDocument) {
          setCreated(payload.existingDocument as Created)
          toast({
            title: 'Already invoiced',
            description: `Invoice ${payload.existingDocument.document_number} covers this order.`,
          })
          return
        }
        throw new Error(payload?.error || 'Could not create the invoice')
      }

      const doc = payload.document as Created
      setCreated(doc)
      setOpen(false)
      toast({ title: `Invoice ${doc.document_number} created`, description: 'It has not been sent yet.' })
    } catch (error: unknown) {
      toast({
        title: 'Could not create the invoice',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  async function downloadPdf(documentId: string, documentNumber: string) {
    try {
      const token = await getAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('Could not download the PDF')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `Invoice-${documentNumber}.pdf`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error: unknown) {
      toast({
        title: 'Download failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  if (created) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[#37352F]">#{created.document_number}</span>
        <button
          type="button"
          onClick={() => void downloadPdf(created.id, created.document_number)}
          className="text-left text-xs text-[#2F6F62] underline underline-offset-2"
        >
          Download PDF
        </button>
      </div>
    )
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen(true)}>
        Create invoice
      </Button>
    )
  }

  return (
    <div className="flex w-56 flex-col gap-1.5 rounded border border-[#E9E9E7] bg-white p-2">
      <p className="text-xs text-[#6B675F]">Invoice for order #{orderNumber ?? '—'}</p>
      <input
        id={`invoice-billto-name-${orderId}`}
        className="rounded border border-[#E9E9E7] px-2 py-1 text-xs"
        placeholder="Bill to (name)"
        value={billTo.name}
        onChange={(e) => setBillTo((c) => ({ ...c, name: e.target.value }))}
      />
      <input
        id={`invoice-billto-email-${orderId}`}
        className="rounded border border-[#E9E9E7] px-2 py-1 text-xs"
        placeholder="Email (for sending)"
        value={billTo.email}
        onChange={(e) => setBillTo((c) => ({ ...c, email: e.target.value }))}
      />
      <input
        id={`invoice-billto-address-${orderId}`}
        className="rounded border border-[#E9E9E7] px-2 py-1 text-xs"
        placeholder="Address (optional)"
        value={billTo.address}
        onChange={(e) => setBillTo((c) => ({ ...c, address: e.target.value }))}
      />
      {/*
        Said on the screen, not only in the code: an address typed here is snapshotted onto THIS
        invoice and is not kept against the customer or the order. FlashTap holds no customer
        contact record, and this control deliberately does not create one.
      */}
      <p className="text-[10px] leading-snug text-[#8A867E]">
        Used on this invoice only. FlashTap does not save customer contact details.
      </p>
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 flex-1 text-xs" disabled={busy} onClick={() => void createInvoice()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
