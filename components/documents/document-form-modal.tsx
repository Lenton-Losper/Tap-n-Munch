'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'

type DocumentType = 'quote' | 'invoice'

type CustomFieldRow = {
  id: string
  label: string
  value: string
}

type PartyFormState = {
  name: string
  email: string
  organization: string
  phone: string
  customFields: CustomFieldRow[]
}

type LineItemRow = {
  id: string
  description: string
  quantity: string
  unit_price: string
}

function emptyParty(): PartyFormState {
  return { name: '', email: '', organization: '', phone: '', customFields: [] }
}

function emptyLineItem(): LineItemRow {
  return {
    id: crypto.randomUUID(),
    description: '',
    quantity: '1',
    unit_price: '0',
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function partyToPayload(party: PartyFormState) {
  const customFields: Record<string, string> = {}
  for (const field of party.customFields) {
    const label = field.label.trim()
    const value = field.value.trim()
    if (label && value) {
      customFields[label] = value
    }
  }
  return {
    name: party.name.trim(),
    email: party.email.trim(),
    organization: party.organization.trim(),
    phone: party.phone.trim(),
    customFields,
  }
}

type DocumentFormModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentType: DocumentType
  onSuccess: () => void
}

export function DocumentFormModal({
  open,
  onOpenChange,
  documentType,
  onSuccess,
}: DocumentFormModalProps) {
  const { restaurant, restaurantId } = useAuth()
  const { toast } = useToast()

  const [shipTo, setShipTo] = useState<PartyFormState>(emptyParty)
  const [billTo, setBillTo] = useState<PartyFormState>(emptyParty)
  const [lineItems, setLineItems] = useState<LineItemRow[]>([emptyLineItem()])
  const [dueDate, setDueDate] = useState('')
  const [referenceNote, setReferenceNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setShipTo(emptyParty())
    setBillTo(emptyParty())
    setLineItems([emptyLineItem()])
    setDueDate('')
    setReferenceNote('')
    setErrors({})
    setSaving(false)
  }, [open, documentType])

  const taxRate = useMemo(() => {
    const raw = Number(restaurant?.tax_rate ?? 0)
    return Number.isFinite(raw) ? raw : 0
  }, [restaurant?.tax_rate])

  // Preview-only totals — the server recomputes authoritative values on submit.
  const previewTotals = useMemo(() => {
    const computedItems = lineItems.map((item) => {
      const quantity = Number(item.quantity)
      const unitPrice = Number(item.unit_price)
      const safeQty = Number.isFinite(quantity) ? quantity : 0
      const safePrice = Number.isFinite(unitPrice) ? unitPrice : 0
      return round2(safeQty * safePrice)
    })
    const subtotal = round2(computedItems.reduce((sum, value) => sum + value, 0))
    const vatAmount = round2(subtotal * taxRate)
    const total = round2(subtotal + vatAmount)
    return { subtotal, vatAmount, total }
  }, [lineItems, taxRate])

  const updatePartyField = (
    section: 'ship' | 'bill',
    field: keyof Omit<PartyFormState, 'customFields'>,
    value: string,
  ) => {
    const setter = section === 'ship' ? setShipTo : setBillTo
    setter((current) => ({ ...current, [field]: value }))
  }

  const addCustomField = (section: 'ship' | 'bill') => {
    const setter = section === 'ship' ? setShipTo : setBillTo
    setter((current) => ({
      ...current,
      customFields: [
        ...current.customFields,
        { id: crypto.randomUUID(), label: '', value: '' },
      ],
    }))
  }

  const updateCustomField = (
    section: 'ship' | 'bill',
    id: string,
    field: 'label' | 'value',
    value: string,
  ) => {
    const setter = section === 'ship' ? setShipTo : setBillTo
    setter((current) => ({
      ...current,
      customFields: current.customFields.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }))
  }

  const removeCustomField = (section: 'ship' | 'bill', id: string) => {
    const setter = section === 'ship' ? setShipTo : setBillTo
    setter((current) => ({
      ...current,
      customFields: current.customFields.filter((row) => row.id !== id),
    }))
  }

  const updateLineItem = (id: string, field: keyof Omit<LineItemRow, 'id'>, value: string) => {
    setLineItems((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    )
  }

  const addLineItem = () => {
    setLineItems((current) => [...current, emptyLineItem()])
  }

  const removeLineItem = (id: string) => {
    setLineItems((current) => {
      if (current.length <= 1) return current
      return current.filter((row) => row.id !== id)
    })
  }

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {}

    if (!shipTo.name.trim()) {
      nextErrors.ship_to_name = 'Ship To name is required'
    }
    if (!billTo.name.trim()) {
      nextErrors.bill_to_name = 'Bill To name is required'
    }

    if (lineItems.length === 0) {
      nextErrors.line_items = 'At least one line item is required'
    }

    lineItems.forEach((item, index) => {
      if (!item.description.trim()) {
        nextErrors[`line_items_${index}_description`] = 'Description is required'
      }
      const quantity = Number(item.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        nextErrors[`line_items_${index}_quantity`] = 'Quantity must be greater than 0'
      }
      const unitPrice = Number(item.unit_price)
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        nextErrors[`line_items_${index}_unit_price`] = 'Unit price must be 0 or greater'
      }
    })

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!restaurantId) return
    if (!validate()) return

    try {
      setSaving(true)
      const token = await getSettingsAccessToken()
      const body: Record<string, unknown> = {
        restaurant_id: restaurantId,
        type: documentType,
        ship_to: partyToPayload(shipTo),
        bill_to: partyToPayload(billTo),
        line_items: lineItems.map((item) => ({
          description: item.description.trim(),
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price),
        })),
      }

      if (documentType === 'invoice' && dueDate.trim()) {
        body.due_date = dueDate
      }
      if (referenceNote.trim()) {
        body.reference_note = referenceNote.trim()
      }

      const response = await fetch('/api/admin/documents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to create document')
      }

      toast({
        title: documentType === 'invoice' ? 'Invoice created' : 'Quote created',
        description: `Document #${payload?.document?.document_number ?? ''} saved.`,
      })

      if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
        for (const warning of payload.warnings) {
          toast({
            title: 'Warning',
            description: String(warning),
          })
        }
      }

      onOpenChange(false)
      onSuccess()
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to create document',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const renderPartySection = (title: string, section: 'ship' | 'bill', party: PartyFormState) => {
    const nameErrorKey = section === 'ship' ? 'ship_to_name' : 'bill_to_name'
    return (
      <div className="space-y-4 rounded-lg border p-4">
        <h3 className="text-base font-semibold text-[#37352F]">{title}</h3>
        <div className="space-y-2">
          <Label htmlFor={`${section}-name`}>Name *</Label>
          <Input
            id={`${section}-name`}
            value={party.name}
            onChange={(e) => updatePartyField(section, 'name', e.target.value)}
            disabled={saving}
          />
          {errors[nameErrorKey] ? (
            <p className="text-sm text-destructive">{errors[nameErrorKey]}</p>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${section}-email`}>Email</Label>
            <Input
              id={`${section}-email`}
              type="email"
              value={party.email}
              onChange={(e) => updatePartyField(section, 'email', e.target.value)}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${section}-organization`}>Organization</Label>
            <Input
              id={`${section}-organization`}
              value={party.organization}
              onChange={(e) => updatePartyField(section, 'organization', e.target.value)}
              disabled={saving}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${section}-phone`}>Phone</Label>
          <Input
            id={`${section}-phone`}
            value={party.phone}
            onChange={(e) => updatePartyField(section, 'phone', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label>Custom fields</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addCustomField(section)}
              disabled={saving}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add custom field
            </Button>
          </div>
          {party.customFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom fields added.</p>
          ) : (
            party.customFields.map((field) => (
              <div key={field.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-2">
                  <Label>Label</Label>
                  <Input
                    value={field.label}
                    onChange={(e) =>
                      updateCustomField(section, field.id, 'label', e.target.value)
                    }
                    disabled={saving}
                  />
                </div>
                <div className="flex-1 space-y-2">
                  <Label>Value</Label>
                  <Input
                    value={field.value}
                    onChange={(e) =>
                      updateCustomField(section, field.id, 'value', e.target.value)
                    }
                    disabled={saving}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeCustomField(section, field.id)}
                  disabled={saving}
                  aria-label="Remove custom field"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {documentType === 'invoice' ? 'New Invoice' : 'New Quote'}
          </DialogTitle>
          <DialogDescription>
            {documentType === 'invoice'
              ? 'Create an invoice with line items and billing details.'
              : 'Create a quote with line items and billing details.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {renderPartySection('Ship To', 'ship', shipTo)}
          {renderPartySection('Bill To', 'bill', billTo)}

          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-[#37352F]">Line items</h3>
              <Button type="button" variant="outline" size="sm" onClick={addLineItem} disabled={saving}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add item
              </Button>
            </div>
            {errors.line_items ? (
              <p className="text-sm text-destructive">{errors.line_items}</p>
            ) : null}
            <div className="space-y-3">
              {lineItems.map((item, index) => {
                const quantity = Number(item.quantity)
                const unitPrice = Number(item.unit_price)
                const lineTotal = round2(
                  (Number.isFinite(quantity) ? quantity : 0) *
                    (Number.isFinite(unitPrice) ? unitPrice : 0),
                )
                return (
                  <div key={item.id} className="rounded-lg border p-3 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-5 space-y-2">
                        <Label>Description</Label>
                        <Input
                          value={item.description}
                          onChange={(e) => updateLineItem(item.id, 'description', e.target.value)}
                          disabled={saving}
                        />
                        {errors[`line_items_${index}_description`] ? (
                          <p className="text-sm text-destructive">
                            {errors[`line_items_${index}_description`]}
                          </p>
                        ) : null}
                      </div>
                      <div className="sm:col-span-2 space-y-2">
                        <Label>Quantity</Label>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(item.id, 'quantity', e.target.value)}
                          disabled={saving}
                        />
                        {errors[`line_items_${index}_quantity`] ? (
                          <p className="text-sm text-destructive">
                            {errors[`line_items_${index}_quantity`]}
                          </p>
                        ) : null}
                      </div>
                      <div className="sm:col-span-2 space-y-2">
                        <Label>Unit price</Label>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={item.unit_price}
                          onChange={(e) => updateLineItem(item.id, 'unit_price', e.target.value)}
                          disabled={saving}
                        />
                        {errors[`line_items_${index}_unit_price`] ? (
                          <p className="text-sm text-destructive">
                            {errors[`line_items_${index}_unit_price`]}
                          </p>
                        ) : null}
                      </div>
                      <div className="sm:col-span-2 space-y-2">
                        <Label>Line total</Label>
                        <div className="flex h-10 items-center text-sm font-medium text-[#37352F]">
                          NAD {lineTotal.toFixed(2)}
                        </div>
                      </div>
                      <div className="sm:col-span-1 flex items-end justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => removeLineItem(item.id)}
                          disabled={saving || lineItems.length <= 1}
                          aria-label="Remove line item"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {documentType === 'invoice' ? (
            <div className="space-y-2">
              <Label htmlFor="document-due-date">Due date</Label>
              <Input
                id="document-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={saving}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="document-reference-note">Venue / Purpose</Label>
              <Input
                id="document-reference-note"
                value={referenceNote}
                onChange={(e) => setReferenceNote(e.target.value)}
                placeholder="e.g. Wedding reception, corporate lunch"
                disabled={saving}
              />
            </div>
          )}

          <div className="rounded-lg border bg-[#FAFAF8] p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[#6B675F]">Subtotal</span>
              <span className="font-medium text-[#37352F]">
                NAD {previewTotals.subtotal.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#6B675F]">VAT ({(taxRate * 100).toFixed(0)}%)</span>
              <span className="font-medium text-[#37352F]">
                NAD {previewTotals.vatAmount.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between border-t border-[#E9E9E7] pt-2">
              <span className="font-semibold text-[#37352F]">Total</span>
              <span className="font-semibold text-[#37352F]">
                NAD {previewTotals.total.toFixed(2)}
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
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
                  Saving...
                </>
              ) : (
                'Create document'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
