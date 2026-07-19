import { createServerSupabaseClient } from './server'
import { createSupabaseCategory, createSupabaseSubcategory } from './menu'
import { createRestaurantForUserAtomic } from '@/lib/auth/create-restaurant'
import { getRestaurantIdsForUser } from './admin-restaurant-auth'

/**
 * Legacy signup fallback (reachable via POST /api/auth/sync-profile with a restaurantName
 * body field -- not exercised by the current UI, but still live/callable). Used to insert
 * restaurants/users directly, including users.restaurant_id, and never inserted a
 * restaurant_users row at all -- meaning any account actually provisioned through this path
 * would silently fail getRestaurantIdForUser (restaurant_users-only) and every permission
 * check, despite looking "signed up." Now delegates to the same atomic
 * create_restaurant_for_user RPC the real signup flow uses, so this path produces a
 * consistent, working account instead of a broken one.
 */
export async function initializeUserData(
  userId: string,
  email: string,
  restaurantName?: string
): Promise<{ userId: string; restaurantId: string }> {
  const supabase = createServerSupabaseClient()

  const existingRestaurantIds = await getRestaurantIdsForUser(supabase, userId)
  if (existingRestaurantIds.length > 0) {
    return { userId, restaurantId: existingRestaurantIds[0] }
  }

  const defaultRestaurantName = restaurantName || email.split('@')[0].replace(/[^a-z0-9]/gi, ' ')
  const fullName = `${defaultRestaurantName} Owner`

  const restaurantId = await createRestaurantForUserAtomic(supabase, {
    userId,
    email,
    fullName,
    phone: '',
    restaurantName: defaultRestaurantName,
  })

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
