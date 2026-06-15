export const dynamic = "force-dynamic";

import Link from "next/link"
import { OrdersDashboard } from "@/components/orders-dashboard"
import { ProtectedRoute } from "@/components/auth/protected-route"
import { Button } from "@/components/ui/button"
import { ClipboardList, Table2, UtensilsCrossed, BarChart3, Settings } from "lucide-react"

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-[#F7F6F3]">
        <section className="border-b border-[#E9E9E7] px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Dashboard</h1>
            <p className="mt-2 text-sm text-[#6B675F]">Quickly access core operations for your venue.</p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Button asChild variant="outline" className="h-auto justify-start rounded-lg border-[#E9E9E7] bg-white p-4 hover:bg-[#F1F0EC]">
                <Link href="/dashboard" className="flex items-start gap-3">
                  <ClipboardList className="mt-0.5 h-5 w-5 text-[#37352F]" />
                  <div className="text-left">
                    <div className="font-semibold text-[#37352F]">Live Orders</div>
                    <div className="text-xs text-[#6B675F]">Manage incoming orders</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="h-auto justify-start rounded-lg border-[#E9E9E7] bg-white p-4 hover:bg-[#F1F0EC]">
                <Link href="/qr-codes" className="flex items-start gap-3">
                  <Table2 className="mt-0.5 h-5 w-5 text-[#37352F]" />
                  <div className="text-left">
                    <div className="font-semibold text-[#37352F]">Tables</div>
                    <div className="text-xs text-[#6B675F]">Manage tables and QR codes</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="h-auto justify-start rounded-lg border-[#E9E9E7] bg-white p-4 hover:bg-[#F1F0EC]">
                <Link href="/menu-management" className="flex items-start gap-3">
                  <UtensilsCrossed className="mt-0.5 h-5 w-5 text-[#37352F]" />
                  <div className="text-left">
                    <div className="font-semibold text-[#37352F]">Menu Management</div>
                    <div className="text-xs text-[#6B675F]">Create and edit menu</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="h-auto justify-start rounded-lg border-[#E9E9E7] bg-white p-4 hover:bg-[#F1F0EC]">
                <Link href="/analytics" className="flex items-start gap-3">
                  <BarChart3 className="mt-0.5 h-5 w-5 text-[#37352F]" />
                  <div className="text-left">
                    <div className="font-semibold text-[#37352F]">Analytics</div>
                    <div className="text-xs text-[#6B675F]">View performance metrics</div>
                  </div>
                </Link>
              </Button>

              <Button asChild variant="outline" className="h-auto justify-start rounded-lg border-[#E9E9E7] bg-white p-4 hover:bg-[#F1F0EC]">
                <Link href="/settings" className="flex items-start gap-3">
                  <Settings className="mt-0.5 h-5 w-5 text-[#37352F]" />
                  <div className="text-left">
                    <div className="font-semibold text-[#37352F]">Settings</div>
                    <div className="text-xs text-[#6B675F]">Manage venue settings</div>
                  </div>
                </Link>
              </Button>
            </div>
          </div>
        </section>

        <OrdersDashboard />
      </div>
    </ProtectedRoute>
  )
}
