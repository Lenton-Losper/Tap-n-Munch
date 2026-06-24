import type { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  ALL_SETUP_FLAGS,
  computeCompletionPercentage,
  type SetupFlag,
} from './setup-status'

const FLAG_TIMESTAMP_COLUMNS: Partial<Record<SetupFlag, string>> = {
  profile_complete: 'profile_completed_at',
  tables_configured: 'tables_configured_at',
  menu_added: 'menu_added_at',
  qr_downloaded: 'qr_downloaded_at',
  staff_added: 'staff_added_at',
  terminal_connected: 'terminal_connected_at',
  test_order_completed: 'test_order_completed_at',
  first_payment_completed: 'first_payment_completed_at',
}

const DEFAULT_SETUP_ROW = {
  profile_complete: false,
  tables_configured: false,
  menu_added: false,
  qr_downloaded: false,
  staff_added: false,
  terminal_connected: false,
  test_order_completed: false,
  first_payment_completed: false,
  dismissed: false,
}

export async function ensureSetupStatusRow(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string
) {
  const { data: existing, error: readError } = await supabase
    .from('restaurant_setup_status')
    .select('restaurant_id')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (readError) throw readError
  if (existing?.restaurant_id) return

  const { error: insertError } = await supabase.from('restaurant_setup_status').insert({
    restaurant_id: restaurantId,
    ...DEFAULT_SETUP_ROW,
  })

  if (insertError) throw insertError
}

export async function markSetupStepComplete(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
  flag: SetupFlag | 'dismissed'
) {
  await ensureSetupStatusRow(supabase, restaurantId)

  const now = new Date().toISOString()

  if (flag === 'dismissed') {
    const { error } = await supabase
      .from('restaurant_setup_status')
      .update({ dismissed: true, updated_at: now })
      .eq('restaurant_id', restaurantId)

    if (error) throw error
    return
  }

  const { data: current } = await supabase
    .from('restaurant_setup_status')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  const merged: Record<string, boolean | undefined> = {}
  for (const key of ALL_SETUP_FLAGS) {
    merged[key] = key === flag ? true : Boolean(current?.[key])
  }

  const updates: Record<string, unknown> = {
    [flag]: true,
    updated_at: now,
    completion_percentage: computeCompletionPercentage(merged),
  }

  const timestampColumn = FLAG_TIMESTAMP_COLUMNS[flag]
  if (timestampColumn) {
    updates[timestampColumn] = now
  }

  const { error } = await supabase
    .from('restaurant_setup_status')
    .update(updates)
    .eq('restaurant_id', restaurantId)

  if (error) {
    const { error: fallbackError } = await supabase
      .from('restaurant_setup_status')
      .update({ [flag]: true, updated_at: now })
      .eq('restaurant_id', restaurantId)
    if (fallbackError) throw fallbackError
  }
}
