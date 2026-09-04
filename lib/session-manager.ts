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
  // 'terminal_walkout' is a CLOSE THAT WROTE OFF A DEBT. Distinguished at the source rather than
  // inferred later: an ordinary close and a walkout are the same rows apart from this field, and
  // a report that cannot tell them apart cannot count what the venue lost.
  source: 'dashboard' | 'terminal' | 'staff_app' | 'terminal_walkout'
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
