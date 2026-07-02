import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { buildMenuUrl } from '@/lib/base-url'
import { nextKioskTableNumber } from '@/lib/tables/ordering-points'

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
    const user = await getUserFromRequest(request)
    const body = (await request.json()) as CreateTableBody
    const kind = body.kind === 'kiosk' ? 'kiosk' : 'table'

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

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
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[admin/tables POST]', error)
    return NextResponse.json({ error: message }, { status })
  }
}
