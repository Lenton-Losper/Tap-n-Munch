'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  getSupabaseSession,
  onSupabaseAuthChange,
  signInWithSupabase,
  signOutSupabase,
  signUpWithSupabase,
} from '@/lib/supabase/auth'
import { supabase } from '@/lib/supabase/client'

interface AuthContextType {
  user: User | null
  userData: Record<string, any> | null
  restaurant: Record<string, any> | null
  restaurantId: string | null
  loading: boolean
  isSupabaseConfigured: boolean
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
  isSupabaseConfigured: false,
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userData, setUserData] = useState<Record<string, any> | null>(null)
  const [restaurant, setRestaurant] = useState<Record<string, any> | null>(null)
  const [restaurantId, setRestaurantId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isSupabaseConfigured, setIsSupabaseConfigured] = useState(true)

  // Load user data and restaurant when user changes
  useEffect(() => {
    const loadUserData = async (authUser: User | null) => {
      if (!authUser) {
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setLoading(false)
        return
      }

      try {
        const { data: userRow } = await supabase
          .from('users')
          .select('*')
          .eq('id', authUser.id)
          .maybeSingle()
        const userRecord = (userRow || null) as Record<string, any> | null

        setUserData(userRecord)

        if (userRecord?.restaurant_id) {
          const { data: restaurantRow, error: restErr } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', userRecord.restaurant_id)
            .single()
          if (restErr) throw restErr
          const restaurantRecord = (restaurantRow || null) as Record<string, any> | null
          setRestaurant(restaurantRecord)
          setRestaurantId((restaurantRecord?.id as string | undefined) || null)
          if (restaurantRecord?.id && typeof window !== 'undefined') {
            localStorage.setItem('restaurantId', String(restaurantRecord.id))
          }
        } else {
          setRestaurant(null)
          setRestaurantId(null)
        }
      } catch (error) {
        console.error('Failed to load Supabase auth data:', error)
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
      } finally {
        setLoading(false)
      }
    }

    loadUserData(user)
  }, [user])

  useEffect(() => {
    const configured = Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
    setIsSupabaseConfigured(configured)

    if (!configured) {
      setLoading(false)
      return
    }

    setLoading(true)

    getSupabaseSession()
      .then((session) => {
        setUser(session?.user ?? null)
      })
      .catch((error) => {
        console.error('Failed to get Supabase session:', error)
        setUser(null)
        setLoading(false)
      })

    const { data: listener } = onSupabaseAuthChange((session) => {
      setUser((session?.user as User | null) ?? null)
      setLoading(false)
    })

    return () => {
      listener.subscription.unsubscribe()
    }
  }, [])

  const signUp = async (email: string, password: string, restaurantName: string, phone?: string) => {
    await signUpWithSupabase(email, password, restaurantName, phone || '')
  }

  const signIn = async (email: string, password: string) => {
    await signInWithSupabase(email, password)
  }

  const signOut = async () => {
    setUser(null)
    setUserData(null)
    setRestaurant(null)
    setRestaurantId(null)
    setLoading(false)
    // Clear localStorage on sign out
    if (typeof window !== 'undefined') {
      localStorage.removeItem('restaurantId')
    }
    await signOutSupabase()
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        userData,
        restaurant,
        restaurantId,
        loading,
        isSupabaseConfigured,
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

