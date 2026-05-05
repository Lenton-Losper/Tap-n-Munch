import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { adminDb } from '@/lib/firebase/admin-firestore'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableNumber: string }> }
) {
  const supabase = createServerSupabaseClient()
  const { restaurantId } = await req.json()
  const { tableNumber } = await params
  const parsedTableNumber = Number(tableNumber)
  const nowIso = new Date().toISOString()

  const { error: ordersError } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
      status: 'completed',
    })
    .eq('firebase_restaurant_id', restaurantId)
    .eq('table_number', parsedTableNumber)
    .eq('is_closed', false)

  if (ordersError) {
    return NextResponse.json({ error: ordersError.message }, { status: 400 })
  }

  const { error: tabsError } = await supabase
    .from('tabs')
    .update({
      status: 'closed',
      closed_at: nowIso,
      settled_at: nowIso,
      updated_at: nowIso,
    })
    .eq('table_number', parsedTableNumber)
    .eq('firebase_restaurant_id', restaurantId)
    .eq('status', 'open')

  if (tabsError) {
    console.warn('[TABLE-CLOSE] tabs update failed:', tabsError)
  }

  const { error: tableSessionError } = await supabase
    .from('restaurant_tables')
    .update({
      session_id: null,
      current_tab_id: null,
      status: 'available',
      updated_at: nowIso,
    })
    .eq('table_number', parsedTableNumber)
    .eq('firebase_restaurant_id', restaurantId)

  if (tableSessionError) {
    console.warn('[TABLE-CLOSE] restaurant_tables update failed:', tableSessionError)
  }

  try {
    const db = adminDb()
    if (db) {
      let tabsSnap = await db
        .collection(`restaurants/${restaurantId}/tabs`)
        .where('table_number', '==', parsedTableNumber)
        .where('status', '==', 'open')
        .get()

      if (tabsSnap.empty) {
        tabsSnap = await db
          .collection(`restaurants/${restaurantId}/tabs`)
          .where('table_number', '==', String(parsedTableNumber))
          .where('status', '==', 'open')
          .get()
      }

      if (!tabsSnap.empty) {
        const batch = db.batch()
        tabsSnap.docs.forEach((tabDoc) => {
          batch.update(tabDoc.ref, {
            status: 'closed',
            settled_at: nowIso,
            updated_at: nowIso,
            total: 0,
            members: [],
          })
        })
        await batch.commit()
      }
    }
  } catch (err) {
    console.warn('[TABLE-CLOSE] Firestore tab close sync failed:', err)
  }

  return NextResponse.json({ success: true })
}
