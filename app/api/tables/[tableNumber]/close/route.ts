import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableNumber: string }> }
) {
  const supabase = createServerSupabaseClient()
  const { restaurantId } = await req.json()
  const { tableNumber } = await params

  const { error } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
      status: 'completed'
    })
    .eq('firebase_restaurant_id', restaurantId)
    .eq('table_number', Number(tableNumber))
    .eq('is_closed', false)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
