import type { createServerSupabaseClient } from '@/lib/supabase/server'

export type DocumentType = 'quote' | 'invoice'
export type Party = Record<string, unknown>

export type LineItemInput = {
  description: string
  quantity: number
  unit_price: number
}

type LineItemComputed = LineItemInput & {
  line_total: number
}

export type CreateBusinessDocumentInput = {
  restaurantId: string
  type: DocumentType
  shipTo: Party
  billTo: Party
  lineItems: LineItemInput[]
  dueDate?: string | null
  referenceNote?: string | null
  quoteId?: string | null
  createdBy: string
}

export type CreateBusinessDocumentResult = {
  document: Record<string, unknown>
  warnings: string[]
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function computeLineItems(items: LineItemInput[]): {
  lineItems: LineItemComputed[]
  subtotal: number
} {
  const lineItems = items.map((item) => ({
    ...item,
    line_total: round2(item.quantity * item.unit_price),
  }))
  const subtotal = round2(lineItems.reduce((sum, item) => sum + item.line_total, 0))
  return { lineItems, subtotal }
}

function resolveDocumentTaxRate(rawRate: unknown, restaurantId: string): number {
  const taxRate = Number(rawRate ?? 0)
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    console.error('[documents] invalid tax_rate; falling back to 0', {
      restaurant_id: restaurantId,
      tax_rate: rawRate,
    })
    return 0
  }
  return taxRate
}

/**
 * Single creation path for business_documents -- used by the plain create route
 * (app/api/admin/documents POST) and by quote->invoice conversion
 * (app/api/admin/documents/:id/convert), so both get a real sequence number and the
 * same billing-profile snapshot, not two diverging implementations of the same insert.
 */
export async function createBusinessDocument(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  input: CreateBusinessDocumentInput,
): Promise<CreateBusinessDocumentResult> {
  const { restaurantId, type, shipTo, billTo, lineItems, dueDate, referenceNote, quoteId, createdBy } =
    input

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('name, phone, address, logo_url, tax_rate')
    .eq('id', restaurantId)
    .maybeSingle()
  if (restaurantError) throw restaurantError
  if (!restaurant) {
    throw new Error('Restaurant not found')
  }

  const { data: billingProfile, error: billingError } = await supabase
    .from('restaurant_billing_profiles')
    .select(
      'registration_number, vat_number, bank_name, bank_account_name, bank_account_number, bank_branch_code',
    )
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (billingError) throw billingError

  const { lineItems: computedLineItems, subtotal } = computeLineItems(lineItems)
  const safeTaxRate = resolveDocumentTaxRate(restaurant.tax_rate, restaurantId)
  const vatAmount = round2(subtotal * safeTaxRate)
  const total = round2(subtotal + vatAmount)
  const balance = total

  const { data: nextNumber, error: sequenceError } = await supabase.rpc('get_next_document_number', {
    p_restaurant_id: restaurantId,
    p_document_type: type,
  })
  if (sequenceError) throw sequenceError
  if (typeof nextNumber !== 'number') {
    throw new Error('Failed to reserve document number')
  }

  const warnings: string[] = []
  if (!billingProfile) {
    warnings.push(
      'No billing profile is configured for this restaurant. Add billing details in Settings before sending documents.',
    )
  }

  const insertRow = {
    restaurant_id: restaurantId,
    document_type: type,
    document_number: String(nextNumber),
    quote_id: quoteId ?? null,
    due_date: dueDate ?? null,
    reference_note: referenceNote ?? null,
    business_name: restaurant.name ?? null,
    registration_number: billingProfile?.registration_number ?? null,
    vat_number: billingProfile?.vat_number ?? null,
    address: restaurant.address ?? null,
    phone: restaurant.phone ?? null,
    logo_url: restaurant.logo_url ?? null,
    bank_name: billingProfile?.bank_name ?? null,
    bank_account_name: billingProfile?.bank_account_name ?? null,
    bank_account_number: billingProfile?.bank_account_number ?? null,
    bank_branch_code: billingProfile?.bank_branch_code ?? null,
    ship_to: shipTo,
    bill_to: billTo,
    line_items: computedLineItems,
    subtotal,
    vat_amount: vatAmount,
    total,
    balance,
    created_by: createdBy,
  }

  const { data: created, error: insertError } = await supabase
    .from('business_documents')
    .insert(insertRow)
    .select('*')
    .single()
  if (insertError) throw insertError

  return { document: created, warnings }
}
