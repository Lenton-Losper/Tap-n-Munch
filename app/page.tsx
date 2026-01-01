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

  useEffect(() => {
    // Task 2: Redirect unauthenticated users to menu instead of showing dashboard
    if (!loading && !user) {
      // Redirect to menu (public view) instead of showing management dashboard
      router.push('/menu')
    }
  }, [user, loading, router])

  const handleSignOut = async () => {
    try {
      await signOutUser()
      router.push('/signin')
    } catch (error) {
      console.error('Error signing out:', error)
    }
  }

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

  // Task 2: Don't show dashboard if user is not logged in
  if (!user) {
    return null // Will redirect to welcome
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex flex-col items-center justify-center gap-8 p-8">
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div className="text-center flex-1">
            <h1 className="text-5xl font-bold text-balance bg-gradient-to-r from-[#FF6B35] to-orange-600 bg-clip-text text-transparent">
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
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 hover:shadow-xl transition-shadow">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-orange-100 rounded-lg">
                <ShoppingCart className="w-6 h-6 text-[#FF6B35]" />
              </div>
              <h2 className="text-2xl font-bold">Customer View</h2>
            </div>
            <p className="text-gray-600 mb-6">Browse menu, customize items, and place orders</p>
            <Button 
              asChild 
              size="lg" 
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
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
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 hover:shadow-xl transition-shadow">
            <h2 className="text-2xl font-bold mb-6">Restaurant Management</h2>
            <div className="space-y-3">
              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/dashboard" className="flex items-start gap-3">
                  <ClipboardList className="w-5 h-5 text-[#FF6B35] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Live Orders</div>
                    <div className="text-sm text-gray-600">Manage incoming orders</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/menu-management" className="flex items-start gap-3">
                  <UtensilsCrossed className="w-5 h-5 text-[#FF6B35] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Menu Management</div>
                    <div className="text-sm text-gray-600">Create and edit your menu</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/analytics" className="flex items-start gap-3">
                  <BarChart3 className="w-5 h-5 text-[#FF6B35] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Analytics</div>
                    <div className="text-sm text-gray-600">View performance metrics</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/settings" className="flex items-start gap-3">
                  <Settings className="w-5 h-5 text-[#FF6B35] mt-0.5" />
                  <div className="text-left">
                    <div className="font-semibold">Settings</div>
                    <div className="text-sm text-gray-600">Manage payment methods</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="w-full justify-start h-auto py-4 bg-transparent">
                <Link href="/qr-codes" className="flex items-start gap-3">
                  <QrCode className="w-5 h-5 text-[#FF6B35] mt-0.5" />
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
