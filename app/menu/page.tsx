'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getTableByNumber } from '@/lib/firebase/tables'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import { Button } from '@/components/ui/button'
import { ShoppingCart, AlertCircle } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'

function MenuLandingPageContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const restaurantId = params.restaurantId as string
  
  // 1. FIXED: Convert URL string to Number immediately to match Database type
  const tableNumberParam = searchParams.get('table')
  const tableNum = tableNumberParam ? Number(tableNumberParam.replace(/\D/g, '')) : 0
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)

  // Real-time Restaurant Listener
  useEffect(() => {
    if (!restaurantId || !db) return

    const restaurantRef = doc(db, 'restaurants', restaurantId)
    const unsubscribe = onSnapshot(restaurantRef, (docSnap) => {
      if (docSnap.exists()) {
        setRestaurant({ id: docSnap.id, ...docSnap.data() })
        setLoading(false)
      } else {
        setError(`Restaurant not found`)
        setLoading(false)
      }
    }, (err) => {
      console.error('Snapshot error:', err)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [restaurantId])

  // Table Verification and Session Logic
  useEffect(() => {
    if (!restaurant || !restaurantId) return

    const loadTableData = async () => {
      if (tableNum > 0) {
        try {
          // Debugging log to confirm types
          console.log('🔍 [LOOKUP] Searching for Table:', tableNum, 'Type:', typeof tableNum)
          
          const tableData = await getTableByNumber(restaurantId, tableNum)
          
          if (tableData) {
            console.log('✅ [LOOKUP] Table verified:', tableData.id)
            setTable(tableData)
            
            // Session Recovery/Initialization
            let session = getCurrentSession()
            if (!session) {
              const recovered = await restoreSessionFromTable(restaurantId, tableNum)
              session = recovered || getOrCreateSession(restaurantId, String(tableNum))
            }
            
            if (session) {
              setSessionId(session)
              setSessionReady(true)
            }
          } else {
            console.warn('⚠️ [LOOKUP] Table', tableNum, 'not found in DB collection.')
          }
        } catch (err: any) {
          // Non-blocking error: Log permission issues but don't crash the menu
          console.error('❌ [LOOKUP] Permission or Query error:', err.message)
        }
      }
      setLoading(false)
    }

    loadTableData()
  }, [restaurant, restaurantId, tableNum])

  if (loading) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  // Fatal Error: Restaurant doesn't exist
  if (error || !restaurant) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900">Restaurant Not Found</h1>
        <p className="text-gray-600 mt-2">The link you followed may be invalid or expired.</p>
        <div className="mt-6 p-4 bg-gray-100 rounded text-xs font-mono text-left">
          <p>Restaurant ID: {restaurantId}</p>
          <p>Table Found: {table ? 'Yes' : 'No'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex flex-col">
      <ActiveOrderBanner />
      
      <div className="flex flex-col items-center justify-center p-8 flex-1">
        <div className="w-full max-w-md text-center space-y-8">
          {/* Logo Section */}
          <div className="flex justify-center">
            {restaurant.logo_url ? (
              <Image
                src={restaurant.logo_url}
                alt={restaurant.name}
                width={120}
                height={120}
                className="rounded-full shadow-lg object-cover"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-[#FF6B35] flex items-center justify-center text-white text-3xl font-bold shadow-lg">
                {restaurant.name?.charAt(0)}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h1 className="text-4xl font-extrabold text-gray-900">{restaurant.name}</h1>
            <p className="text-gray-500 italic">{restaurant.description || 'Welcome to our menu'}</p>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-orange-100">
            {tableNum > 0 ? (
              <div className="mb-6">
                <span className="text-sm uppercase tracking-widest text-orange-500 font-bold">Your Location</span>
                <p className="text-2xl font-bold text-gray-800">Table {tableNum}</p>
                {!table && <p className="text-xs text-red-500 mt-1">Note: Table not verified, ordering may be limited.</p>}
              </div>
            ) : (
              <p className="text-gray-600 mb-6">Scan a QR code at your table to start ordering.</p>
            )}

            <Link href={`/menu/${restaurantId}/browse${tableNum > 0 ? `?table=${tableNum}` : ''}`}>
              <Button size="lg" className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white py-7 text-xl rounded-xl shadow-md transition-all active:scale-95">
                <ShoppingCart className="w-6 h-6 mr-2" />
                View Full Menu
              </Button>
            </Link>
          </div>

          {sessionReady && sessionId && tableNum > 0 && (
            <Link href={`/menu/${restaurantId}/receipt?table=${tableNum}`}>
              <Button variant="ghost" className="w-full text-orange-600 hover:bg-orange-50 text-lg">
                📋 View My Current Receipt
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MenuLandingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    }>
      <MenuLandingPageContent />
    </Suspense>
  )
}