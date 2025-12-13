'use client'

export default function DebugEnvPage() {
  const envVars = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">Environment Variables Debug</h1>
        <div className="bg-white rounded-lg shadow p-6 space-y-2">
          {Object.entries(envVars).map(([key, value]) => (
            <div key={key} className="border-b pb-2">
              <div className="font-semibold text-sm text-gray-600">{key}:</div>
              <div className={`text-sm ${value ? 'text-green-600' : 'text-red-600'}`}>
                {value ? `✓ ${value.substring(0, 50)}...` : '✗ Missing'}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-sm text-gray-600">
          <p>If all values show as "Missing", you need to:</p>
          <ol className="list-decimal list-inside mt-2 space-y-1">
            <li>Stop your dev server (Ctrl+C)</li>
            <li>Restart it with: <code className="bg-gray-100 px-2 py-1 rounded">npm run dev</code></li>
            <li>Refresh this page</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

