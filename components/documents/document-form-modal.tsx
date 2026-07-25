'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'
import { getMenuItems } from '@/lib/supabase/menu'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useToast } from '@/hooks/use-toast'
import { getTaxRatesForDocumentFormAction } from '@/lib/tax-rates/actions'
import { defaultTaxRate } from '@/lib/tax-rates/queries'
import { formatTaxRateLabel, type TaxRateOption } from '@/lib/tax-rates/format'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'

/** Short trigger-only label -- formatTaxRateLabel's full "Name (X%, incl./excl.)" form is used
 * in the dropdown option list where there's room, but overflowed the trigger's grid column
 * (SelectTrigger is w-fit + whitespace-nowrap by design, so it grows to fit whatever content
 * it's given rather than truncating on its own -- the fix is a shorter string, not just CSS). */
function shortTaxLabel(rate: TaxRateOption | null): string {
  if (!rate) return 'No tax (0%)'
  return `${rate.name} (${rate.percentage}%)`
}

type MenuItemOption = {
  id: string
  name: string
  base_price: number
  tax_rate_id: string | null
}

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
  tax_rate_id: string
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
    tax_rate_id: '',
  }
}

/** Editable document row shape, from GET /api/admin/documents/[id] -- only the
 * fields the form actually edits, not the full business_documents row. */
export type EditingDocument = {
  id: string
  document_number: string
  ship_to: Record<string, unknown> | null
  bill_to: Record<string, unknown> | null
  line_items: Array<Record<string, unknown>> | null
  due_date: string | null
  reference_note: string | null
}

/** Reverse of partyToPayload -- stored ship_to/bill_to has customFields as a
 * {label: value} object, the form works with an editable CustomFieldRow[] list. */
function partyFromStored(raw: Record<string, unknown> | null | undefined): PartyFormState {
  if (!raw) return emptyParty()
  const rawCustomFields =
    raw.customFields && typeof raw.customFields === 'object' && !Array.isArray(raw.customFields)
      ? (raw.customFields as Record<string, unknown>)
      : {}
  return {
    name: String(raw.name ?? ''),
    email: String(raw.email ?? ''),
    organization: String(raw.organization ?? ''),
    phone: String(raw.phone ?? ''),
    customFields: Object.entries(rawCustomFields).map(([label, value]) => ({
      id: crypto.randomUUID(),
      label,
      value: String(value ?? ''),
    })),
  }
}

function lineItemsFromStored(raw: Array<Record<string, unknown>> | null | undefined): LineItemRow[] {
  if (!Array.isArray(raw) || raw.length === 0) return [emptyLineItem()]
  return raw.map((item) => ({
    id: crypto.randomUUID(),
    description: String(item.description ?? ''),
    quantity: String(Number(item.quantity) || 0),
    unit_price: String(Number(item.unit_price) || 0),
    tax_rate_id: item.tax_rate_id != null ? String(item.tax_rate_id) : '',
  }))
}

