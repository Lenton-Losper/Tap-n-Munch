import { NextResponse } from 'next/server'
import { buildMenuUrl } from '@/lib/base-url'
import { nextKioskTableNumber } from '@/lib/tables/ordering-points'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

type CreateTableBody = {
  kind?: 'table' | 'kiosk'
  table_number?: number
  capacity?: number | null
  location?: string | null
  kiosk_name?: string
  table_name?: string
}

export async function POST(request: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.TABLES_MANAGE, request)
    if (isAuthError(auth)) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as CreateTableBody
    const kind = body.kind === 'kiosk' ? 'kiosk' : 'table'

    const location =
      typeof body.location === 'string' && body.location.trim()
        ? body.location.trim()
        : null

    const { data: existingRows, error: existingError } = await supabase
      .from('restaurant_tables')
      .select('table_number')
      .eq('restaurant_id', restaurantId)

    if (existingError) throw existingError

    const existingNumbers = (existingRows || [])
      .map((row) => Number(row.table_number))
      .filter((n) => Number.isFinite(n))

    if (kind === 'kiosk') {
      const kioskName = String(body.kiosk_name || body.table_name || '').trim()
      if (!kioskName) {
        return NextResponse.json({ error: 'Kiosk name is required' }, { status: 400 })
      }

      const tableNumber = nextKioskTableNumber(existingNumbers)
      const qrCodeUrl = buildMenuUrl(restaurantId, tableNumber, true)

      const { data, error } = await supabase
        .from('restaurant_tables')
        .insert({
          restaurant_id: restaurantId,
          table_number: tableNumber,
          table_name: kioskName,
          location,
          capacity: null,
          is_kiosk: true,
          qr_code_url: qrCodeUrl,
          active: true,
        })
        .select('*')
        .single()

      if (error) throw error
      return NextResponse.json({ table: data })
    }

    const tableNumber = Number(body.table_number)
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ error: 'Valid table number is required' }, { status: 400 })
    }

    if (existingNumbers.includes(tableNumber)) {
      return NextResponse.json(
        { error: `Table ${tableNumber} already exists` },
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
        qr_code_url: qrCodeUrl,
        active: true,
      })
      .select('*')
      .single()

    if (error) throw error
    return NextResponse.json({ table: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create ordering point'
    console.error('[admin/tables POST]', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
