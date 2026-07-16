'use client'

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  onSupabaseAuthChange,
  signInWithSupabase,
  signOutSupabase,
  signUpWithSupabase,
} from '@/lib/supabase/auth'
import { supabase } from '@/lib/supabase/client'
import { syncAuthProfile } from '@/lib/supabase/sync-profile'
import { parseStaffRole, type StaffRole } from '@/lib/permissions/staff-role'
import type { Permission } from '@/lib/permissions'

export type { StaffRole }

export type AccountStatus = 'loading' | 'ready' | 'missing' | 'failed'

interface AuthContextType {
  user: User | null
  userData: Record<string, any> | null
  restaurant: Record<string, any> | null
  restaurantId: string | null
  role: StaffRole | null
  permissions: Permission[]
  permissionsLoaded: boolean
  isPlatformAdmin: boolean
  roleResolved: boolean
  loading: boolean
  accountStatus: AccountStatus
  isSupabaseConfigured: boolean
  retryLoadUserData: () => Promise<void>
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
  permissions: [],
  permissionsLoaded: false,
  isPlatformAdmin: false,
  roleResolved: false,
  loading: true,
  accountStatus: 'loading',
  isSupabaseConfigured: false,
  retryLoadUserData: async () => {},
  signUp: async () => {},
  signIn: async () => {},
  signOut: async () => {},
})

const RESTAURANT_SELECT =
  'id, name, phone, owner_id, subscription_status, subscription_tier, logo_url, tax_rate, updated_at'

const isSupabaseEnvConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const isStagingDiag = () =>
  (process.env.NEXT_PUBLIC_APP_URL || '').includes('flashtap-staging')

