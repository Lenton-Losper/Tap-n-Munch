'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'
import { User } from 'firebase/auth'
import { onAuthChange, getCurrentUser } from '@/lib/firebase/auth'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { isFirebaseConfigValid } from '@/lib/firebase/config'
import type { User as UserType, Restaurant } from '@/lib/firebase/types'
import { initializeUserData } from '@/lib/firebase/initialize-user-data'

interface AuthContextType {
  user: User | null
  userData: UserType | null
  restaurant: Restaurant | null
  restaurantId: string | null
  loading: boolean
  isFirebaseConfigured: boolean
  signUp: (email: string, password: string, restaurantName: string, phone?: string) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userData: null,
  restaurant: null,
  restaurantId: null,
  loading: true,
  isFirebaseConfigured: false,
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userData, setUserData] = useState<UserType | null>(null)
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [restaurantId, setRestaurantId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isFirebaseConfigured, setIsFirebaseConfigured] = useState(false)

  // Load user data and restaurant when user changes
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null
    let isMounted = true

    const loadUserData = async (authUser: User | null) => {
      console.log("🛠️ DEBUG: AuthProvider - loadUserData called", {
        hasAuthUser: !!authUser,
        authUserUid: authUser?.uid,
        hasDb: !!db,
      })
      
      if (!authUser || !db) {
        console.log("🛠️ DEBUG: AuthProvider - loadUserData: Missing authUser or db, clearing data")
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setLoading(false)
        return
      }

      // Set timeout for loading (5 seconds)
      timeoutId = setTimeout(() => {
        if (isMounted) {
          console.warn('⚠️ Auth data loading timeout after 5 seconds')
          setLoading(false)
        }
      }, 5000)

      try {
        // Wait for auth token to be ready
        const token = await authUser.getIdToken()
        if (!token) {
          console.warn('Auth token not available yet')
          setUserData(null)
          setRestaurant(null)
          setRestaurantId(null)
          if (timeoutId) clearTimeout(timeoutId)
          if (isMounted) setLoading(false)
          return
        }

        // Load user document
        let userDoc = await getDoc(doc(db, 'users', authUser.uid))
        
        if (!userDoc.exists()) {
          // User document missing - Auth user exists but Firestore data was deleted
          console.warn('⚠️ Firebase Auth user exists but Firestore user document is missing.')
          console.log('🔄 Attempting to auto-initialize user data...')
          
          try {
            // Auto-initialize user data
            const { restaurantId } = await initializeUserData(
              authUser.uid,
              authUser.email || '',
              undefined // Restaurant name will be generated from email
            )
            
            console.log('✅ User data initialized successfully!', { userId: authUser.uid, restaurantId })
            
            // Reload user document after initialization
            userDoc = await getDoc(doc(db, 'users', authUser.uid))
            
            if (!userDoc.exists()) {
              throw new Error('User document still missing after initialization')
            }
          } catch (initError: any) {
            console.error('❌ Failed to auto-initialize user data:', initError)
            // Set userData to null to trigger the "Account Data Missing" dialog
            setUserData(null)
            setRestaurant(null)
            setRestaurantId(null)
            if (timeoutId) clearTimeout(timeoutId)
            if (isMounted) setLoading(false)
            return
          }
        }
        
        // User document exists (either originally or after initialization)
        const userData = { id: userDoc.id, ...userDoc.data() } as UserType
        setUserData(userData)

        // Load restaurant if restaurant_id exists
        if (userData.restaurant_id) {
          const restaurantData = await getRestaurant(userData.restaurant_id)
          if (restaurantData) {
            setRestaurant(restaurantData)
            setRestaurantId(restaurantData.id)
            // Save restaurantId to localStorage for faster loading on next visit
            if (typeof window !== 'undefined') {
              localStorage.setItem('restaurantId', restaurantData.id)
            }
          } else {
            // Restaurant document missing - data was deleted
            console.warn('⚠️ User has restaurant_id but restaurant document not found. Firestore data may have been deleted.')
            console.log('🔄 Attempting to recreate restaurant...')
            
            try {
              // Try to recreate restaurant using initializeUserData helper
              const { restaurantId: newRestaurantId } = await initializeUserData(
                authUser.uid,
                authUser.email || '',
                undefined
              )
              
              // Reload user data to get updated restaurant_id
              const updatedUserDoc = await getDoc(doc(db, 'users', authUser.uid))
              if (updatedUserDoc.exists()) {
                const updatedUserData = { id: updatedUserDoc.id, ...updatedUserDoc.data() } as UserType
                setUserData(updatedUserData)
                
                const newRestaurantData = await getRestaurant(newRestaurantId)
                if (newRestaurantData) {
                  setRestaurant(newRestaurantData)
                  setRestaurantId(newRestaurantData.id)
                  // Save restaurantId to localStorage for faster loading on next visit
                  if (typeof window !== 'undefined') {
                    localStorage.setItem('restaurantId', newRestaurantData.id)
                  }
                  console.log('✅ Restaurant recreated successfully!')
                }
              }
            } catch (recreateError: any) {
              console.error('❌ Failed to recreate restaurant:', recreateError)
              setRestaurant(null)
              setRestaurantId(null)
            }
          }
        } else {
          setRestaurant(null)
          setRestaurantId(null)
        }
      } catch (error: any) {
        console.error("🛠️ DEBUG: AuthProvider - Error in loadUserData:", {
          error: error.message,
          code: error.code,
          stack: error.stack,
          userId: authUser.uid,
        })
        
        // Check if it's a permissions error
        if (error?.code === 'permission-denied' || error?.message?.includes('permission')) {
          console.error('❌ Permission denied when loading user data. This usually means:', {
            error: error.message,
            userId: authUser.uid,
            possibleCauses: [
              'User document does not exist in Firestore',
              'Firestore security rules are blocking access',
              'Auth token is not properly set',
            ],
          })
        } else {
          console.error('❌ Error loading user data:', error)
        }
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
      } finally {
        // Clear timeout if data loaded successfully
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    if (user) {
      console.log("🛠️ DEBUG: AuthProvider - User exists, loading user data. UID:", user.uid)
      loadUserData(user)
    } else {
      console.log("🛠️ DEBUG: AuthProvider - User is null, clearing data and setting loading to false")
      setUserData(null)
      setRestaurant(null)
      setRestaurantId(null)
      setLoading(false)
    }

    return () => {
      isMounted = false
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [user])

  useEffect(() => {
    console.log("🛠️ DEBUG: AuthProvider - Initializing auth state listener")
    const configured = isFirebaseConfigValid()
    setIsFirebaseConfigured(configured)
    console.log("🛠️ DEBUG: AuthProvider - Firebase configured:", configured)

    if (!configured) {
      console.log("⚠️ DEBUG: AuthProvider - Firebase not configured, setting loading to false")
      setLoading(false)
      return
    }

    // Set initial loading state - keep it true until auth state is confirmed
    setLoading(true)
    console.log("🛠️ DEBUG: AuthProvider - Set loading to true, checking initial auth state")

    // Check initial auth state
    const currentUser = getCurrentUser()
    console.log("🛠️ DEBUG: AuthProvider - Initial currentUser:", currentUser ? currentUser.uid : "null")
    setUser(currentUser)
    
    // Note: We don't set loading to false here because onAuthStateChanged will fire immediately
    // with the current state, and that callback will set loading to false

    // Listen for auth state changes
    // onAuthStateChanged fires immediately with current state, then on changes
    const unsubscribe = onAuthChange((authUser) => {
      console.log("🛠️ DEBUG: AuthProvider - onAuthChange fired. User:", authUser ? authUser.uid : "null")
      console.log("🛠️ DEBUG: AuthProvider - Current Path:", typeof window !== 'undefined' ? window.location.pathname : 'SSR')
      console.log("🛠️ DEBUG: AuthProvider - Restaurant ID in Storage:", typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : 'N/A (SSR)')
      setUser(authUser)
      // CRITICAL: Set loading to false immediately to break the loading screen
      // This MUST run regardless of whether user is found or is null
      setLoading(false)
      console.log("🛠️ DEBUG: Auth state finalized. Loading set to false.")
    })

    return () => {
      console.log("🛠️ DEBUG: AuthProvider - Cleaning up auth listener")
      unsubscribe()
    }
  }, [])

  const signUp = async (email: string, password: string, restaurantName: string, phone?: string) => {
    const { signUpRestaurant } = await import('@/lib/firebase/auth')
    await signUpRestaurant(email, password, restaurantName, phone)
    // Auth state will update automatically via onAuthChange
  }

  const signIn = async (email: string, password: string) => {
    const { signIn } = await import('@/lib/firebase/auth')
    await signIn(email, password)
    // Auth state will update automatically via onAuthChange
  }

  const signOut = async () => {
    const { signOutUser } = await import('@/lib/firebase/auth')
    // Immediately clear all state and set loading to false to prevent loops
    setUser(null)
    setUserData(null)
    setRestaurant(null)
    setRestaurantId(null)
    setLoading(false)
    // Clear localStorage on sign out
    if (typeof window !== 'undefined') {
      localStorage.removeItem('restaurantId')
    }
    // Then sign out from Firebase (this will trigger onAuthChange which is fine)
    await signOutUser()
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        userData,
        restaurant,
        restaurantId,
        loading,
        isFirebaseConfigured,
        signUp,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