/** business_documents.due_date is a timestamptz; <Input type="date"> needs YYYY-MM-DD. */
function dueDateFromStored(raw: string | null | undefined): string {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
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

function MenuItemPicker({
  menuItems,
  onSelect,
  disabled,
}: {
  menuItems: MenuItemOption[]
  onSelect: (item: MenuItemOption) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filteredMenuItems = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return menuItems
    return menuItems.filter((menuItem) => menuItem.name.toLowerCase().includes(query))
  }, [menuItems, search])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={disabled || menuItems.length === 0}
          aria-label="Pick from menu"
          title="Pick from menu"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* shouldFilter=false: filtering the list ourselves via `search` state rather than
            cmdk's built-in matcher, which doesn't reliably filter under cmdk 1.0.4 + React 19
            in this project (confirmed empirically -- typing a plain substring match returned
            zero results even though the item list itself rendered correctly). */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search menu items..." value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No menu items found.</CommandEmpty>
            <CommandGroup>
              {filteredMenuItems.map((menuItem) => (
                <CommandItem
                  key={menuItem.id}
                  value={menuItem.id}
                  onSelect={() => {
                    onSelect(menuItem)
                    setOpen(false)
                    setSearch('')
                  }}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate">{menuItem.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      NAD {menuItem.base_price.toFixed(2)}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

type DocumentFormModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentType: DocumentType
  onSuccess: () => void
  /** When set, the modal edits this existing draft invoice (PATCH) instead of
   * creating a new document (POST). Caller is responsible for only passing this
   * for document_type='invoice' && status='draft' rows -- the backend enforces
   * the same rule independently either way. */
  editingDocument?: EditingDocument | null
}

export function DocumentFormModal({
  open,
  onOpenChange,
  documentType,
  onSuccess,
  editingDocument = null,
}: DocumentFormModalProps) {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const isEditing = editingDocument != null

  // Initializers run once per mount -- documents-list-content.tsx remounts this
  // component via a `key` bump on every open, so this is the only prefill needed,
  // no separate reset-on-open effect.
  const [shipTo, setShipTo] = useState<PartyFormState>(() => partyFromStored(editingDocument?.ship_to))
  const [billTo, setBillTo] = useState<PartyFormState>(() => partyFromStored(editingDocument?.bill_to))
  const [lineItems, setLineItems] = useState<LineItemRow[]>(() =>
    lineItemsFromStored(editingDocument?.line_items),
  )
  const [dueDate, setDueDate] = useState(() => dueDateFromStored(editingDocument?.due_date))
  const [referenceNote, setReferenceNote] = useState(editingDocument?.reference_note ?? '')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [taxRates, setTaxRates] = useState<TaxRateOption[]>([])
  const [menuItems, setMenuItems] = useState<MenuItemOption[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await getTaxRatesForDocumentFormAction()
      if (cancelled) return
      if ('data' in result) setTaxRates(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!restaurantId) return
    let cancelled = false
    ;(async () => {
      try {
        const items = await getMenuItems(restaurantId)
        if (cancelled) return
        setMenuItems(
          (items as Array<Record<string, unknown>>).map((item) => ({
            id: String(item.id),
            name: String(item.name ?? ''),
            base_price: Number(item.base_price) || 0,
            tax_rate_id: item.tax_rate_id ? String(item.tax_rate_id) : null,
          })),
        )
      } catch {
        // Non-critical: the picker just has no options if this fails -- manual entry still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [restaurantId])

  const ratesById = useMemo(() => new Map(taxRates.map((rate) => [rate.id, rate])), [taxRates])
  const fallbackRate = useMemo(() => defaultTaxRate(taxRates), [taxRates])

  const lineItemTax = useCallback(
    (item: LineItemRow) => {
      const quantity = Number(item.quantity)
      const unitPrice = Number(item.unit_price)
      const safeQty = Number.isFinite(quantity) ? quantity : 0
      const safePrice = Number.isFinite(unitPrice) ? unitPrice : 0
      const rate = resolveTaxRate(item.tax_rate_id || null, ratesById, fallbackRate)
      return applyTaxToAmount(safeQty * safePrice, rate)
    },
    [ratesById, fallbackRate],
  )

  // Preview-only totals — the server recomputes authoritative values on submit.
  const previewTotals = useMemo(() => {
    const computed = lineItems.map((item) => lineItemTax(item))
    const subtotal = round2(computed.reduce((sum, applied) => sum + applied.subtotal, 0))
    const vatAmount = round2(computed.reduce((sum, applied) => sum + applied.tax, 0))
    const total = round2(subtotal + vatAmount)
    return { subtotal, vatAmount, total }
  }, [lineItems, lineItemTax])

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

  /** Prefills description/unit_price/tax_rate_id from a menu_items row -- a one-time convenience
   * copy, not a stored link, so later menu price changes never retroactively affect this
   * already-created document (consistent with documents being immutable snapshots). The user
   * can still edit any of these fields afterward, same as a fully manual line. */
  const applyMenuItemToLine = (id: string, menuItem: MenuItemOption) => {
    setLineItems((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              description: menuItem.name,
              unit_price: String(menuItem.base_price),
              tax_rate_id: menuItem.tax_rate_id ?? '',
            }
          : row,
      ),
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

      const lineItemsPayload = lineItems.map((item) => ({
        description: item.description.trim(),
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        tax_rate_id: item.tax_rate_id || null,
      }))

      const url = isEditing ? `/api/admin/documents/${editingDocument!.id}` : '/api/admin/documents'
      const method = isEditing ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = isEditing
        ? {
            ship_to: partyToPayload(shipTo),
            bill_to: partyToPayload(billTo),
            line_items: lineItemsPayload,
            due_date: dueDate.trim() || null,
            reference_note: referenceNote.trim() || null,
          }
        : {
            restaurant_id: restaurantId,
            type: documentType,
            ship_to: partyToPayload(shipTo),
            bill_to: partyToPayload(billTo),
            line_items: lineItemsPayload,
            ...(documentType === 'invoice' && dueDate.trim() ? { due_date: dueDate } : {}),
            ...(referenceNote.trim() ? { reference_note: referenceNote.trim() } : {}),
          }

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || (isEditing ? 'Failed to save changes' : 'Failed to create document'))
      }

      const savedNumber = isEditing
        ? editingDocument!.document_number
        : (payload?.document?.document_number ?? '')
      toast({
        title: isEditing ? 'Invoice updated' : documentType === 'invoice' ? 'Invoice created' : 'Quote created',
        description: `Document #${savedNumber} saved.`,
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
        description: error instanceof Error ? error.message : 'Failed to save document',
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
      <DialogContent className="max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-2xl md:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? `Edit Invoice #${editingDocument!.document_number}`
              : documentType === 'invoice'
                ? 'New Invoice'
                : 'New Quote'}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update line items and billing details for this draft invoice.'
              : documentType === 'invoice'
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
                const applied = lineItemTax(item)
                return (
                  <div key={item.id} className="rounded-lg border p-3 space-y-3">
                    <div className="grid gap-3 md:grid-cols-12">
                      <div className="min-w-0 space-y-2 md:col-span-3">
                        <div className="flex items-center justify-between gap-1">
                          <Label>Description</Label>
                          <MenuItemPicker
                            menuItems={menuItems}
                            disabled={saving}
                            onSelect={(menuItem) => applyMenuItemToLine(item.id, menuItem)}
                          />
                        </div>
                        <Input
                          value={item.description}
                          onChange={(e) => updateLineItem(item.id, 'description', e.target.value)}
                          placeholder="Pick a menu item or type a custom description"
                          disabled={saving}
                        />
                        {errors[`line_items_${index}_description`] ? (
                          <p className="text-sm text-destructive">
                            {errors[`line_items_${index}_description`]}
                          </p>
                        ) : null}
                      </div>
                      <div className="min-w-0 space-y-2 md:col-span-2">
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
                      <div className="min-w-0 space-y-2 md:col-span-2">
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
                      <div className="min-w-0 space-y-2 md:col-span-3">
                        <Label>Tax</Label>
                        <Select
                          value={item.tax_rate_id || '__default__'}
                          onValueChange={(value) =>
                            updateLineItem(item.id, 'tax_rate_id', value === '__default__' ? '' : value)
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Use restaurant default">
                              <span className="min-w-0 truncate">
                                {item.tax_rate_id
                                  ? shortTaxLabel(ratesById.get(item.tax_rate_id) ?? null)
                                  : fallbackRate
                                    ? `Default: ${shortTaxLabel(fallbackRate)}`
                                    : 'Default (no tax)'}
                              </span>
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__default__">
                              {fallbackRate
                                ? `Restaurant default (${formatTaxRateLabel(fallbackRate)})`
                                : 'Restaurant default (none, 0%)'}
                            </SelectItem>
                            {taxRates.map((rate) => (
                              <SelectItem key={rate.id} value={rate.id}>
                                {formatTaxRateLabel(rate)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="min-w-0 space-y-2 md:col-span-1">
                        <Label>Total</Label>
                        <div className="flex h-10 items-center text-sm font-medium text-[#37352F]">
                          {applied.total.toFixed(2)}
                        </div>
                      </div>
                      <div className="flex items-end justify-end md:col-span-1">
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
              <span className="text-[#6B675F]">VAT</span>
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
              ) : isEditing ? (
                'Save changes'
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
