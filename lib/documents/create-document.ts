import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'
import type { TaxRateOption } from '@/lib/tax-rates/format'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'

export type DocumentType = 'quote' | 'invoice'
export type Party = Record<string, unknown>

export type LineItemInput = {
  description: string
  quantity: number
  unit_price: number
  /** Nullable -- falls back to the restaurant's default tax_rates row, then 0%, same
   * hierarchy as calculateOrderPricing() (lib/orders/calculate-order-pricing.ts). */
  tax_rate_id?: string | null
}

type LineItemComputed = LineItemInput & {
  tax_rate_id: string | null
  tax_rate_percentage: number
  tax_inclusive: boolean
  line_total: number
  line_subtotal: number
  line_tax: number
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

/**
 * Per-line VAT, same hierarchy and math as calculateOrderPricing(): each line's own
 * tax_rate_id, else the restaurant's tax_rates.is_default row, else 0%. restaurants.tax_rate
 * (the old flat pre-Phase-C field) plays no part here, matching orders exactly -- document
 * totals are the sum of correctly-taxed lines, not one rate applied to the whole subtotal.
 * line_total keeps its original meaning (quantity * unit_price, unchanged) for backward
 * compatibility with documents created before this change, which have line_total but no
 * tax_rate_id/line_subtotal/line_tax at all -- those fields are simply absent on old rows,
 * not defaulted to anything, since business_documents rows (and their line_items) are
 * immutable once created and are never recomputed after the fact.
 */
function computeLineItems(
  items: LineItemInput[],
  ratesById: Map<string, TaxRateOption>,
  fallbackDefault: TaxRateOption | null,
): {
  lineItems: LineItemComputed[]
  subtotal: number
  vatAmount: number
  total: number
} {
  const lineItems = items.map((item) => {
    const rate = resolveTaxRate(item.tax_rate_id, ratesById, fallbackDefault)
    const applied = applyTaxToAmount(item.quantity * item.unit_price, rate)
    return {
      ...item,
      tax_rate_id: rate?.id ?? null,
      tax_rate_percentage: applied.taxRatePercentage,
      tax_inclusive: applied.taxInclusive,
      line_total: round2(item.quantity * item.unit_price),
      line_subtotal: applied.subtotal,
      line_tax: applied.tax,
    }
  })

  const subtotal = round2(lineItems.reduce((sum, item) => sum + item.line_subtotal, 0))
  const vatAmount = round2(lineItems.reduce((sum, item) => sum + item.line_tax, 0))
  const total = round2(subtotal + vatAmount)

  return { lineItems, subtotal, vatAmount, total }
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
    .select('name, phone, address, logo_url')
    .eq('id', restaurantId)
    .maybeSingle()
  if (restaurantError) throw restaurantError
  if (!restaurant) {
    throw new Error('Restaurant not found')
  }

  const [{ data: billingProfile, error: billingError }, taxRates] = await Promise.all([
    supabase
      .from('restaurant_billing_profiles')
      .select(
        'registration_number, vat_number, bank_name, bank_account_name, bank_account_number, bank_branch_code',
      )
      .eq('restaurant_id', restaurantId)
      .maybeSingle(),
    getTaxRatesForRestaurant(supabase, restaurantId),
  ])
  if (billingError) throw billingError

  const ratesById = new Map(taxRates.map((rate) => [rate.id, rate]))
  const fallbackDefault = defaultTaxRate(taxRates)

  const {
    lineItems: computedLineItems,
    subtotal,
    vatAmount,
    total,
  } = computeLineItems(lineItems, ratesById, fallbackDefault)
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
