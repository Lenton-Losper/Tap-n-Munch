import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ShoppingCart, ClipboardList, BarChart3, QrCode, UtensilsCrossed } from "lucide-react"

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-white flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center space-y-4 mb-4">
        <h1 className="text-5xl font-bold text-balance bg-gradient-to-r from-[#FF6B35] to-orange-600 bg-clip-text text-transparent">
          Tap n Munch
        </h1>
        <p className="text-muted-foreground text-lg">Complete restaurant management solution</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-4xl">
        {/* Customer Section */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 hover:shadow-xl transition-shadow">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-orange-100 rounded-lg">
              <ShoppingCart className="w-6 h-6 text-[#FF6B35]" />
            </div>
            <h2 className="text-2xl font-bold">Customer View</h2>
          </div>
          <p className="text-gray-600 mb-6">Browse menu, customize items, and place orders</p>
          <Button asChild size="lg" className="w-full bg-[#FF6B35] hover:bg-[#e55a28]">
            <Link href="/menu">Open Menu</Link>
          </Button>
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
  )
}
