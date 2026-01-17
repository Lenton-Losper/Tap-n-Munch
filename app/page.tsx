'use client'

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import { ShoppingCart, ClipboardList, BarChart3, QrCode, UtensilsCrossed, LogOut, Settings } from "lucide-react"
import { signOutUser } from "@/lib/firebase/auth"

export default function HomePage() {
  const { user, loading } = useAuth()
  const router = useRouter()

  // Diagnostic logging for auth state changes
  useEffect(() => {
    console.log("🛠️ DEBUG: Auth State Changed. User:", user ? user.uid : "Logged Out")
    console.log("🛠️ DEBUG: Current Path:", typeof window !== 'undefined' ? window.location.pathname : 'SSR')
    console.log("🛠️ DEBUG: Restaurant ID in Storage:", typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : 'N/A (SSR)')
    console.log("🛠️ DEBUG: Loading State:", loading)
    console.log("🛠️ DEBUG: User Object:", user ? { uid: user.uid, email: user.email } : null)
  }, [user, loading])

  useEffect(() => {
    // Redirect immediately if user is null (don't wait for loading to finish)
    // This prevents infinite loading screens when user is not authenticated
    if (!user) {
      console.log("🛠️ DEBUG: User is null, redirecting to /signin")
      router.push('/signin')
    }
  }, [user, router])

  const handleSignOut = async () => {
    try {
      await signOutUser()
      router.push('/signin')
    } catch (error) {
      console.error('Error signing out:', error)
    }
  }

  // Only show loading spinner while auth.currentUser is being determined
  // If user is null, we've already redirected, so don't show loading
  if (loading && user === null) {
    console.log("⚠️ DEBUG: Stuck in Loading branch. Checking dependencies...", {
      loading,
      user: user ? user.uid : null,
      pathname: typeof window !== 'undefined' ? window.location.pathname : 'SSR',
      localStorageRestaurantId: typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : 'N/A',
    })
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // If user is null, return null (redirect is happening via useEffect)
  if (!user) {
    return null
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-8 p-8">
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div className="text-center flex-1">
            <h1 className="text-5xl font-bold text-balance text-black">
              Tap n Munch
            </h1>
            <p className="text-muted-foreground text-lg">Complete restaurant management solution</p>
          </div>
          <Button
            variant="outline"
            onClick={handleSignOut}
            className="flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Customer Section */}
          <div className="bg-white rounded-sm border border-border p-8 transition-shadow">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-muted rounded-sm">
                <ShoppingCart className="w-6 h-6 text-black stroke-[1.5]" />
              </div>
              <h2 className="text-2xl font-bold">Customer View</h2>
            </div>
            <p className="text-muted-foreground mb-6">Browse menu, customize items, and place orders</p>
            <Button 
              asChild 
              size="lg" 
              className="w-full bg-black hover:bg-black/90"
              onClick={(e) => {
                // Customer menu requires restaurantId from URL
                // This button should only be used for testing
                // In production, customers access via QR code
                e.preventDefault()
                alert('Customer menu is accessed via QR code. The menu URL format is: /menu/[restaurantId]?table=7')
              }}
            >
              <Link href="#" onClick={(e) => e.preventDefault()}>
                View Customer Menu (QR Code)
              </Link>
            </Button>
            <p className="text-xs text-gray-500 mt-2 text-center">
              Customers access menu via QR code at their table
            </p>
          </div>

          {/* Management Section */}
          <div className="bg-white rounded-sm border border-border p-8 transition-shadow">
            <h2 className="text-2xl font-bold mb-6">Restaurant Management</h2>
            <div className="space-y-3">
              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/dashboard" className="flex items-start gap-3">
                  <ClipboardList className="w-5 h-5 text-black stroke-[1.5] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Live Orders</div>
                    <div className="text-sm text-gray-600">Manage incoming orders</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/menu-management" className="flex items-start gap-3">
                  <UtensilsCrossed className="w-5 h-5 text-black stroke-[1.5] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Menu Management</div>
                    <div className="text-sm text-gray-600">Create and edit your menu</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/analytics" className="flex items-start gap-3">
                  <BarChart3 className="w-5 h-5 text-black stroke-[1.5] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Analytics</div>
                    <div className="text-sm text-gray-600">View performance metrics</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/settings" className="flex items-start gap-3">
                  <Settings className="w-5 h-5 text-black stroke-[1.5] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Settings</div>
                    <div className="text-sm text-gray-600">Manage payment methods</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/qr-codes" className="flex items-start gap-3">
                  <QrCode className="w-5 h-5 text-black stroke-[1.5] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">QR Codes</div>
                    <div className="text-sm text-gray-600">Generate table QR codes</div>
                  </div>
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
