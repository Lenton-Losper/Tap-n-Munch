import { SupabaseClient } from '@supabase/supabase-js'

export async function closeTableSession({
  supabase,
  restaurantId,
  tableId,
  closedBy,
  source,
}: {
  supabase: SupabaseClient
  restaurantId: string
  tableId: string
  closedBy: string
  source: 'dashboard' | 'terminal' | 'staff_app'
}) {
  const { data, error } = await supabase.rpc('close_table_session', {
    p_table_id: tableId,
    p_restaurant_id: restaurantId,
  })

  if (error) {
    throw new Error(`Failed to close table session: ${error.message}`)
  }

  // data.success can be true even if tabs_settled is 0
  // that is valid — table may already be clean
  // do not throw on tabs_settled === 0

  await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    action: 'table.closed',
    entity_type: 'restaurant_tables',
    entity_id: tableId,
    metadata: {
      closed_by: closedBy,
      source,
    },
  })

  return data
}
