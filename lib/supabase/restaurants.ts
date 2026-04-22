import { createServerSupabaseClient } from './server'

export async function createSupabaseRestaurant(data: {
  owner_id: string
  name: string
  phone: string
  currency?: string
}) {
  const supabase = createServerSupabaseClient()
  const { data: restaurant, error } = await supabase
    .from('restaurants')
    .insert({
      owner_id: data.owner_id,
      name: data.name,
      phone: data.phone,
      currency: data.currency || 'NAD',
      payment_methods: ['cash'],
      subscription_status: 'trial',
      subscription_tier: 'starter',
    })
    .select()
    .single()
  if (error) throw error
  return restaurant
}

export async function getSupabaseRestaurant(restaurantId: string) {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single()
  if (error) throw error
  return data
}

export async function updateSupabaseRestaurant(
  restaurantId: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('restaurants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', restaurantId)
  if (error) throw error
}
