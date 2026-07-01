'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from './auth-provider'
import { Button } from '@/components/ui/button'
import { signOutSupabase } from '@/lib/supabase/auth'
import { syncAuthProfile } from '@/lib/supabase/sync-profile'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, userData, restaurantId, loading } = useAuth()
  const router = useRouter()
  const hasRedirectedRef = useRef(false)
  const [forceLoaded, setForceLoaded] = useState(false)
  const [repairingAccount, setRepairingAccount] = useState(false)
  const [prevLoading, setPrevLoading] = useState(loading)

  if (prevLoading !== loading) {
    setPrevLoading(loading)
    if (!loading) setForceLoaded(false)
  }

  useEffect(() => {
    if (!loading) return

    const timeout = setTimeout(() => {
      setForceLoaded(true)
    }, 5000)

    return () => clearTimeout(timeout)
  }, [loading])

  useEffect(() => {
    if (!loading && !user && !hasRedirectedRef.current) {
      hasRedirectedRef.current = true
      router.replace('/signin')
    }
  }, [user, loading, router])

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
            You&apos;re signed in, but your user row is missing from Supabase. We can try to link your account by email.
          </p>

          <div className="space-y-3">
            <Button
              onClick={async () => {
                setRepairingAccount(true)
                const ok = await syncAuthProfile()
                setRepairingAccount(false)
                if (ok) {
                  window.location.reload()
                }
              }}
              className="w-full bg-black hover:bg-black/90 text-white"
              disabled={repairingAccount}
            >
              {repairingAccount ? 'Repairing account...' : 'Repair My Account'}
            </Button>
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
