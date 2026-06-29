'use client'

import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  type FeatureFlagsState,
} from './constants'

export const FEATURE_FLAG_LABELS: Record<FeatureFlagKey, string> = {
  kitchen_enabled: 'Kitchen Display System',
  inventory_enabled: 'Inventory Management',
  analytics_enabled: 'Analytics',
  split_bill_enabled: 'Split Bill',
  reservations_enabled: 'Reservations',
  loyalty_enabled: 'Loyalty Programme',
  online_payments_enabled: 'Online Payments',
  multi_branch_enabled: 'Multi-Branch',
  staff_app_enabled: 'Staff App',
  kiosk_enabled: 'Kiosk Mode',
  whatsapp_enabled: 'WhatsApp Ordering',
}

interface FeatureFlagsPanelProps {
  restaurantId: string
  initialFeatures: FeatureFlagsState
}

export function FeatureFlagsPanel({ restaurantId, initialFeatures }: FeatureFlagsPanelProps) {
  const { toast } = useToast()
  const [features, setFeatures] = useState<FeatureFlagsState>(initialFeatures)
  const [toggling, setToggling] = useState<FeatureFlagKey | null>(null)

  const toggle = async (feature: FeatureFlagKey, value: boolean) => {
    setToggling(feature)
    setFeatures((prev) => ({ ...prev, [feature]: value }))

    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/platform/restaurants/${restaurantId}/features`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ [feature]: value }),
      })

      if (!res.ok) throw new Error('Failed to update feature')

      toast({
        title: `${FEATURE_FLAG_LABELS[feature]} ${value ? 'enabled' : 'disabled'}`,
      })
    } catch {
      setFeatures((prev) => ({ ...prev, [feature]: !value }))
      toast({ title: 'Failed to update feature', variant: 'destructive' })
    } finally {
      setToggling(null)
    }
  }

  return (
    <div className="space-y-3">
      {FEATURE_FLAG_KEYS.map((key) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 rounded-lg border border-[#E9E9E7] p-4"
        >
          <div className="space-y-1">
            <Label htmlFor={key} className="text-sm font-medium text-[#37352F]">
              {FEATURE_FLAG_LABELS[key]}
            </Label>
          </div>
          <Switch
            id={key}
            checked={features[key]}
            onCheckedChange={(checked) => void toggle(key, checked)}
            disabled={toggling === key}
          />
        </div>
      ))}
    </div>
  )
}
