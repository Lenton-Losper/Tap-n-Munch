'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface RestaurantRow {
  id: string
  name: string
  created_at: string
  subscription: { plan: string; status: string } | null
  features: { kiosk_enabled: boolean; staff_app_enabled: boolean } | null
}

export default function AdminRestaurantsPage() {
  const [restaurants, setRestaurants] = useState<RestaurantRow[]>([])
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const loadRestaurants = async () => {
      const { data: { session } } = await (await import('@/lib/supabase/client')).supabase.auth.getSession()
      const token = session?.access_token
      fetch('/api/platform/restaurants', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(r => r.json())
        .then(data => setRestaurants(data.restaurants ?? []))
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    loadRestaurants()
  }, [])

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Restaurants</h1>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left text-gray-500">
            <th className="py-3 pr-4">Name</th>
            <th className="py-3 pr-4">Plan</th>
            <th className="py-3 pr-4">Status</th>
            <th className="py-3 pr-4">Kiosk</th>
            <th className="py-3 pr-4">Staff App</th>
            <th className="py-3">Created</th>
          </tr>
        </thead>
        <tbody>
          {restaurants.map(r => (
            <tr
              key={r.id}
              className="border-b hover:bg-gray-50 cursor-pointer"
              onClick={() => router.push(`/admin/restaurants/${r.id}`)}
            >
              <td className="py-3 pr-4 font-medium">{r.name}</td>
              <td className="py-3 pr-4">{r.subscription?.plan ?? '—'}</td>
              <td className="py-3 pr-4">{r.subscription?.status ?? '—'}</td>
              <td className="py-3 pr-4">{r.features?.kiosk_enabled ? '✅' : '—'}</td>
              <td className="py-3 pr-4">{r.features?.staff_app_enabled ? '✅' : '—'}</td>
              <td className="py-3 text-gray-400">{new Date(r.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
