import { db } from './config'
import { doc, getDoc, setDoc, collection, writeBatch } from 'firebase/firestore'
import type { User, Restaurant } from './types'
import { createMenuCategory } from './menu-categories'
import { createSubCategory } from './sub-categories'

/**
 * Initialize user data when Firebase Auth user exists but Firestore data is missing.
 * This recreates:
 * - users document
 * - restaurants document
 * - default menu categories
 * - default sub-categories
 */
export async function initializeUserData(
  userId: string,
  email: string,
  restaurantName?: string
): Promise<{ userId: string; restaurantId: string }> {
  if (!db) {
    throw new Error('Firestore is not initialized')
  }

  try {
    console.log('🔍 Checking if user data exists...', { userId, email })

    // Check if user document already exists
    const userDoc = await getDoc(doc(db, 'users', userId))
    if (userDoc.exists()) {
      const existingUserData = userDoc.data() as User
      console.log('✅ User data already exists', {
        userId,
        restaurantId: existingUserData.restaurant_id,
      })
      
      // If user exists but restaurant_id is missing, try to find or create restaurant
      if (!existingUserData.restaurant_id) {
        console.log('⚠️ User exists but restaurant_id is missing. Creating restaurant...')
        const restaurantId = await createRestaurantForUser(userId, email, restaurantName)
        // Update user with restaurant_id
        await setDoc(
          doc(db, 'users', userId),
          { restaurant_id: restaurantId },
          { merge: true }
        )
        return { userId, restaurantId }
      }
      
      return { userId, restaurantId: existingUserData.restaurant_id }
    }

    console.log('📝 User data missing. Initializing...', { userId, email })

    const now = new Date().toISOString()
    const defaultRestaurantName = restaurantName || email.split('@')[0].replace(/[^a-z0-9]/gi, ' ')

    // Generate slug from restaurant name
    const slug = defaultRestaurantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

    // Create restaurant document
    const restaurantRef = doc(collection(db, 'restaurants'))
    const restaurantId = restaurantRef.id

    const restaurantData: Omit<Restaurant, 'id'> = {
      owner_id: userId,
      owner_uid: userId, // PART 1: Set owner_uid for Storage rules
      name: defaultRestaurantName,
      slug: slug,
      description: '',
      email: email,
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
    }

    // Create user document
    const userData: Omit<User, 'id'> = {
      email: email,
      name: `${defaultRestaurantName} Owner`,
      phone: '',
      role: 'owner',
      restaurant_id: restaurantId,
      created_at: now,
      last_login: now,
    }

    // Use batch write for atomicity (restaurant and user)
    const batch = writeBatch(db)

    // Add restaurant
    batch.set(restaurantRef, restaurantData)

    // Add user
    batch.set(doc(db, 'users', userId), { id: userId, ...userData })

    // Commit restaurant and user first
    console.log('💾 Committing batch write for restaurant and user...')
    await batch.commit()
    console.log('✅ Batch write successful! Restaurant and user documents created.')

    // Create default menu structure (3-level hierarchy)
    // This is done after batch commit to avoid transaction size limits
    try {
      console.log('📋 Creating default menu structure...')
      
      // Create menu categories
      const drinksId = await createMenuCategory(restaurantId, 'Drinks', 'All beverages')
      const foodId = await createMenuCategory(restaurantId, 'Food', 'All food items')

      // Create sub-categories for Drinks
      await createSubCategory(restaurantId, drinksId, 'Alcoholic drinks', 'Beers, wines, cocktails')
      await createSubCategory(restaurantId, drinksId, 'Soft drinks', 'Sodas, juices, water')
      await createSubCategory(restaurantId, drinksId, 'Hot drinks', 'Coffee, tea, hot chocolate')

      // Create sub-categories for Food
      await createSubCategory(restaurantId, foodId, 'Starters', 'Appetizers and small plates')
      await createSubCategory(restaurantId, foodId, 'Mains', 'Main courses')
      await createSubCategory(restaurantId, foodId, 'Desserts', 'Sweet treats')

      console.log('✅ Default menu structure created successfully')
    } catch (menuError: any) {
      // Log error but don't fail initialization - menu structure can be created later
      console.error('⚠️ Failed to create default menu structure:', menuError)
      console.log('Restaurant created successfully. Menu structure can be created manually.')
    }

    console.log('✅ User data initialized successfully!', { userId, restaurantId })
    return { userId, restaurantId }
  } catch (error: any) {
    console.error('❌ Error initializing user data:', {
      error,
      code: error?.code,
      message: error?.message,
      userId,
      email,
    })
    throw new Error(
      `Failed to initialize user data: ${error.message || 'Unknown error'}`
    )
  }
}

/**
 * Helper function to create a restaurant for an existing user
 */
async function createRestaurantForUser(
  userId: string,
  email: string,
  restaurantName?: string
): Promise<string> {
  if (!db) {
    throw new Error('Firestore is not initialized')
  }

  const now = new Date().toISOString()
  const defaultRestaurantName = restaurantName || email.split('@')[0].replace(/[^a-z0-9]/gi, ' ')

  // Generate slug from restaurant name
  const slug = defaultRestaurantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  // Create restaurant document
  const restaurantRef = doc(collection(db, 'restaurants'))
  const restaurantId = restaurantRef.id

  const restaurantData: Omit<Restaurant, 'id'> = {
    owner_id: userId,
    owner_uid: userId, // PART 1: Set owner_uid for Storage rules
    name: defaultRestaurantName,
    slug: slug,
    description: '',
    email: email,
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
  }

  await setDoc(restaurantRef, restaurantData)
  console.log('✅ Restaurant created for existing user', { userId, restaurantId })

  // Create default menu structure
  try {
    const drinksId = await createMenuCategory(restaurantId, 'Drinks', 'All beverages')
    const foodId = await createMenuCategory(restaurantId, 'Food', 'All food items')

    await createSubCategory(restaurantId, drinksId, 'Alcoholic drinks', 'Beers, wines, cocktails')
    await createSubCategory(restaurantId, drinksId, 'Soft drinks', 'Sodas, juices, water')
    await createSubCategory(restaurantId, drinksId, 'Hot drinks', 'Coffee, tea, hot chocolate')

    await createSubCategory(restaurantId, foodId, 'Starters', 'Appetizers and small plates')
    await createSubCategory(restaurantId, foodId, 'Mains', 'Main courses')
    await createSubCategory(restaurantId, foodId, 'Desserts', 'Sweet treats')
  } catch (menuError: any) {
    console.error('⚠️ Failed to create default menu structure:', menuError)
  }

  return restaurantId
}














