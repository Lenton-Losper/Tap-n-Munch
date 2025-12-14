export const dynamic = "force-dynamic";

'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getTableByNumber } from '@/lib/firebase/tables'
import { Button } from '@/components/ui/button'
import { ShoppingCart } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

export default function MenuLandingPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  
  const [restaurant, setRestaurant] = useState<any>(null)
  const [table, setTable] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        console.log('Loading customer menu for restaurant ID:', restaurantId)
        
        // Fetch restaurant data
        const restaurantData = await getRestaurant(restaurantId)
        console.log('Restaurant data fetched:', restaurantData ? 'Found' : 'Not found')
        
        if (!restaurantData) {
          console.error('Restaurant not found with ID:', restaurantId)
          setError(`Restaurant not found. ID: ${restaurantId}`)
          setLoading(false)
          return
        }
        
        console.log('Restaurant loaded:', restaurantData.name)
        setRestaurant(restaurantData)
        
        // Verify table exists
        if (tableNumber > 0) {
          console.log('Verifying table number:', tableNumber)
          const tableData = await getTableByNumber(restaurantId, tableNumber)
          if (!tableData) {
            console.warn('Table not found:', tableNumber)
            setError(`Invalid table number: ${tableNumber}`)
            setLoading(false)
            return
          }
          console.log('Table verified:', tableData.table_name)
          setTable(tableData)
        }
        
        setLoading(false)
      } catch (err: any) {
        console.error('Error loading restaurant:', err)
        setError(err.message || 'Failed to load restaurant')
        setLoading(false)
      }
    }
    
    if (restaurantId) {
      loadData()
    } else {
      console.error('No restaurant ID provided in URL')
      setError('Invalid restaurant link')
      setLoading(false)
    }
  }, [restaurantId, tableNumber])

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

  if (error || !restaurant) {
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
          <p className="text-xs text-gray-400 mt-4">
            Make sure you're using the correct restaurant ID from the QR code.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex flex-col items-center justify-center p-8">
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
          {tableNumber > 0 && (
            <p className="text-lg text-gray-600">
              You're at <span className="font-semibold">Table {tableNumber}</span>
            </p>
          )}
        </div>

        {/* View Menu Button */}
        <Link href={`/menu/${restaurantId}/browse${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
          <Button
            size="lg"
            className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white text-lg py-6"
          >
            <ShoppingCart className="w-5 h-5 mr-2" />
            View Menu
          </Button>
        </Link>
      </div>
    </div>
  )
}

