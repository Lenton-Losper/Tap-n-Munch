'use client'

export const dynamic = "force-dynamic"

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import { Button } from '@/components/ui/button'
import { ShoppingCart } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { doc, onSnapshot, collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'

function MenuLandingPageV2Content() {
  // 🚀 VERSION STAMP: This confirms the new route is loaded
  console.log("🚀 [SYSTEM LIVE] Version 3.0 - New Route Loaded")
  
  const params = useParams()
  const searchParams = useSearchParams()
  
  // Fix: Extract restaurantId from params (nested route: app/menu/[restaurantId]/v2/page.tsx)
  // useParams() returns { restaurantId: string } for this route structure
  const restaurantId = params?.restaurantId as string | undefined
  
  // Fix: Extract table parameter from searchParams
  const tableNumberParam = searchParams?.get('table')
  const tableNum = tableNumberParam ? Number(tableNumberParam) : 0
  
  // Debug logging with full params object
  console.log("🔍 [V2 DEBUG] Full params object:", params)
  console.log("🔍 [V2 DEBUG] Params keys:", Object.keys(params || {}))
  console.log("🔍 [V2 DEBUG] Restaurant ID:", restaurantId, "Type:", typeof restaurantId)
  console.log("🔍 [V2 DEBUG] Table ID from URL:", tableNumberParam, "Type:", typeof tableNumberParam)
  console.log("🔍 [V2 DEBUG] Converted Table Number:", tableNum, "Type:", typeof tableNum)
  
  // Early error logging if restaurantId is missing
  if (!restaurantId) {
    console.error("❌ [V2 ERROR] restaurantId is undefined or empty")
    console.error("❌ [V2 ERROR] Full params:", JSON.stringify(params))
  }
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionReady, setSessionReady] = useState(false)

  // Load restaurant data
  useEffect(() => {
    if (!restaurantId || !db) {
      if (!restaurantId) {
        console.error("❌ [V2 ERROR] Cannot load restaurant - restaurantId is missing")
        setError('Restaurant ID is missing from URL')
        setLoading(false)
      }
      return
    }

    const restaurantRef = doc(db, 'restaurants', restaurantId)
    const unsubscribe = onSnapshot(
      restaurantRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const restaurantData = { id: docSnap.id, ...docSnap.data() } as any
          console.log('✅ Restaurant loaded:', restaurantData.name)
          setRestaurant(restaurantData)
          setLoading(false)
        } else {
          console.error('❌ Restaurant not found with ID:', restaurantId)
          setError(`Restaurant not found. ID: ${restaurantId}`)
          setLoading(false)
        }
      },
      (err) => {
        console.error('❌ Error listening to restaurant data:', err)
        // Fallback to one-time fetch
        getRestaurant(restaurantId).then((data) => {
          if (data) {
            setRestaurant(data)
          } else {
            setError(`Restaurant not found. ID: ${restaurantId}`)
          }
          setLoading(false)
        })
      }
    )

    return () => unsubscribe()
  }, [restaurantId])

  // Hierarchical Table Fetch - Simplified, no index requirements
  useEffect(() => {
    if (!restaurant || !restaurantId || !db) return
    if (tableNum <= 0) {
      setLoading(false)
      setError(null)
      return
    }

    const loadTableData = async () => {
      try {
        console.log('🔍 [V2 TABLE FETCH] Fetching table:', tableNum, 'Type:', typeof tableNum)
        
        // Simplified query: Only table_number, no orderBy, no active filter
        // Check active status in memory after fetch
        const tablesRef = collection(db, 'restaurants', restaurantId, 'tables')
        const q = query(
          tablesRef,
          where('table_number', '==', tableNum)
        )
        
        const snapshot = await getDocs(q)
        
        if (snapshot.empty) {
          console.warn('⚠️ [V2 TABLE FETCH] No table found with number:', tableNum)
          setTable(null)
        } else {
          const tableDoc = snapshot.docs[0]
          const tableData = tableDoc.data()
          
          // Check active status in memory (not in query)
          if (tableData.active !== true) {
            console.warn('⚠️ [V2 TABLE FETCH] Table found but is INACTIVE:', tableNum)
            setTable(null)
          } else {
            console.log('✅ [V2 TABLE FETCH] Table verified:', tableDoc.id)
            setTable({
              id: tableDoc.id,
              ...tableData
            })
            
            // Initialize session
            let session = getCurrentSession()
            if (!session) {
              session = getOrCreateSession(restaurantId, String(tableNum))
            }
            
            if (session) {
              setSessionId(session)
              setSessionReady(true)
            }
          }
        }
      } catch (err: any) {
        // Failsafe: Log error but don't block menu
        console.error("❌ [PERMISSION ERROR] Table check bypassed. Path: restaurants/" + restaurantId + "/tables. Error:", err.message)
        console.warn('⚠️ [V2 TABLE FETCH] Table verification failed (non-blocking):', err.message)
        setTable(null)
        // Menu will still load - this is intentional
      }
      
      setLoading(false)
      setError(null)
    }
    
    loadTableData()
  }, [restaurant, restaurantId, tableNum])

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

  if (error && !restaurant) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Error</h1>
          <p className="text-gray-600 mb-2">{error || 'Restaurant not found'}</p>
          <p className="text-sm text-gray-500 mb-4">Invalid QR code or restaurant link</p>
          {restaurantId && (
            <div className="mt-4 p-3 bg-gray-100 rounded text-left text-xs font-mono break-all">
              <p className="font-semibold mb-1">Debug Info:</p>
              <p>Restaurant ID: {restaurantId}</p>
              <p>URL: {typeof window !== 'undefined' ? window.location.href : ''}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!restaurant && !loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Error</h1>
          <p className="text-gray-600 mb-2">Restaurant not found</p>
          {!restaurantId && (
            <div className="mt-4 p-3 bg-red-50 rounded text-left text-xs">
              <p className="font-semibold text-red-800">Debug Info:</p>
              <p>Restaurant ID: {restaurantId || 'MISSING'}</p>
              <p>Params object: {JSON.stringify(params)}</p>
              <p>URL: {typeof window !== 'undefined' ? window.location.href : 'N/A'}</p>
            </div>
          )}
        </div>
      </div>
    )
  }
  
  // Early error if restaurantId is missing
  if (!restaurantId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Error</h1>
          <p className="text-gray-600 mb-2">Restaurant ID is missing from URL</p>
          <div className="mt-4 p-3 bg-red-50 rounded text-left text-xs">
            <p className="font-semibold text-red-800">Debug Info:</p>
            <p>Params: {JSON.stringify(params)}</p>
            <p>URL: {typeof window !== 'undefined' ? window.location.href : 'N/A'}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex flex-col">
      <ActiveOrderBanner />
      
      <div className="flex flex-col items-center justify-center p-8 flex-1">
        <div className="w-full max-w-md text-center space-y-6">
          {/* Restaurant Logo */}
          {restaurant.logo_url ? (
            <div className="flex justify-center mb-4">
              <Image
                src={restaurant.logo_url}
                alt={restaurant.name}
                width={120}
                height={120}
                className="rounded-full object-cover"
              />
            </div>
          ) : (
            <div className="flex justify-center mb-4">
              <div className="w-24 h-24 rounded-full bg-[#FF6B35] flex items-center justify-center">
                <span className="text-3xl font-bold text-white">
                  {restaurant.name.charAt(0)}
                </span>
              </div>
            </div>
          )}

          {/* Restaurant Name */}
          <h1 className="text-4xl font-bold bg-gradient-to-r from-[#FF6B35] to-orange-600 bg-clip-text text-transparent">
            {restaurant.name}
          </h1>

          {/* Welcome Message */}
          <div className="space-y-2">
            <p className="text-xl text-gray-700">Welcome!</p>
            {tableNum > 0 && (
              <p className="text-lg text-gray-600">
                You're at <span className="font-semibold">Table {tableNum}</span>
              </p>
            )}
          </div>

          {/* View Menu Button */}
          <Link href={`/menu/${restaurantId}/browse${tableNum > 0 ? `?table=${tableNum}` : ''}`}>
            <Button
              size="lg"
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white text-lg py-6"
            >
              <ShoppingCart className="w-5 h-5 mr-2" />
              View Menu
            </Button>
          </Link>

          {/* View Receipt Button */}
          {sessionReady && sessionId && tableNum > 0 && (
            <Link href={`/menu/${restaurantId}/receipt?table=${tableNum}`}>
              <Button
                variant="outline"
                size="lg"
                className="w-full text-orange-600 border-orange-600 hover:bg-orange-50 text-lg py-6"
              >
                📋 View Receipt
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MenuLandingPageV2() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35] mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <MenuLandingPageV2Content />
    </Suspense>
  )
}

