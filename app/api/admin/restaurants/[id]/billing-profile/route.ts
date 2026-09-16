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

/**
 * THE SIX TEXT COLUMNS THAT EXIST EVERYWHERE. `vat_registered` is deliberately NOT here.
 *
 * ================================================================================================
 * #WHY THIS LIST WAS SPLIT -- THE DEFECT IT CLOSES
 * ================================================================================================
 *
 * This route used to select `[...BILLING_PROFILE_FIELDS, 'vat_registered']` in one string, for
 * both GET and PATCH. `vat_registered` arrives with migration 20260901120000, whose own header
 * says it is `@env: staging` and that applying it to production is a separate, deliberate step
 * that has NOT been taken.
 *
 * So on production the column does not exist, and PostgREST rejects the WHOLE select:
 *
 *     GET /rest/v1/restaurant_billing_profiles?select=...,vat_registered
 *       -> 400  42703  column restaurant_billing_profiles.vat_registered does not exist
 *
 * Verified read-only against production 2026-09-13; the same select without the column returns
 * 200. The route threw, answered 500, and Settings -> Billing showed "Could not load billing
 * profile" at every venue. PATCH was broken the same way, twice over -- it selected the column
 * back AND upserted it -- which is why `restaurant_billing_profiles` has ZERO rows in production:
 * nobody has ever been able to save one.
 *
 * lib/receipts/issueReceipt.ts already carries this rule and states it plainly: a tolerant read
 * for this column must NOT be folded into a select alongside columns that do exist, because one
 * absent column takes the whole row down with it. This route is the site that did not follow it.
 */
const BILLING_PROFILE_FIELDS = [
  'registration_number',
  'vat_number',
  'bank_name',
  'bank_account_name',
  'bank_account_number',
  'bank_branch_code',
] as const

type BillingProfileField = (typeof BILLING_PROFILE_FIELDS)[number]

/** Postgres `undefined_column`, as lib/supabase/schema-probe.ts names it. */
const COLUMN_ABSENT_CODE = '42703'

type VatRegistrationRead = {
  /** Whether the database can hold an answer at all -- i.e. whether the migration has been applied. */
  supported: boolean
  /** The answer, or null for "not answered". Never invented from absence. */
  value: boolean | null
}

/**
 * Read `vat_registered` ON ITS OWN, tolerating a database that cannot yet hold it.
 *
 * THREE STATES, AND THE THIRD IS NOT COLLAPSED. A column that is absent is not the same as an
 * answer of "not registered", and neither is the same as a read that failed. Only 42703 means
 * "this database has no such column"; any other error is a real failure and is rethrown, because
 * reporting a broken database as "not answered" is how an instrument starts lying -- the exact
 * failure lib/supabase/schema-probe.ts exists to prevent.
 */
async function readVatRegistered(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
): Promise<VatRegistrationRead> {
  const { data, error } = await supabase
    .from('restaurant_billing_profiles')
    .select('vat_registered')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) {
    if ((error as { code?: string | null }).code === COLUMN_ABSENT_CODE) {
      return { supported: false, value: null }
    }
    throw error
  }

  const raw = (data as { vat_registered?: unknown } | null)?.vat_registered
  return { supported: true, value: typeof raw === 'boolean' ? raw : null }
}

const LENGTH_LIMITED_FIELDS: BillingProfileField[] = [
  'registration_number',
  'vat_number',
  'bank_account_number',
  'bank_branch_code',
]

/**
 * `vat_registered` is a BOOLEAN and is deliberately not in BILLING_PROFILE_FIELDS, which is a
 * list of trimmed text fields. Three states, all real: null = not answered (every venue today),
 * true = registered, false = explicitly not registered. Never inferred from vat_number being
 * blank -- that ambiguity is the whole reason the column exists.
 */
type BillingProfilePayload = Record<BillingProfileField, string | null> & {
  vat_registered: boolean | null
}

