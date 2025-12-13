'use client'

import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function FirebaseConfigError() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-8">
          <div className="flex items-center gap-3 mb-4">
            <AlertCircle className="w-6 h-6 text-red-600" />
            <h1 className="text-2xl font-bold text-gray-900">Firebase Not Configured</h1>
          </div>
          
          <p className="text-gray-600 mb-4">
            Firebase is not properly configured. Please set up your Firebase credentials to use this application.
          </p>

          <div className="bg-gray-50 rounded-md p-4 mb-6">
            <h3 className="font-semibold text-sm mb-2">Setup Instructions:</h3>
            <ol className="list-decimal list-inside space-y-1 text-sm text-gray-700">
              <li>Create a <code className="bg-gray-200 px-1 rounded">.env.local</code> file in the project root</li>
              <li>Add your Firebase configuration values (see <code className="bg-gray-200 px-1 rounded">FIREBASE_SETUP.md</code>)</li>
              <li>Restart your development server</li>
            </ol>
          </div>

          <div className="space-y-2">
            <Button asChild className="w-full bg-[#FF6B35] hover:bg-[#e55a28]">
              <Link href="/FIREBASE_SETUP.md" target="_blank">
                View Setup Guide
              </Link>
            </Button>
            <p className="text-xs text-gray-500 text-center">
              Required environment variables: NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, etc.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

