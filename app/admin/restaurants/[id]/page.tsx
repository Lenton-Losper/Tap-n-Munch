'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

const FEATURE_LABELS: Record<string, string> = {
  kitchen_enabled: 'Kitchen Display',
  inventory_enabled: 'Inventory / Stock Control',
  analytics_enabled: 'Analytics',
  split_bill_enabled: 'Split Bill',
  reservations_enabled: 'Reservations',
  loyalty_enabled: 'Loyalty',
  online_payments_enabled: 'Online Payments',
  multi_branch_enabled: 'Multi Branch',
  staff_app_enabled: 'Staff App',
  kiosk_enabled: 'Kiosk Mode',
  whatsapp_enabled: 'WhatsApp Bot',
}

export default function AdminRestaurantDetailPage() {
  const params = useParams()
  const id = params.id as string
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [subscription, setSubscription] = useState<{ plan: string; status: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)

  useEffect(() => {
    const loadRestaurant = async () => {
      const { data: { session } } = await (await import('@/lib/supabase/client')).supabase.auth.getSession()
      const token = session?.access_token
      fetch(`/api/platform/restaurants/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(r => r.json())
        .then(data => {
          setName(data.restaurant?.name ?? '')
          setFeatures(data.features ?? {})
          setSubscription(data.subscription ?? null)
        })
        .finally(() => setLoading(false))
    }
    loadRestaurant()
  }, [id])

  const toggle = async (feature: string, value: boolean) => {
    setToggling(feature)
    setFeatures(prev => ({ ...prev, [feature]: value }))
    try {
      const { data: { session } } = await (await import('@/lib/supabase/client')).supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`/api/platform/restaurants/${id}/features`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ [feature]: value }),
      })
      if (!res.ok) throw new Error('Failed')
      toast({ title: `${FEATURE_LABELS[feature]} ${value ? 'enabled' : 'disabled'}` })
    } catch {
      setFeatures(prev => ({ ...prev, [feature]: !value }))
      toast({ title: 'Failed to update', variant: 'destructive' })
    } finally {
      setToggling(null)
    }
  }

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">{name}</h1>
      {subscription && (
        <p className="text-sm text-gray-500 mb-8">
          Plan: <span className="font-medium">{subscription.plan}</span> —
          Status: <span className="font-medium">{subscription.status}</span>
        </p>
      )}
      <h2 className="text-lg font-semibold mb-4">Feature Flags</h2>
      <div className="flex flex-col gap-4">
        {Object.entries(FEATURE_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center justify-between py-2 border-b">
            <Label htmlFor={key} className="text-sm">{label}</Label>
            <Switch
              id={key}
              checked={!!features[key]}
              onCheckedChange={val => toggle(key, val)}
              disabled={toggling === key}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
