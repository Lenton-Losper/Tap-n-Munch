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
import { syncAuthProfile } from '@/lib/supabase/sync-profile'
import { parseStaffRole, type StaffRole } from '@/lib/permissions/staff-role'

export type { StaffRole }

interface AuthContextType {
  user: User | null
  userData: Record<string, any> | null
  restaurant: Record<string, any> | null
  restaurantId: string | null
  role: StaffRole | null
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
  role: null,
  loading: true,
  isSupabaseConfigured: false,
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

const RESTAURANT_SELECT =
  'id, name, phone, owner_id, subscription_status, subscription_tier, logo_url, updated_at'

const isSupabaseEnvConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userData, setUserData] = useState<Record<string, any> | null>(null)
  const [restaurant, setRestaurant] = useState<Record<string, any> | null>(null)
  const [restaurantId, setRestaurantId] = useState<string | null>(null)
  const [role, setRole] = useState<StaffRole | null>(null)
  const [loading, setLoading] = useState(isSupabaseEnvConfigured)
  const isSupabaseConfigured = isSupabaseEnvConfigured

  useEffect(() => {
    const loadUserData = async (_sessionUser: User | null) => {
      if (!_sessionUser) {
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
        setLoading(false)
        return
      }

      setLoading(true)

      try {
        const [{ data: { user: authUser }, error: authUserError }, { data: sessionData }] =
          await Promise.all([
            supabase.auth.getUser(),
            supabase.auth.getSession(),
          ])

        if (authUserError || !authUser) {
          console.error('[AuthProvider] getUser failed:', authUserError)
          setUserData(null)
          setRestaurant(null)
          setRestaurantId(null)
          setRole(null)
          return
        }

        const accessToken = sessionData.session?.access_token

        const [userLookup, roleResult] = await Promise.all([
          supabase.from('users').select('*').eq('id', authUser.id).maybeSingle(),
          accessToken
            ? fetch('/api/auth/role', { headers: { Authorization: `Bearer ${accessToken}` } })
            : Promise.resolve(null),
        ])

        let { data: userRecord, error: userRowError } = userLookup

        console.log('[AuthProvider] user lookup:', {
          authUserId: authUser.id,
          userRecord,
          error: userRowError,
        })

        if (userRowError) {
          throw userRowError
        }

        if (!userRecord) {
          const synced = await syncAuthProfile()
          if (synced) {
            const retry = await supabase
              .from('users')
              .select('*')
              .eq('id', authUser.id)
              .maybeSingle()

            console.log('[AuthProvider] user lookup retry:', {
              authUserId: authUser.id,
              userRecord: retry.data,
              error: retry.error,
            })

            userRecord = retry.data
            if (retry.error) {
              throw retry.error
            }
          }
        }

        setUserData((userRecord || null) as Record<string, any> | null)

        let linkedRestaurantId: string | null = null
        let resolvedRole: StaffRole | null = null

        if (roleResult) {
          const res = roleResult
          if (res.ok) {
            const payload = await res.json()
            resolvedRole = parseStaffRole(payload.role)
            if (payload.restaurant_id) {
              linkedRestaurantId = String(payload.restaurant_id)
            }
            console.log('[AuthProvider] role API result:', payload)
          } else {
            console.warn('[AuthProvider] role API failed:', res.status, await res.text())
          }
        }

        setRole(resolvedRole)

        if (!linkedRestaurantId && userRecord?.restaurant_id) {
          linkedRestaurantId = String(userRecord.restaurant_id)
        }

        if (!linkedRestaurantId) {
          setRestaurant(null)
          setRestaurantId(null)
          setRole(null)
          return
        }

        const { data: restaurantRow, error: restErr } = await supabase
          .from('restaurants')
          .select(RESTAURANT_SELECT)
          .eq('id', linkedRestaurantId)
          .single()

        if (restErr) {
          console.error('Failed to load restaurant row:', restErr)
          setRestaurant(null)
          setRestaurantId(linkedRestaurantId)
          return
        }

        const restaurantRecord = (restaurantRow || null) as Record<string, any> | null
        setRestaurant(restaurantRecord)
        setRestaurantId(
          (restaurantRecord?.id as string | undefined) || linkedRestaurantId
        )
        if (restaurantRecord?.id && typeof window !== 'undefined') {
          localStorage.setItem('restaurantId', String(restaurantRecord.id))
        }
      } catch (error) {
        console.error('Failed to load Supabase auth data:', error)
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
      } finally {
        setLoading(false)
      }
    }

    loadUserData(user)
  }, [user])

  useEffect(() => {
    if (!isSupabaseConfigured) return

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
  }, [isSupabaseConfigured])

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
    setRole(null)
    setLoading(false)
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
        role,
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
