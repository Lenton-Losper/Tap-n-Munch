import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const MAX_FIELD_LENGTH = 100
const BANK_ACCOUNT_NUMBER_PATTERN = /^[\d\s-]+$/

const BILLING_PROFILE_FIELDS = [
  'registration_number',
  'vat_number',
  'bank_name',
  'bank_account_name',
  'bank_account_number',
  'bank_branch_code',
] as const

type BillingProfileField = (typeof BILLING_PROFILE_FIELDS)[number]

const LENGTH_LIMITED_FIELDS: BillingProfileField[] = [
  'registration_number',
  'vat_number',
  'bank_account_number',
  'bank_branch_code',
]

type BillingProfilePayload = Record<BillingProfileField, string | null>

function emptyBillingProfile(): BillingProfilePayload {
  return {
    registration_number: null,
    vat_number: null,
    bank_name: null,
    bank_account_name: null,
    bank_account_number: null,
    bank_branch_code: null,
  }
}

function toBillingProfilePayload(
  row: Partial<Record<BillingProfileField, string | null>> | null | undefined,
): BillingProfilePayload {
  const base = emptyBillingProfile()
  if (!row) return base
  for (const key of BILLING_PROFILE_FIELDS) {
    const value = row[key]
    base[key] = value == null ? null : String(value)
  }
  return base
}

function parseBillingProfileBody(body: unknown): BillingProfilePayload | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const payload = emptyBillingProfile()
  for (const key of BILLING_PROFILE_FIELDS) {
    if (!(key in record)) continue
    const raw = record[key]
    if (raw == null) {
      payload[key] = null
      continue
    }
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    payload[key] = trimmed || null
  }
  return payload
}

function validateBillingProfilePayload(payload: BillingProfilePayload): string | null {
  for (const key of LENGTH_LIMITED_FIELDS) {
    const value = payload[key]
    if (value && value.length > MAX_FIELD_LENGTH) {
      return `${key} must not exceed ${MAX_FIELD_LENGTH} characters`
    }
  }
  if (
    payload.bank_account_number &&
    !BANK_ACCOUNT_NUMBER_PATTERN.test(payload.bank_account_number)
  ) {
    return 'bank_account_number may only contain digits, spaces, and hyphens'
  }
  return null
}

function unauthorizedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unauthorized'
  return NextResponse.json({ error: message }, { status: 401 })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_READ)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_billing_profiles')
      .select(BILLING_PROFILE_FIELDS.join(', '))
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    if (error) throw error

    return NextResponse.json({
      billingProfile: toBillingProfilePayload(
        data as Partial<Record<BillingProfileField, string | null>> | null,
      ),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load billing profile'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    return unauthorizedResponse(error)
  }

  try {
    const { id } = await params
    const body = await request.json()
    const billingProfile = parseBillingProfileBody(body)
    if (!billingProfile) {
      return NextResponse.json({ error: 'Invalid billing profile payload' }, { status: 400 })
    }

    const validationError = validateBillingProfilePayload(billingProfile)
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_billing_profiles')
      .upsert(
        {
          restaurant_id: restaurantId,
          ...billingProfile,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'restaurant_id' },
      )
      .select(BILLING_PROFILE_FIELDS.join(', '))
      .single()
    if (error) throw error

    return NextResponse.json({
      success: true,
      billingProfile: toBillingProfilePayload(
        data as Partial<Record<BillingProfileField, string | null>>,
      ),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update billing profile'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
