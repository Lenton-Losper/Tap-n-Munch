import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
  UserCredential,
  fetchSignInMethodsForEmail,
} from 'firebase/auth'
import { auth, db, isFirebaseConfigValid } from './config'
import { doc, setDoc, getDoc, serverTimestamp, collection, addDoc, writeBatch } from 'firebase/firestore'
import type { User as UserType, Restaurant } from './types'
import { createMenuCategory } from './menu-categories'
import { createSubCategory } from './sub-categories'

// Check if Firebase is configured
function checkFirebaseConfig() {
  if (!isFirebaseConfigValid()) {
    throw new Error(
      'Firebase is not configured. Please set up your Firebase credentials in .env.local. ' +
      'See FIREBASE_SETUP.md for instructions.'
    )
  }
  if (!auth) {
    throw new Error('Firebase Auth is not initialized. Please check your configuration.')
  }
  if (!db) {
    throw new Error('Firestore is not initialized. Please check your configuration.')
  }
}

// Sign up a new restaurant - Complete implementation
export async function signUpRestaurant(
  email: string,
  password: string,
  restaurantName: string,
  phone?: string
): Promise<{ userId: string; restaurantId: string }> {
  checkFirebaseConfig()
  
  try {
    // 1. Create Firebase Auth user
    const userCredential = await createUserWithEmailAndPassword(
      auth!,
      email,
      password
    )
    
    const userId = userCredential.user.uid
    const now = new Date().toISOString()
    
    // Ensure auth token is ready before Firestore operations
    console.log('🔐 Getting auth token for Firestore operations...')
    const token = await userCredential.user.getIdToken()
    if (!token) {
      throw new Error('Failed to get authentication token. Please try again.')
    }
    console.log('✅ Auth token ready')
    
    // Generate slug from restaurant name
    const slug = restaurantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    
    // 2. Create restaurant document (use auto-generated ID)
    const restaurantRef = doc(collection(db!, 'restaurants'))
    const restaurantId = restaurantRef.id
    
    const restaurantData: Omit<Restaurant, 'id'> = {
      owner_id: userId,
      owner_uid: userId, // PART 1: Set owner_uid for Storage rules
      name: restaurantName,
      slug: slug,
      description: '',
      email: email,
      phone: phone || '',
      address: '',
      logo_url: null,
      primary_color: '#FF6B35',
      currency: 'NAD',
      timezone: 'Africa/Windhoek',
      online_ordering_enabled: false,
      payment_methods: ['cash'],
      tax_rate: 0.15,
      service_fee: 0,
      subscription_tier: 'starter',
      subscription_status: 'trial',
      created_at: now,
      updated_at: now,
    }
    
    // 3. Create user document
    const userData: Omit<UserType, 'id'> = {
      email: email,
      name: `${restaurantName} Owner`,
      phone: phone || '',
      role: 'owner',
      restaurant_id: restaurantId,
      created_at: now,
      last_login: now,
    }
    
    // Use batch write for atomicity (restaurant and user)
    const batch = writeBatch(db!)
    
    // Add restaurant
    batch.set(restaurantRef, restaurantData)
    
    // Add user
    batch.set(doc(db!, 'users', userId), { id: userId, ...userData })
    
    // Commit restaurant and user first
    console.log('📝 Committing batch write for restaurant and user...', {
      userId,
      restaurantId,
      restaurantName,
    })
    
    try {
      await batch.commit()
      console.log('✅ Batch write successful! Restaurant and user documents created.')
    } catch (batchError: any) {
      console.error('❌ Batch write failed:', {
        error: batchError,
        code: batchError?.code,
        message: batchError?.message,
        userId,
        restaurantId,
      })
      throw new Error(`Failed to create user/restaurant documents: ${batchError.message || 'Unknown error'}`)
    }
    
    // Create default menu structure (3-level hierarchy)
    // This is done after batch commit to avoid transaction size limits
    try {
      // First, create the menu/data document (required for hierarchical structure)
      const { menuDocumentPath } = await import('./paths')
      const menuDocRef = doc(db!, menuDocumentPath(restaurantId))
      await setDoc(menuDocRef, {
        created_at: serverTimestamp(),
        version: 1,
      })
      
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
      // Log error but don't fail signup - menu structure can be created later
      console.error('⚠️ Failed to create default menu structure:', menuError)
      console.log('Restaurant created successfully. Menu structure can be created manually.')
    }
    
    return { userId, restaurantId }
  } catch (error: any) {
    console.error('Signup error:', error)
    throw new Error(error.message || 'Failed to create account')
  }
}

// Legacy signUp function for backward compatibility
export async function signUp(
  email: string,
  password: string,
  restaurantName: string,
  phone?: string,
  address?: string
): Promise<UserCredential> {
  const { userId } = await signUpRestaurant(email, password, restaurantName, phone)
  const user = auth!.currentUser
  if (!user) {
    throw new Error('User creation failed')
  }
  return { user } as UserCredential
}

// Sign in existing restaurant
export async function signIn(
  email: string,
  password: string
): Promise<UserCredential> {
  checkFirebaseConfig()
  
  try {
    return await signInWithEmailAndPassword(auth!, email, password)
  } catch (error: any) {
    // Provide user-friendly error messages
    const errorCode = error.code
    
    if (errorCode === 'auth/invalid-credential' || errorCode === 'auth/wrong-password' || errorCode === 'auth/user-not-found') {
      // Check if email exists to provide more specific error message
      try {
        const signInMethods = await fetchSignInMethodsForEmail(auth!, email)
        if (signInMethods.length === 0) {
          // Email doesn't exist
          throw new Error('There is no account with this email address. Please check your email or create a new account.')
        } else {
          // Email exists but password is wrong
          throw new Error('Incorrect password. Please try again or reset your password.')
        }
      } catch (checkError: any) {
        // If fetchSignInMethodsForEmail fails, use the original error message
        // But improve it if it's the generic invalid-credential error
        if (checkError.message && !checkError.message.includes('There is no account') && !checkError.message.includes('Incorrect password')) {
          // Check if it's the email check error or the original sign-in error
          if (errorCode === 'auth/invalid-credential' || errorCode === 'auth/user-not-found') {
            throw new Error('There is no account with this email address. Please check your email or create a new account.')
          }
          throw checkError
        }
        throw checkError
      }
    } else if (errorCode === 'auth/invalid-email') {
      throw new Error('Please enter a valid email address.')
    } else if (errorCode === 'auth/user-disabled') {
      throw new Error('This account has been disabled. Please contact support.')
    } else if (errorCode === 'auth/too-many-requests') {
      throw new Error('Too many failed login attempts. Please try again later or reset your password.')
    } else {
      // For other errors, use a generic but helpful message
      throw new Error(error.message || 'Failed to sign in. Please check your credentials and try again.')
    }
  }
}

// Sign out
export async function signOutUser(): Promise<void> {
  if (!auth) {
    return
  }
  
  try {
    await signOut(auth)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to sign out')
  }
}

// Get current user
export function getCurrentUser(): User | null {
  if (!auth) {
    return null
  }
  return auth.currentUser
}

// Listen to auth state changes
export function onAuthChange(callback: (user: User | null) => void) {
  if (!auth) {
    // If auth is not initialized, call callback with null and return a no-op unsubscribe
    callback(null)
    return () => {}
  }
  return onAuthStateChanged(auth, callback)
}

// Get restaurant data
export async function getRestaurantData(restaurantId: string) {
  checkFirebaseConfig()
  
  try {
    const docRef = doc(db!, 'restaurants', restaurantId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() }
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch restaurant data')
  }
}