function emptyBillingProfile(): BillingProfilePayload {
  return {
    registration_number: null,
    vat_number: null,
    bank_name: null,
    bank_account_name: null,
    bank_account_number: null,
    bank_branch_code: null,
    vat_registered: null,
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
  const registered = (row as { vat_registered?: unknown }).vat_registered
  // Only an explicit boolean answers. Anything else stays null -- "not answered".
  base.vat_registered = typeof registered === 'boolean' ? registered : null
  return base
}

/**
 * What the caller ACTUALLY SENT -- nothing more.
 *
 * ================================================================================================
 * #WHY THIS IS A PARTIAL AND NOT A WHOLE PROFILE -- THE TWO DEFECTS IT CLOSES
 * ================================================================================================
 *
 * This function used to start from `emptyBillingProfile()` and fill in the keys the request
 * carried. Every key the request did NOT carry therefore came back as an explicit `null`, and the
 * caller could not tell "the merchant cleared this field" from "the request never mentioned it".
 * Two separate defects fell out of that single conflation:
 *
 *   D1  Settings -> Billing sends the six text fields and no `vat_registered`. The absent key
 *       became `vat_registered: null`, which was then UPSERT into the row -- so saving a bank
 *       branch code silently wiped the venue's VAT-registration answer. A merchant who had
 *       answered "we are VAT registered" was un-answered by an unrelated save, and told
 *       "Billing saved".
 *
 *   D2  PATCH {"vat_registered": true} on its own became
 *       {vat_registered: true, vat_number: null, ...}, so `validateBillingProfilePayload` refused
 *       it with "vat_number is required when the business is VAT registered" -- against a stored
 *       profile that HAD a VAT number all along. Validation was reading the request instead of the
 *       resulting profile.
 *
 * Both are the same mistake, and both are fixed in the same place: a PATCH is a patch. This parser
 * reports only what was sent; `mergeBillingProfile` below lays it over what is stored; and it is
 * the MERGED profile -- the row as it will exist after the write -- that is validated and written.
 *
 * `emptyBillingProfile()` remains, but only for its one honest use: the shape of a profile that
 * does not exist yet. It is never the basis of an update.
 */
function parseBillingProfilePatch(body: unknown): Partial<BillingProfilePayload> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const patch: Partial<BillingProfilePayload> = {}
  for (const key of BILLING_PROFILE_FIELDS) {
    if (!(key in record)) continue
    const raw = record[key]
    if (raw == null) {
      // An EXPLICIT null is an instruction to clear, and is kept as one. Only absence is silence.
      patch[key] = null
      continue
    }
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    patch[key] = trimmed || null
  }
  if ('vat_registered' in record) {
    const raw = record.vat_registered
    if (raw !== null && typeof raw !== 'boolean') return null
    patch.vat_registered = raw as boolean | null
  }
  return patch
}

/**
 * The profile as it WILL BE once this patch is applied -- the thing validation and the upsert are
 * both entitled to see. Keys absent from the patch keep their stored value; keys present in it,
 * including an explicit null, take the patch's value.
 */
