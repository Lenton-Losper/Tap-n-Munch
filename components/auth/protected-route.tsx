'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from './auth-provider'
import { Button } from '@/components/ui/button'
import { signOutUser } from '@/lib/firebase/auth'
import { initializeUserData } from '@/lib/firebase/initialize-user-data'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, userData, restaurantId, loading } = useAuth()
  const router = useRouter()
  const [initializing, setInitializing] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [hasRedirected, setHasRedirected] = useState(false)

  useEffect(() => {
    // Only redirect once auth has finished loading and user is not authenticated
    // Prevent redirect loops by checking hasRedirected flag
    if (!loading && !user && !hasRedirected) {
      setHasRedirected(true)
      router.push('/signin')
    }
  }, [user, loading, router, hasRedirected])

  // If user is null, immediately return null (don't wait for loading to finish)
  // This prevents components from trying to access restaurantId when user is signed out
  if (!user) {
    return null
  }

  // Only show loading if user exists but we're still loading their data
  if (loading) {
    console.log("⚠️ DEBUG: ProtectedRoute - Stuck in Loading branch. Checking dependencies...", {
      loading,
      user: user ? user.uid : null,
      userData: userData ? userData.id : null,
      restaurantId,
      pathname: typeof window !== 'undefined' ? window.location.pathname : 'SSR',
      localStorageRestaurantId: typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : 'N/A',
    })
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // Check if user is authenticated but Firestore data is missing
  if (user && !userData) {
    const handleInitialize = async () => {
      if (!user?.email) {
        setInitError('User email is missing. Please sign out and create a new account.')
        return
      }

      setInitializing(true)
      setInitError(null)

      try {
        console.log('🔄 Manually initializing user data...')
        await initializeUserData(user.uid, user.email)
        console.log('✅ User data initialized! Page will reload automatically.')
        
        // Reload the page to trigger auth provider to reload user data
        setTimeout(() => {
          window.location.reload()
        }, 1000)
      } catch (error: any) {
        console.error('❌ Failed to initialize user data:', error)
        setInitError(error.message || 'Failed to initialize account data. Please try signing out and creating a new account.')
        setInitializing(false)
      }
    }

    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-sm border border-border p-8 text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Account Data Missing
          </h2>
          <p className="text-gray-600 mb-6">
            You're signed in, but your account data is missing from the database. 
            This usually happens when Firestore data is deleted but Firebase Auth users remain.
          </p>
          
          {initError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
              {initError}
            </div>
          )}

          <div className="space-y-3">
            <Button
              onClick={handleInitialize}
              disabled={initializing}
              className="w-full bg-black hover:bg-black/90"
            >
              {initializing ? 'Initializing Account...' : '🔄 Initialize Account Data'}
            </Button>
            <Button
              onClick={async () => {
                await signOutUser()
                router.push('/signup')
              }}
              disabled={initializing}
              variant="outline"
              className="w-full"
            >
              Sign Out & Create New Account
            </Button>
            <Button
              onClick={async () => {
                await signOutUser()
                router.push('/signin')
              }}
              disabled={initializing}
              variant="outline"
              className="w-full"
            >
              Sign Out
            </Button>
          </div>
          <p className="text-sm text-gray-500 mt-6">
            Need help? Check{' '}
            <Link 
              href="/FIREBASE_CLEANUP.md" 
              target="_blank"
              className="text-black hover:underline font-medium"
            >
              FIREBASE_CLEANUP.md
            </Link>
            {' '}for instructions.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

