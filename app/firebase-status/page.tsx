'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { db, app, auth, isFirebaseConfigValid } from '@/lib/firebase/config'
import { getRestaurantData } from '@/lib/firebase/auth'
import { collection, getDocs } from 'firebase/firestore'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default function FirebaseStatusPage() {
  const { user } = useAuth()
  const [status, setStatus] = useState({
    config: false,
    app: false,
    auth: false,
    firestore: false,
    restaurantData: false,
    loading: true,
  })
  const [restaurantData, setRestaurantData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const checkStatus = async () => {
      const newStatus = {
        config: isFirebaseConfigValid(),
        app: app !== null,
        auth: auth !== null,
        firestore: db !== null,
        restaurantData: false,
        loading: false,
      }

      // Test Firestore connection
      if (db && user) {
        try {
          // Try to read restaurant data
          const data = await getRestaurantData(user.uid)
          if (data) {
            newStatus.restaurantData = true
            setRestaurantData(data)
          }

          // Try a simple Firestore query
          const testCollection = collection(db, 'restaurants')
          await getDocs(testCollection)
        } catch (err: any) {
          setError(err.message)
          console.error('Firestore test error:', err)
        }
      }

      setStatus(newStatus)
    }

    checkStatus()
  }, [user])

  const allConnected = status.config && status.app && status.auth && status.firestore

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h1 className="text-3xl font-bold mb-6">Firebase Connection Status</h1>

          <div className="space-y-4 mb-8">
            <StatusItem
              label="Firebase Configuration"
              status={status.config}
              description="Environment variables loaded"
            />
            <StatusItem
              label="Firebase App"
              status={status.app}
              description="Firebase app initialized"
            />
            <StatusItem
              label="Firebase Authentication"
              status={status.auth}
              description="Auth service connected"
            />
            <StatusItem
              label="Firestore Database"
              status={status.firestore}
              description="Database service connected"
            />
            {user && (
              <StatusItem
                label="Restaurant Data"
                status={status.restaurantData}
                description="Your restaurant data in Firestore"
              />
            )}
          </div>

          {status.loading ? (
            <div className="flex items-center gap-2 text-gray-600">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Checking connection...</span>
            </div>
          ) : allConnected ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
              <div className="flex items-center gap-2 text-green-800 mb-2">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-semibold">✅ Firebase is fully connected!</span>
              </div>
              <p className="text-sm text-green-700">
                All Firebase services are working correctly. You can now use authentication,
                Firestore database, and all other Firebase features.
              </p>
            </div>
          ) : (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <div className="flex items-center gap-2 text-red-800 mb-2">
                <XCircle className="w-5 h-5" />
                <span className="font-semibold">⚠️ Some Firebase services are not connected</span>
              </div>
              <p className="text-sm text-red-700">
                Please check your configuration and restart your development server.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
              <p className="text-sm text-yellow-800">
                <strong>Error:</strong> {error}
              </p>
            </div>
          )}

          {restaurantData && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-blue-900 mb-2">Your Restaurant Data:</h3>
              <pre className="text-xs text-blue-800 overflow-auto">
                {JSON.stringify(restaurantData, null, 2)}
              </pre>
            </div>
          )}

          {user && (
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold mb-2">Current User:</h3>
              <p className="text-sm text-gray-600">Email: {user.email}</p>
              <p className="text-sm text-gray-600">UID: {user.uid}</p>
            </div>
          )}

          <div className="flex gap-4">
            <Button asChild>
              <Link href="/">Go to Home</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">Go to Dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusItem({
  label,
  status,
  description,
}: {
  label: string
  status: boolean
  description: string
}) {
  return (
    <div className="flex items-center justify-between p-4 border rounded-lg">
      <div className="flex items-center gap-3">
        {status ? (
          <CheckCircle2 className="w-6 h-6 text-green-600" />
        ) : (
          <XCircle className="w-6 h-6 text-red-600" />
        )}
        <div>
          <div className="font-semibold">{label}</div>
          <div className="text-sm text-gray-600">{description}</div>
        </div>
      </div>
      <div className={`px-3 py-1 rounded-full text-sm font-medium ${
        status
          ? 'bg-green-100 text-green-800'
          : 'bg-red-100 text-red-800'
      }`}>
        {status ? 'Connected' : 'Not Connected'}
      </div>
    </div>
  )
}

