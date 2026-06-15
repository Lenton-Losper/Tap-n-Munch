export const dynamic = "force-dynamic";

import { QRCodeManagement } from "@/components/qr-code-management"
import { TableCardGenerator } from "@/components/table-card-generator"
import { ProtectedRoute } from "@/components/auth/protected-route"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function QRCodesPage() {
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Tabs defaultValue="management" className="w-full">
            <TabsList className="mb-6">
              <TabsTrigger value="management">Tables</TabsTrigger>
              <TabsTrigger value="design">Design Studio</TabsTrigger>
            </TabsList>
            <TabsContent value="management" className="mt-0">
              <QRCodeManagement />
            </TabsContent>
            <TabsContent value="design" className="mt-0">
              <TableCardGenerator />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </ProtectedRoute>
  )
}
