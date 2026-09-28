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
 * "Create invoice" on an Order History row -- for the order, or for the whole tab it belongs to.
 *
 * ================================================================================================
 * THIS IS A DOCUMENT CONTROL. IT IS NOT A PAYMENT CONTROL.
 * ================================================================================================
 *
 * It calls POST /api/admin/documents/from-order, which creates one business_documents row, and,
 * when asked, the EXISTING send route (POST /api/admin/documents/[id]/send) to email it to the
 * address typed here. It cannot charge a card, cannot mark an order paid, and cannot request
 * payment from anyone. Order History remains a reporting surface with a document action on it.
 *
 * The only figures shown come back from the server. Nothing about the amount, the VAT or the total
 * is computed in this component, and nothing about them is sent to the server.
 *
 * ELIGIBILITY IS THE SERVER'S. This used to hide the control unless the order was 'completed',
 * which was the old rule. The rule is now "can this bill still change?" (see
 * lib/documents/invoice-projection.ts), which depends on line states this row does not carry, so
 * the control is offered for any order that is not cancelled, and the server's refusal -- which
 * says what to do -- is shown as it is.
 */

const FIELD_LABELS: Record<string, string> = {
  registration_number: 'Company registration number',
  vat_number: 'VAT number',
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid',
  partially_paid: 'Partially paid',
  draft: 'Unpaid · not sent',
  sent: 'Unpaid · sent',
  overdue: 'Overdue',
  void: 'Void',
}

type BillTo = { name: string; email: string; address: string }

type Created = { id: string; document_number: string; status: string }

type Scope = 'order' | 'tab'

export function CreateInvoiceAction({
  orderId,
  tabId,
  restaurantId,
  orderStatus,
  orderNumber,
}: {
  orderId: string
  /** The tab this order is on, when it is on one -- offers "Invoice whole tab". */
  tabId?: string | null
  restaurantId: string | null
  orderStatus: string | null | undefined
  orderNumber: number | null | undefined
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState<Scope | null>(null)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [billTo, setBillTo] = useState<BillTo>({ name: '', email: '', address: '' })

  /**
   * Only what is certain to be refused is hidden: a cancelled order, or no venue. Everything else
   * is the server's call -- see the header.
   */
  const looksEligible =
    String(orderStatus ?? '').toLowerCase() !== 'cancelled' && Boolean(restaurantId)
  if (!looksEligible) return <span className="text-xs text-[#8A867E]">—</span>

  async function createInvoice(scope: Scope) {
    if (busy) return
    setBusy(true)
    try {
      const token = await getAccessToken()
      const response = await fetch('/api/admin/documents/from-order', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(scope === 'tab' && tabId ? { tab_id: tabId } : { order_id: orderId }),
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
            description: `Invoice ${payload.existingDocument.document_number} already covers this ${scope}.`,
          })
          return
        }
        throw new Error(payload?.error || 'Could not create the invoice')
      }

      const doc = payload.document as Created
      setCreated(doc)
      setOpen(null)
      toast({
        title: `Invoice ${doc.document_number} created`,
        description: `${STATUS_LABEL[doc.status] ?? doc.status}. It has not been sent yet.`,
      })
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

  /** The existing send route. It refuses (422) when the invoice has no Bill To email. */
  async function sendInvoice(documentId: string) {
    if (sending) return
    setSending(true)
    try {
      const token = await getAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || 'Could not send the invoice')
      setSentTo(String(payload?.emailedTo ?? ''))
      if (payload?.document?.status) {
        setCreated((c) => (c ? { ...c, status: String(payload.document.status) } : c))
      }
      toast({ title: 'Invoice sent', description: `Emailed to ${payload?.emailedTo ?? 'the customer'}.` })
    } catch (error: unknown) {
      toast({
        title: 'Could not send the invoice',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  if (created) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[#37352F]">#{created.document_number}</span>
        <span className="text-[10px] text-[#6B675F]">{STATUS_LABEL[created.status] ?? created.status}</span>
        <button
          type="button"
          onClick={() => void downloadPdf(created.id, created.document_number)}
          className="text-left text-xs text-[#2F6F62] underline underline-offset-2"
        >
          Download PDF
        </button>
        {sentTo ? (
          <span className="text-[10px] text-[#6B675F]">Sent to {sentTo}</span>
        ) : (
          <button
            type="button"
            disabled={sending}
            onClick={() => void sendInvoice(created.id)}
            className="text-left text-xs text-[#2F6F62] underline underline-offset-2 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Email to customer'}
          </button>
        )}
      </div>
    )
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen('order')}>
          Invoice order
        </Button>
        {tabId ? (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen('tab')}>
            Invoice whole tab
          </Button>
        ) : null}
      </div>
    )
  }

  const scope = open
  return (
    <div className="flex w-56 flex-col gap-1.5 rounded border border-[#E9E9E7] bg-white p-2">
      <p className="text-xs text-[#6B675F]">
        {scope === 'tab'
          ? `Invoice for the whole tab (order #${orderNumber ?? '—'} and every other order on it)`
          : `Invoice for order #${orderNumber ?? '—'}`}
      </p>
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
        <Button size="sm" className="h-7 flex-1 text-xs" disabled={busy} onClick={() => void createInvoice(scope)}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => setOpen(null)}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
