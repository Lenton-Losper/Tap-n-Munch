import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const DOCUMENT_TYPES = ['quote', 'invoice'] as const
type DocumentType = (typeof DOCUMENT_TYPES)[number]

type Party = Record<string, unknown>

type LineItemInput = {
  description: string
  quantity: number
  unit_price: number
}

type LineItemComputed = LineItemInput & {
  line_total: number
}

type CreateDocumentBody = {
  restaurant_id: string
  type: DocumentType
  ship_to: Party
  bill_to: Party
  line_items: LineItemInput[]
  due_date?: string | null
  reference_note?: string | null
  quote_id?: string | null
}

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function trimParty(party: unknown): Party | null {
  if (!party || typeof party !== 'object' || Array.isArray(party)) return null
  const out: Party = {}
  for (const [key, value] of Object.entries(party as Record<string, unknown>)) {
    out[key] = typeof value === 'string' ? value.trim() : value
  }
  return out
}

function partyName(party: Party | null): string {
  return String(party?.name ?? '').trim()
}

function parseCreateDocumentBody(body: unknown): { data: CreateDocumentBody } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid request body' }
  }

  const record = body as Record<string, unknown>
  const restaurantId = String(record.restaurant_id ?? '').trim()
  if (!restaurantId) {
    return { error: 'restaurant_id is required' }
  }

  const type = String(record.type ?? '').trim() as DocumentType
  if (!DOCUMENT_TYPES.includes(type)) {
    return { error: "type must be 'quote' or 'invoice'" }
  }

  const shipTo = trimParty(record.ship_to)
  const billTo = trimParty(record.bill_to)
  if (!shipTo) {
    return { error: 'ship_to is required' }
  }
  if (!billTo) {
    return { error: 'bill_to is required' }
  }
  if (!partyName(shipTo)) {
    return { error: 'ship_to.name must be a non-empty string' }
  }
  if (!partyName(billTo)) {
    return { error: 'bill_to.name must be a non-empty string' }
  }

  if (!Array.isArray(record.line_items) || record.line_items.length === 0) {
    return { error: 'line_items must be a non-empty array' }
  }

  const lineItems: LineItemInput[] = []
  for (let i = 0; i < record.line_items.length; i++) {
    const item = record.line_items[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `line_items[${i}] must be an object` }
    }
    const row = item as Record<string, unknown>
    const description = String(row.description ?? '').trim()
    if (!description) {
      return { error: `line_items[${i}].description must be a non-empty string` }
    }

    const quantity = Number(row.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { error: `line_items[${i}].quantity must be a finite number greater than 0` }
    }

    const unitPrice = Number(row.unit_price)
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { error: `line_items[${i}].unit_price must be a finite number greater than or equal to 0` }
    }

    lineItems.push({ description, quantity, unit_price: unitPrice })
  }

  let dueDate: string | null = null
  if (record.due_date != null && record.due_date !== '') {
    if (type !== 'invoice') {
      return { error: 'due_date is only valid for type invoice' }
    }
    const parsed = String(record.due_date).trim()
    if (Number.isNaN(Date.parse(parsed))) {
      return { error: 'due_date must be a valid date' }
    }
    dueDate = parsed
  }

  let referenceNote: string | null = null
  if (record.reference_note != null) {
    if (typeof record.reference_note !== 'string') {
      return { error: 'reference_note must be a string' }
    }
    const trimmed = record.reference_note.trim()
    referenceNote = trimmed || null
  }

  let quoteId: string | null = null
  if (record.quote_id != null && record.quote_id !== '') {
    const raw = String(record.quote_id).trim()
    if (!isUuid(raw)) {
      return { error: 'quote_id must be a valid UUID' }
    }
    quoteId = raw
  }

  return {
    data: {
      restaurant_id: restaurantId,
      type,
      ship_to: shipTo,
      bill_to: billTo,
      line_items: lineItems,
      due_date: dueDate,
      reference_note: referenceNote,
      quote_id: quoteId,
    },
  }
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

export async function POST(request: Request) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const body = await request.json()
    const parsed = parseCreateDocumentBody(body)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const input = parsed.data

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(
      supabase,
      user.id,
      input.restaurant_id,
    )
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name, phone, address, logo_url, tax_rate')
      .eq('id', restaurantId)
      .maybeSingle()
    if (restaurantError) throw restaurantError
    if (!restaurant) {
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    }

    const { data: billingProfile, error: billingError } = await supabase
      .from('restaurant_billing_profiles')
      .select(
        'registration_number, vat_number, bank_name, bank_account_name, bank_account_number, bank_branch_code',
      )
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    if (billingError) throw billingError

    const { lineItems, subtotal } = computeLineItems(input.line_items)
    const safeTaxRate = resolveDocumentTaxRate(restaurant.tax_rate, restaurantId)
    const vatAmount = round2(subtotal * safeTaxRate)
    const total = round2(subtotal + vatAmount)
    const balance = total

    const { data: nextNumber, error: sequenceError } = await supabase.rpc(
      'get_next_document_number',
      {
        p_restaurant_id: restaurantId,
        p_document_type: input.type,
      },
    )
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
      document_type: input.type,
      document_number: String(nextNumber),
      quote_id: input.quote_id,
      due_date: input.due_date,
      reference_note: input.reference_note,
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
      ship_to: input.ship_to,
      bill_to: input.bill_to,
      line_items: lineItems,
      subtotal,
      vat_amount: vatAmount,
      total,
      balance,
      created_by: user.id,
    }

    const { data: created, error: insertError } = await supabase
      .from('business_documents')
      .insert(insertRow)
      .select('*')
      .single()
    if (insertError) throw insertError

    return NextResponse.json(
      {
        document: created,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { status: 201 },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create document'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET(request: Request) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const url = new URL(request.url)
    const restaurantIdParam = String(url.searchParams.get('restaurant_id') ?? '').trim()
    if (!restaurantIdParam) {
      return NextResponse.json({ error: 'restaurant_id query parameter is required' }, { status: 400 })
    }

    const typeFilter = String(url.searchParams.get('type') ?? '').trim()
    if (typeFilter && !DOCUMENT_TYPES.includes(typeFilter as DocumentType)) {
      return NextResponse.json({ error: "type must be 'quote' or 'invoice'" }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(
      supabase,
      user.id,
      restaurantIdParam,
    )
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    let query = supabase
      .from('business_documents')
      .select('id, document_type, document_number, issued_at, due_date, bill_to, total, balance')
      .eq('restaurant_id', restaurantId)
      .order('issued_at', { ascending: false })

    if (typeFilter) {
      query = query.eq('document_type', typeFilter)
    }

    const { data, error } = await query
    if (error) throw error

    const documents = (data ?? []).map((row) => {
      const billTo =
        row.bill_to && typeof row.bill_to === 'object' && !Array.isArray(row.bill_to)
          ? (row.bill_to as Record<string, unknown>)
          : null
      return {
        id: row.id,
        type: row.document_type,
        document_number: row.document_number,
        issued_at: row.issued_at,
        due_date: row.due_date,
        bill_to: billTo ? String(billTo.name ?? '').trim() || null : null,
        total: row.total,
        balance: row.balance,
      }
    })

    return NextResponse.json({ documents })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list documents'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
