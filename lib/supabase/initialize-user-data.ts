import { createServerSupabaseClient } from './server'
import { createSupabaseCategory, createSupabaseSubcategory } from './menu'

export async function initializeUserData(
  userId: string,
  email: string,
  restaurantName?: string
): Promise<{ userId: string; restaurantId: string }> {
  const supabase = createServerSupabaseClient()
  const { data: existingUser } = await supabase.from('users').select('*').eq('id', userId).maybeSingle()
  if (existingUser?.restaurant_id) {
    return { userId, restaurantId: String(existingUser.restaurant_id) }
  }

  const now = new Date().toISOString()
  const defaultRestaurantName = restaurantName || email.split('@')[0].replace(/[^a-z0-9]/gi, ' ')
  const slug = defaultRestaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .insert({
      owner_id: userId,
      owner_uid: userId,
      name: defaultRestaurantName,
      slug,
      description: '',
      email,
      phone: '',
      address: '',
      logo_url: null,
      primary_color: '#FF6B35',
      currency: 'NAD',
      timezone: 'Africa/Windhoek',
      online_ordering_enabled: false,
      payment_methods: ['cash', 'card'],
      tax_rate: 0.15,
      service_fee: 0,
      subscription_tier: 'starter',
      subscription_status: 'trial',
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single()
  if (restaurantError || !restaurant?.id) throw restaurantError || new Error('Failed to create restaurant')

  const restaurantId = String(restaurant.id)
  const userPayload = {
    id: userId,
    email,
    name: `${defaultRestaurantName} Owner`,
    phone: '',
    role: 'owner',
    restaurant_id: restaurantId,
    created_at: now,
    last_login: now,
  }
  if (existingUser) {
    await supabase.from('users').update(userPayload).eq('id', userId)
  } else {
    await supabase.from('users').insert(userPayload)
  }

  try {
    const drinks = await createSupabaseCategory({ restaurant_id: restaurantId, name: 'Drinks', description: 'All beverages' })
    const food = await createSupabaseCategory({ restaurant_id: restaurantId, name: 'Food', description: 'All food items' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((drinks as any).id), name: 'Alcoholic drinks', description: 'Beers, wines, cocktails' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((drinks as any).id), name: 'Soft drinks', description: 'Sodas, juices, water' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((drinks as any).id), name: 'Hot drinks', description: 'Coffee, tea, hot chocolate' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((food as any).id), name: 'Starters', description: 'Appetizers and small plates' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((food as any).id), name: 'Mains', description: 'Main courses' })
    await createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: String((food as any).id), name: 'Desserts', description: 'Sweet treats' })
  } catch {}

  return { userId, restaurantId }
}