function mergeBillingProfile(
  stored: BillingProfilePayload,
  patch: Partial<BillingProfilePayload>,
): BillingProfilePayload {
  const merged: BillingProfilePayload = { ...stored }
  for (const key of BILLING_PROFILE_FIELDS) {
    if (key in patch) merged[key] = patch[key] ?? null
  }
  if ('vat_registered' in patch) merged.vat_registered = patch.vat_registered ?? null
  return merged
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
  /**
   * The same rule the database CHECK enforces, refused here with a readable message rather than
   * as a raw constraint violation. Claiming registration without a number would put a VAT-charging
   * receipt in front of a customer with nothing to identify the registration.
   */
  if (payload.vat_registered === true && !payload.vat_number) {
    return 'vat_number is required when the business is VAT registered'
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

    const vatRegistration = await readVatRegistered(supabase, restaurantId)

    const billingProfile = toBillingProfilePayload(
      data as Partial<Record<BillingProfileField, string | null>> | null,
    )
    billingProfile.vat_registered = vatRegistration.value

    return NextResponse.json({
      billingProfile,
      /**
       * Stated so the client can hide a control the database cannot back, rather than offering a
       * toggle whose save is guaranteed to be refused.
       */
      vatRegistrationSupported: vatRegistration.supported,
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
    const patch = parseBillingProfilePatch(body)
    if (!patch) {
      return NextResponse.json({ error: 'Invalid billing profile payload' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.DOCUMENTS_WRITE)
    if (denied) return denied

    /**
     * THE STORED ROW IS READ BEFORE ANYTHING IS VALIDATED, because a PATCH only means anything
     * relative to it.
     *
     * AUTHORIZATION RESOLVES THE RESTAURANT, so this read necessarily comes after the two checks
     * above and is scoped to the id they returned -- never to the one the client put in the URL.
     * Validation therefore moved below them too, and that reordering is deliberate: a caller who
     * is not entitled to this venue is now refused BEFORE their payload is judged, so a 400 can
     * no longer be used to learn anything about a venue the caller cannot read.
     *
     * Six columns only. `vat_registered` is read separately by readVatRegistered() below, for the
     * reason the note on BILLING_PROFILE_FIELDS gives: one absent column takes the whole select
     * down with it.
     */
    const { data: storedRow, error: storedError } = await supabase
      .from('restaurant_billing_profiles')
      .select(BILLING_PROFILE_FIELDS.join(', '))
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    if (storedError) throw storedError

    /**
     * ASKED BEFORE ANYTHING IS WRITTEN, so the refusal below is atomic: either the whole save
     * happens or none of it does. Probing after a partial write would leave the six text fields
     * saved and the VAT answer silently discarded, which is the outcome this check exists to
     * prevent.
     */
    const vatRegistration = await readVatRegistered(supabase, restaurantId)

    const stored = toBillingProfilePayload(
      storedRow as Partial<Record<BillingProfileField, string | null>> | null,
    )
    // The stored answer comes from its own tolerant read, never from the six-column select above.
    stored.vat_registered = vatRegistration.value

    /**
     * THE ROW AS IT WILL EXIST ONCE THIS WRITE LANDS. The validation and the upsert below both
     * read this and not the request, which is what makes a field the request never mentioned mean
     * "leave it alone" instead of "set it to null". See the note on parseBillingProfilePatch for
     * the two defects that one distinction closes.
     */
    const billingProfile = mergeBillingProfile(stored, patch)

    /**
     * FAILS CLOSED ON A COMPLIANCE FIELD. An explicit true/false that this database cannot store
     * is REFUSED, never dropped: a merchant who answers "we are VAT registered", sees "Billing
     * saved", and then gets invoices that say nothing about registration has been told something
     * untrue by this endpoint. An absent or explicitly-null answer is a no-op and still saves.
     *
     * Asked of THE PATCH, not of the merge. Where the column is absent the stored answer is always
     * null, so the two tests agree today -- but only the patch can distinguish "the caller sent an
     * answer this database cannot hold" from "an answer was already there", and the day the second
     * becomes possible the merge would start refusing saves that touch nothing to do with VAT.
     */
    if (patch.vat_registered != null && !vatRegistration.supported) {
      return NextResponse.json(
        {
          error:
            'VAT registration cannot be recorded yet. This venue\'s database has not had ' +
            'migration 20260901120000 applied, so there is nowhere to store the answer. ' +
            'Nothing was saved. Remove the VAT registration answer to save the other details.',
          code: 'VAT_REGISTRATION_UNAVAILABLE',
        },
        { status: 409 },
      )
    }

    const validationError = validateBillingProfilePayload(billingProfile)
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const writeRow: Record<string, unknown> = {
      restaurant_id: restaurantId,
      updated_at: new Date().toISOString(),
    }
    for (const key of BILLING_PROFILE_FIELDS) writeRow[key] = billingProfile[key]
    // Only written where the column exists. Guarded above, so this can never silently drop an answer.
    if (vatRegistration.supported) writeRow.vat_registered = billingProfile.vat_registered

    const selectColumns = vatRegistration.supported
      ? [...BILLING_PROFILE_FIELDS, 'vat_registered'].join(', ')
      : BILLING_PROFILE_FIELDS.join(', ')

    const { data, error } = await supabase
      .from('restaurant_billing_profiles')
      .upsert(writeRow, { onConflict: 'restaurant_id' })
      .select(selectColumns)
      .single()
    if (error) throw error

    const saved = toBillingProfilePayload(
      data as Partial<Record<BillingProfileField, string | null>>,
    )
    if (!vatRegistration.supported) saved.vat_registered = null

    return NextResponse.json({
      success: true,
      billingProfile: saved,
      vatRegistrationSupported: vatRegistration.supported,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update billing profile'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