function authDiagContext() {
  return {
    timestamp: new Date().toISOString(),
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userData, setUserData] = useState<Record<string, any> | null>(null)
  const [restaurant, setRestaurant] = useState<Record<string, any> | null>(null)
  const [restaurantId, setRestaurantId] = useState<string | null>(null)
  const [role, setRole] = useState<StaffRole | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [permissionsLoaded, setPermissionsLoaded] = useState(false)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false)
  const [roleResolved, setRoleResolved] = useState(false)
  const [loading, setLoading] = useState(isSupabaseEnvConfigured)
  const [accountStatus, setAccountStatus] = useState<AccountStatus>('loading')
  const [authResolved, setAuthResolved] = useState(false)
  const isSupabaseConfigured = isSupabaseEnvConfigured

  const loadUserData = useCallback(async (_sessionUser: User | null) => {
    const diagUserId = _sessionUser?.id

    if (isStagingDiag()) {
      console.log('[LOAD_USER_DATA]', {
        phase: 'start',
        user: diagUserId,
        timestamp: new Date().toISOString(),
      })
    }

    if (!_sessionUser) {
      setAccountStatus('loading')
      setUserData(null)
      setRestaurant(null)
      setRestaurantId(null)
      setRole(null)
      setPermissions([])
      setPermissionsLoaded(false)
      setIsPlatformAdmin(false)
      setRoleResolved(false)
      setLoading(false)
      if (isStagingDiag()) {
        console.log('[LOAD_USER_DATA]', {
          phase: 'end',
          user: diagUserId,
          timestamp: new Date().toISOString(),
        })
      }
      return
    }

    setAccountStatus('loading')
    setLoading(true)

    try {
      const [{ data: { user: authUser }, error: authUserError }, { data: sessionData }] =
        await Promise.all([
          supabase.auth.getUser(),
          supabase.auth.getSession(),
        ])

      if (authUserError || !authUser) {
        console.error('[AuthProvider] getUser failed:', authUserError)
        setAccountStatus('failed')
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
        setPermissions([])
        setPermissionsLoaded(false)
        setIsPlatformAdmin(false)
        setRoleResolved(false)
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
        console.error('[AuthProvider] users lookup failed', {
          query: 'users',
          error: userRowError,
          code: (userRowError as { code?: string }).code,
          message: userRowError.message,
          ...authDiagContext(),
        })
        setAccountStatus('failed')
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
        setPermissions([])
        setPermissionsLoaded(false)
        setIsPlatformAdmin(false)
        setRoleResolved(false)
        return
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
            console.error('[AuthProvider] users lookup retry failed', {
              query: 'users retry',
              error: retry.error,
              code: (retry.error as { code?: string }).code,
              message: retry.error.message,
              ...authDiagContext(),
            })
            throw retry.error
          }
        }
      }

      if (!userRecord) {
        setAccountStatus('missing')
        setUserData(null)
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
        setPermissions([])
        setPermissionsLoaded(false)
        setIsPlatformAdmin(false)
        setRoleResolved(false)
        return
      }

      setUserData(userRecord as Record<string, any>)
      setAccountStatus('ready')

      let linkedRestaurantId: string | null = null
      let resolvedRole: StaffRole | null = null
      let resolvedPermissions: Permission[] = []

      if (roleResult) {
        const res = roleResult
        if (res.ok) {
          const payload = await res.json()
          resolvedRole = parseStaffRole(payload.role)
          if (payload.restaurant_id) {
            linkedRestaurantId = String(payload.restaurant_id)
          }
          if (Array.isArray(payload.permissions)) {
            resolvedPermissions = payload.permissions as Permission[]
          }
          setPermissionsLoaded(true)
          setIsPlatformAdmin(payload.is_platform_admin === true)
          setRoleResolved(true)
          console.log('[AuthProvider] role API result:', payload)
        } else {
          const roleErrorBody = await res.text()
          console.error('[AuthProvider] role fetch failed', {
            query: 'role fetch',
            status: res.status,
            body: roleErrorBody,
            ...authDiagContext(),
          })
          setPermissionsLoaded(false)
          setIsPlatformAdmin(false)
          setRoleResolved(false)
          console.warn('[AuthProvider] role API failed:', res.status, roleErrorBody)
        }
      } else {
        setPermissionsLoaded(false)
        setIsPlatformAdmin(false)
        setRoleResolved(false)
      }

      setRole(resolvedRole)
      setPermissions(resolvedPermissions)

      if (!linkedRestaurantId && userRecord?.restaurant_id) {
        linkedRestaurantId = String(userRecord.restaurant_id)
      }

      if (!linkedRestaurantId) {
        // No restaurant is a valid, resolved outcome (e.g. a platform-admin-only
        // account) -- isPlatformAdmin was just correctly set above from the role API
        // result and must not be wiped out here just because there's no restaurant.
        setRestaurant(null)
        setRestaurantId(null)
        setRole(null)
        setPermissions([])
        setPermissionsLoaded(false)
        return
      }

      const { data: restaurantRow, error: restErr } = await supabase
        .from('restaurants')
        .select(RESTAURANT_SELECT)
        .eq('id', linkedRestaurantId)
        .single()

      if (restErr) {
        console.error('[AuthProvider] restaurant fetch failed', {
          query: 'restaurants',
          error: restErr,
          code: (restErr as { code?: string }).code,
          message: restErr.message,
          ...authDiagContext(),
        })
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
      console.error('[AuthProvider] loadUserData failed', {
        error,
        code:
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: string }).code
            : undefined,
        message: error instanceof Error ? error.message : String(error),
        ...authDiagContext(),
      })
      console.error('Failed to load Supabase auth data:', error)
      setUserData(null)
      setRestaurant(null)
      setRestaurantId(null)
      setRole(null)
      setPermissions([])
      setPermissionsLoaded(false)
      setIsPlatformAdmin(false)
      setRoleResolved(false)
      setAccountStatus((prev) => (prev === 'missing' ? prev : 'failed'))
    } finally {
      if (isStagingDiag()) {
        console.log('[LOAD_USER_DATA]', {
          phase: 'end',
          user: diagUserId,
          timestamp: new Date().toISOString(),
        })
      }
      setLoading(false)
    }
  }, [])

  const retryLoadUserData = useCallback(async () => {
    if (!user) return
    await loadUserData(user)
  }, [user, loadUserData])

  useEffect(() => {
    if (isStagingDiag()) {
      console.log('[AUTH_PROVIDER]', {
        phase: 'mount',
        timestamp: new Date().toISOString(),
      })
    }
    return () => {
      if (isStagingDiag()) {
        console.log('[AUTH_PROVIDER]', {
          phase: 'unmount',
          timestamp: new Date().toISOString(),
        })
      }
    }
  }, [])

  useEffect(() => {
    if (!authResolved) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional async data load when auth resolves/user changes; setState in loadUserData runs after network awaits, not synchronously in the effect body
    loadUserData(user)
  }, [user, authResolved, loadUserData])

  useEffect(() => {
    if (!isSupabaseConfigured) return

    const { data: listener } = onSupabaseAuthChange((event, session) => {
      console.log('[AUTH_EVENT]', {
        event,
        hasSession: !!session,
        timestamp: new Date().toISOString(),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      })
      if (event === 'USER_UPDATED') return
      setUser((session?.user as User | null) ?? null)
      setAuthResolved(true)
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
    setPermissions([])
    setPermissionsLoaded(false)
    setIsPlatformAdmin(false)
    setRoleResolved(false)
    setAccountStatus('loading')
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
        permissions,
        permissionsLoaded,
        isPlatformAdmin,
        roleResolved,
        loading,
        accountStatus,
        isSupabaseConfigured,
        retryLoadUserData,
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
