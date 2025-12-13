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

  useEffect(() => {
    if (!loading && !user) {
      router.push('/signin')
    }
  }, [user, loading, router])

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return null
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
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg border border-gray-200 p-8 text-center">
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
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
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
              className="text-[#FF6B35] hover:underline font-medium"
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

