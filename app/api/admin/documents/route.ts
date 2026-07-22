import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { recomputeInvoiceStatus } from '@/lib/documents/recompute-status'
import { createBusinessDocument } from '@/lib/documents/create-document'

export const dynamic = 'force-dynamic'

const DOCUMENT_TYPES = ['quote', 'invoice'] as const
type DocumentType = (typeof DOCUMENT_TYPES)[number]

type Party = Record<string, unknown>

type LineItemInput = {
  description: string
  quantity: number
  unit_price: number
  tax_rate_id: string | null
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

    let taxRateId: string | null = null
    if (row.tax_rate_id != null && row.tax_rate_id !== '') {
      const raw = String(row.tax_rate_id).trim()
      if (!isUuid(raw)) {
        return { error: `line_items[${i}].tax_rate_id must be a valid UUID` }
      }
      taxRateId = raw
    }

    lineItems.push({ description, quantity, unit_price: unitPrice, tax_rate_id: taxRateId })
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

    const { document: created, warnings } = await createBusinessDocument(supabase, {
      restaurantId,
      type: input.type,
      shipTo: input.ship_to,
      billTo: input.bill_to,
      lineItems: input.line_items,
      dueDate: input.due_date,
      referenceNote: input.reference_note,
      quoteId: input.quote_id,
      createdBy: user.id,
    })

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
      .select('id, document_type, document_number, issued_at, due_date, bill_to, total, balance, status')
      .eq('restaurant_id', restaurantId)
      .order('issued_at', { ascending: false })

    if (typeFilter) {
      query = query.eq('document_type', typeFilter)
    }

    const { data, error } = await query
    if (error) throw error

    // Lazy overdue recompute: 'overdue' has no write event to trigger off (no row changes
    // when a due_date simply passes), so candidate invoices are recomputed here on read --
    // same recomputeInvoiceStatus used after payments/send, cheap no-op when nothing changed.
    const rows = data ?? []
    for (const row of rows) {
      if (
        row.document_type === 'invoice' &&
        row.due_date &&
        (row.status === 'sent' || row.status === 'partially_paid')
      ) {
        const recomputed = await recomputeInvoiceStatus(supabase, String(row.id))
        row.status = recomputed.status
        row.balance = recomputed.balance
      }
    }

    const documents = rows.map((row) => {
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
        status: row.status,
      }
    })

    return NextResponse.json({ documents })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list documents'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
