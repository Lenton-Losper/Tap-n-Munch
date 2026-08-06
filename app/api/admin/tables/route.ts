import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMenuUrl } from '@/lib/base-url'
import { nextKioskTableNumber, nextViewOnlyTableNumber } from '@/lib/tables/ordering-points'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import {
  isTableNumberUniqueViolation,
  tableNumberConflictMessage,
} from '@/lib/tables/table-number-conflict'

export const dynamic = 'force-dynamic'

type CreateTableBody = {
  kind?: 'table' | 'kiosk' | 'view_only'
  table_number?: number
  capacity?: number | null
  location?: string | null
  kiosk_name?: string
  view_only_name?: string
  table_name?: string
}

/**
 * #174: kiosk and view-only table numbers are ASSIGNED by us from the next free slot, not
 * chosen by the merchant. So a unique-index collision there is our problem to solve, not theirs
 * to be told about — re-read the taken numbers and try the next one, rather than surfacing a
 * conflict the merchant cannot act on.
 *
 * Bounded, because an unbounded retry against a genuinely full band would spin forever.
 */
async function insertWithAssignedNumber(
  supabase: SupabaseClient,
  restaurantId: string,
  nextNumber: (taken: number[]) => number,
  buildRow: (tableNumber: number) => Record<string, unknown>,
  attempts = 3,
) {
  let last: { data: unknown; error: unknown } = { data: null, error: null }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data: rows, error: readError } = await supabase
      .from('restaurant_tables')
      .select('table_number')
      .eq('restaurant_id', restaurantId)
    if (readError) throw readError

    const taken = (rows || [])
      .map((row: { table_number: number | string | null }) => Number(row.table_number))
      .filter((n: number) => Number.isFinite(n))

    const result = await supabase
      .from('restaurant_tables')
      .insert(buildRow(nextNumber(taken)))
      .select('*')
      .single()

    last = result
    if (!isTableNumberUniqueViolation(result.error)) return result
  }

  return last
}

export async function POST(request: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.TABLES_MANAGE, request)
    if (isAuthError(auth)) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as CreateTableBody
    const kind =
      body.kind === 'kiosk' ? 'kiosk' : body.kind === 'view_only' ? 'view_only' : 'table'

    const location =
      typeof body.location === 'string' && body.location.trim()
        ? body.location.trim()
        : null

    // #175: `table_name` and `active` come back too, so a collision can NAME the conflicting
    // table and say whether it is deactivated. The old message said only "Table N already
    // exists" — a number the merchant could not see (cards never rendered it) about a row that
    // is hidden by default (inactive tables are filtered out).
    const { data: existingRows, error: existingError } = await supabase
      .from('restaurant_tables')
      .select('table_number, table_name, active')
      .eq('restaurant_id', restaurantId)

    if (existingError) throw existingError

    const existingNumbers = (existingRows || [])
      .map((row) => Number(row.table_number))
      .filter((n) => Number.isFinite(n))

    const rowForNumber = (n: number) =>
      (existingRows || []).find((row) => Number(row.table_number) === n) ?? null

    if (kind === 'kiosk') {
      const kioskName = String(body.kiosk_name || body.table_name || '').trim()
      if (!kioskName) {
        return NextResponse.json({ error: 'Kiosk name is required' }, { status: 400 })
      }

      const { data, error } = await insertWithAssignedNumber(
        supabase,
        restaurantId,
        nextKioskTableNumber,
        (tableNumber) => ({
          restaurant_id: restaurantId,
          table_number: tableNumber,
          table_name: kioskName,
          location,
          capacity: null,
          is_kiosk: true,
          is_view_only: false,
          qr_code_url: buildMenuUrl(restaurantId, tableNumber, true),
          active: true,
        }),
      )

      if (error) throw error
      return NextResponse.json({ table: data })
    }

    if (kind === 'view_only') {
      const viewOnlyName = String(body.view_only_name || body.table_name || '').trim()
      if (!viewOnlyName) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      }

      const { data, error } = await insertWithAssignedNumber(
        supabase,
        restaurantId,
        nextViewOnlyTableNumber,
        (tableNumber) => ({
          restaurant_id: restaurantId,
          table_number: tableNumber,
          table_name: viewOnlyName,
          location,
          capacity: null,
          is_kiosk: false,
          is_view_only: true,
          // Same plain /v2 link shape as a dining table -- the landing page looks up
          // is_view_only from this table_number and renders the menu-only flow itself.
          qr_code_url: buildMenuUrl(restaurantId, tableNumber),
          active: true,
        }),
      )

      if (error) throw error
      return NextResponse.json({ table: data })
    }

    const tableNumber = Number(body.table_number)
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ error: 'Valid table number is required' }, { status: 400 })
    }

    if (existingNumbers.includes(tableNumber)) {
      return NextResponse.json(
        { error: tableNumberConflictMessage(tableNumber, rowForNumber(tableNumber)) },
        { status: 409 },
      )
    }

    let capacity: number | null = null
    if (body.capacity != null && String(body.capacity).trim() !== '') {
      const parsed = Number(body.capacity)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json({ error: 'Seats must be a positive number' }, { status: 400 })
      }
      capacity = Math.round(parsed)
    }

    const qrCodeUrl = buildMenuUrl(restaurantId, tableNumber)

    const { data, error } = await supabase
      .from('restaurant_tables')
      .insert({
        restaurant_id: restaurantId,
        table_number: tableNumber,
        table_name: `Table ${tableNumber}`,
        location,
        capacity,
        is_kiosk: false,
        is_view_only: false,
        qr_code_url: qrCodeUrl,
        active: true,
      })
      .select('*')
      .single()

    // #174: the pre-check above is a read-then-write with no lock, so two concurrent adds of
    // the same number both pass it. The unique index added in 20260806000000 is what actually
    // arbitrates. Catch its violation and return the SAME 409 the pre-check would have — an
    // uncaught constraint turns a clear conflict into an opaque 500.
    if (isTableNumberUniqueViolation(error)) {
      const { data: conflict } = await supabase
        .from('restaurant_tables')
        .select('table_number, table_name, active')
        .eq('restaurant_id', restaurantId)
        .eq('table_number', tableNumber)
        .maybeSingle()

      return NextResponse.json(
        { error: tableNumberConflictMessage(tableNumber, conflict) },
        { status: 409 },
      )
    }

    if (error) throw error
    return NextResponse.json({ table: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create ordering point'
    console.error('[admin/tables POST]', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
