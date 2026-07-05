'use client'

import { Suspense } from 'react'
import { QRCodeManagement } from '@/components/qr-code-management'
import { TableCardGenerator } from '@/components/table-card-generator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export function OrderingChannelsContent() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Tabs defaultValue="management" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="management">Ordering Channels</TabsTrigger>
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
  )
}

export function OrderingChannelsContentWithSuspense() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-[#FF6B35]" />
        </div>
      }
    >
      <OrderingChannelsContent />
    </Suspense>
  )
}
