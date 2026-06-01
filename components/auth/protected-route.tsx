'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from './auth-provider'
import { Button } from '@/components/ui/button'
import { signOutSupabase } from '@/lib/supabase/auth'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, userData, restaurantId, loading } = useAuth()
  const router = useRouter()
  const [hasRedirected, setHasRedirected] = useState(false)
  const [forceLoaded, setForceLoaded] = useState(false)

  useEffect(() => {
    if (!loading) {
      setForceLoaded(false)
      return
    }

    const timeout = setTimeout(() => {
      if (loading) {
        console.warn('Auth loading timeout — forcing false')
        setForceLoaded(true)
      }
    }, 5000)

    return () => clearTimeout(timeout)
  }, [loading])

  useEffect(() => {
    // Only redirect once auth has finished loading and user is not authenticated
    // Prevent redirect loops by checking hasRedirected flag
    if (!loading && !user && !hasRedirected) {
      setHasRedirected(true)
      router.replace('/signin')
    }
  }, [user, loading, router, hasRedirected])

  // If user is null, immediately return null (don't wait for loading to finish)
  // This prevents components from trying to access restaurantId when user is signed out
  if (!user) {
    return null
  }

  // Only show loading if user exists but we're still loading their data
  if (loading && !forceLoaded) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // Check if user is authenticated but app user row is missing
  if (user && !userData) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-sm border border-border p-8 text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Account Data Missing
          </h2>
          <p className="text-gray-600 mb-6">
            You're signed in, but your user row is missing from Supabase.
          </p>

          <div className="space-y-3">
            <Button
              onClick={async () => {
                await signOutSupabase()
                router.push('/signup')
              }}
              variant="outline"
              className="w-full"
            >
              Sign Out & Create New Account
            </Button>
            <Button
              onClick={async () => {
                await signOutSupabase()
                router.push('/signin')
              }}
              variant="outline"
              className="w-full"
            >
              Sign Out
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

