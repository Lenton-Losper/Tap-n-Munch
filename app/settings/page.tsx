'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurant, updateRestaurantSettings } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Banknote, CreditCard, Save } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Switch } from '@/components/ui/switch'
import { ProtectedRoute } from '@/components/auth/protected-route'

function PaymentSettingsContent() {
  const { restaurantId, restaurant: initialRestaurant } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [restaurant, setRestaurant] = useState(initialRestaurant)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cashEnabled, setCashEnabled] = useState(true)
  const [cardEnabled, setCardEnabled] = useState(false)

  useEffect(() => {
    const loadRestaurant = async () => {
      if (!restaurantId) return
      
      try {
        setLoading(true)
        const data = await getRestaurant(restaurantId)
        if (data) {
          setRestaurant(data)
          setCashEnabled(data.payment_methods?.includes('cash') ?? true)
          setCardEnabled(data.payment_methods?.includes('card') ?? false)
        }
      } catch (err) {
        console.error('Failed to load restaurant:', err)
        toast({
          title: 'Error',
          description: 'Failed to load restaurant settings',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    if (restaurantId) {
      loadRestaurant()
    }
  }, [restaurantId, toast])

  const handleSave = async () => {
    if (!restaurantId) return

    // Validate: at least one payment method must be enabled
    if (!cashEnabled && !cardEnabled) {
      toast({
        title: 'Validation Error',
        description: 'At least one payment method must be enabled',
        variant: 'destructive',
      })
      return
    }

    try {
      setSaving(true)
      const paymentMethods: string[] = []
      if (cashEnabled) paymentMethods.push('cash')
      if (cardEnabled) paymentMethods.push('card')

      await updateRestaurantSettings(restaurantId, {
        payment_methods: paymentMethods,
      })

      // Update local state
      setRestaurant((prev) => (prev ? { ...prev, payment_methods: paymentMethods } : null))

      toast({
        title: 'Settings saved',
        description: 'Payment methods updated successfully',
      })
    } catch (error: any) {
      toast({
        title: 'Save failed',
        description: error.message || 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/')}
            className="h-11 w-11"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-3xl font-bold">Payment Settings</h1>
        </div>
      </header>

      {/* Content */}
      <div className="container mx-auto px-6 py-6 max-w-2xl">
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold mb-2">Payment Methods</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Enable or disable payment methods for your restaurant. At least one method must be enabled.
            </p>
          </div>

          {/* Cash Payment */}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-orange-100 flex items-center justify-center">
                <Banknote className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <Label htmlFor="cash" className="text-base font-semibold cursor-pointer">
                  Cash Payment
                </Label>
                <p className="text-sm text-muted-foreground">
                  Customers pay with cash at their table
                </p>
              </div>
            </div>
            <Switch
              id="cash"
              checked={cashEnabled}
              onCheckedChange={setCashEnabled}
              disabled={!cardEnabled && cashEnabled} // Can't disable if it's the only one
            />
          </div>

          {/* Card Payment */}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                <CreditCard className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <Label htmlFor="card" className="text-base font-semibold cursor-pointer">
                  Card Payment
                </Label>
                <p className="text-sm text-muted-foreground">
                  Waiter will bring card machine to customer's table
                </p>
              </div>
            </div>
            <Switch
              id="card"
              checked={cardEnabled}
              onCheckedChange={setCardEnabled}
              disabled={!cashEnabled && cardEnabled} // Can't disable if it's the only one
            />
          </div>

          {/* Info Message */}
          {(!cashEnabled || !cardEnabled) && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-900">
                <strong>Note:</strong> Only the enabled payment method(s) will be shown to customers during checkout.
              </p>
            </div>
          )}

          {/* Save Button */}
          <div className="pt-4 border-t">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
              size="lg"
            >
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <PaymentSettingsContent />
    </ProtectedRoute>
  )
}

