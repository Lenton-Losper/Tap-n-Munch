'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getSupabaseTables as getTables, createSupabaseTable as createTable, deleteSupabaseTable as deleteTable } from '@/lib/supabase/tables'
import { supabase } from '@/lib/supabase/client'
import { buildMenuUrl } from '@/lib/base-url'
import {
  resolveOrderRestaurantScope,
  type OrderRestaurantScope,
} from '@/lib/supabase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowLeft, Plus, Download, Copy, Trash2, DoorClosed } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

type Table = {
  id: string
  table_number: number
  table_name?: string
  location?: string
  qr_code_url?: string
  is_kiosk?: boolean
}

type TableLiveStatus = 'active' | 'needs_payment' | 'empty'

type OpenOrderRow = {
  table_number?: number | null
  status?: string | null
  payment_status?: string | null
}

const ACTIVE_STATUSES = new Set(['pending', 'accepted', 'ready', 'ready_for_terminal'])
const TERMINAL_STATUSES = new Set(['completed', 'cancelled'])

function computeTableStatus(orders: OpenOrderRow[]): TableLiveStatus {
  const open = orders.filter((o) => !TERMINAL_STATUSES.has(String(o.status || '').toLowerCase()))
  if (open.length === 0) return 'empty'

  const needsPayment = open.some(
    (o) =>
      String(o.payment_status || '').toLowerCase() === 'pending' &&
      String(o.status || '').toLowerCase() === 'ready'
  )
  if (needsPayment) return 'needs_payment'

  const isActive = open.some((o) => ACTIVE_STATUSES.has(String(o.status || '').toLowerCase()))
  if (isActive) return 'active'

  return 'empty'
}

function groupOrdersByTableStatus(orders: OpenOrderRow[]): Record<number, TableLiveStatus> {
  const byTable = new Map<number, OpenOrderRow[]>()
  for (const order of orders) {
    const tableNum = Number(order.table_number)
    if (!Number.isFinite(tableNum) || tableNum <= 0) continue
    const list = byTable.get(tableNum) || []
    list.push(order)
    byTable.set(tableNum, list)
  }
  const result: Record<number, TableLiveStatus> = {}
  byTable.forEach((tableOrders, tableNum) => {
    result[tableNum] = computeTableStatus(tableOrders)
  })
  return result
}

function TableStatusBadge({ status }: { status: TableLiveStatus }) {
  if (status === 'needs_payment') {
    return <Badge className="bg-red-600 text-white font-semibold">NEEDS PAYMENT</Badge>
  }
  if (status === 'active') {
    return <Badge className="bg-orange-500 text-white font-semibold">ACTIVE</Badge>
  }
  return <Badge className="bg-gray-500 text-white font-semibold">EMPTY</Badge>
}

function resolveRestaurantOwnerId(restaurant: Record<string, unknown> | null): string | null {
  if (!restaurant) return null
  const trimmed =
    restaurant.owner_id != null ? String(restaurant.owner_id).trim() : ''
  return trimmed || null
}

function canDeleteTablesForRestaurant(
  userId: string,
  restaurant: Record<string, unknown> | null,
  userData: Record<string, unknown> | null,
  restaurantId: string | null
): boolean {
  const ownerId = resolveRestaurantOwnerId(restaurant)
  if (ownerId && ownerId === userId) return true
  if (
    restaurantId &&
    String(userData?.restaurant_id || '') === String(restaurantId) &&
    String(userData?.id || '') === userId
  ) {
    return true
  }
  return false
}

export function QRCodeManagement() {
  const { user, restaurantId, restaurant, userData } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [newTableNumber, setNewTableNumber] = useState('')
  const [newTableLocation, setNewTableLocation] = useState('')
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  // CRITICAL: Prevent double execution (React Strict Mode + double clicks)
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null)
  const [orderScope, setOrderScope] = useState<OrderRestaurantScope | null>(null)
  const [tableStatusByNumber, setTableStatusByNumber] = useState<Record<number, TableLiveStatus>>({})
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)

  const refreshTableStatuses = useCallback(async () => {
    if (!restaurantId) return
    try {
      const scope = orderScope ?? (await resolveOrderRestaurantScope(restaurantId))
      if (!orderScope) setOrderScope(scope)

      const { data, error } = await supabase
        .from('orders')
        .select('table_number, status, payment_status')
        .eq('restaurant_id', scope.restaurantId)
        .eq('is_closed', false)
        .not('status', 'in', '("completed","cancelled")')

      if (error) {
        throw error
      }

      const grouped = groupOrdersByTableStatus((data || []) as OpenOrderRow[])
      setTableStatusByNumber(grouped)
    } catch (err) {
      console.error('[TABLES] failed to refresh table statuses', err)
    }
  }, [restaurantId, orderScope])

  useEffect(() => {
    // Don't run if user is null (prevents fetching when signed out)
    if (!user) {
      setLoading(false)
      return
    }

    if (!restaurantId) {
      setLoading(false)
      return
    }

    const loadData = async () => {
      try {
        setLoading(true)
        console.log('Loading tables for restaurant:', restaurantId)
        const tablesData = await getTables(restaurantId, true)
        console.log('Tables loaded:', tablesData.length)
        setTables(tablesData)
      } catch (err: any) {
        console.error('Error loading tables:', err)
        toast({
          title: 'Error',
          description: err.message || 'Failed to load tables',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [user, restaurantId, toast])

  useEffect(() => {
    if (!restaurantId) return
    void refreshTableStatuses()
    const interval = setInterval(() => {
      void refreshTableStatuses()
    }, 30_000)
    return () => clearInterval(interval)
  }, [restaurantId, refreshTableStatuses])

  const handleCloseTable = async (tableNumber: number) => {
    if (!restaurantId || closingTableNumber != null) return
    if (!confirm(`Close Table ${tableNumber}? All open orders will be marked completed and paid.`)) return

    try {
      setClosingTableNumber(tableNumber)
      const response = await fetch(`/api/tables/${encodeURIComponent(String(tableNumber))}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to close table')

      toast({
        title: 'Table closed',
        description: `Table ${tableNumber} orders marked completed and paid.`,
      })
      await refreshTableStatuses()
    } catch (err: unknown) {
      toast({
        title: 'Failed to close table',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setClosingTableNumber(null)
    }
  }

  const handleAddTable = async () => {
    if (!restaurantId || !newTableNumber.trim()) {
      toast({
        title: 'Error',
        description: 'Restaurant ID is missing. Please sign in again.',
        variant: 'destructive',
      })
      return
    }

    try {
      const tableNumber = parseInt(newTableNumber)
      if (isNaN(tableNumber) || tableNumber <= 0) {
        toast({
          title: 'Invalid table number',
          description: 'Please enter a valid table number',
          variant: 'destructive',
        })
        return
      }

      // Check if table number already exists
      const existingTable = tables.find(t => t.table_number === tableNumber)
      if (existingTable) {
        toast({
          title: 'Table exists',
          description: `Table ${tableNumber} already exists`,
          variant: 'destructive',
        })
        return
      }

      // Use centralized base URL utility to ensure QR codes point to production
      // Updated to use /v2 route for cache-busting
      if (!restaurantId) {
        toast({
          title: 'Error',
          description: 'Restaurant ID is missing. Please refresh the page and try again.',
          variant: 'destructive',
        })
        return
      }
      
      const qrCodeUrl = buildMenuUrl(restaurantId, tableNumber)
      
      console.log('📌 [QR DEBUG] Creating table with QR URL:', qrCodeUrl)
      console.log('📌 [QR DEBUG] Restaurant ID:', restaurantId)
      console.log('📌 [QR DEBUG] Table Number:', tableNumber)

      await createTable({
        restaurant_id: restaurantId,
        table_number: tableNumber,
        table_name: `Table ${tableNumber}`,
        qr_code_url: qrCodeUrl,
      })

      toast({
        title: 'Success',
        description: `Table ${tableNumber} created successfully`,
      })

      // Reload tables
      const updatedTables = await getTables(restaurantId, true)
      setTables(updatedTables)
      
      setNewTableNumber('')
      setNewTableLocation('')
      setIsAddModalOpen(false)
    } catch (err: any) {
      console.error('Error creating table:', err)
      toast({
        title: 'Error',
        description: err.message || 'Failed to create table',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteTable = async (table: Table) => {
    if (!confirm(`Delete ${table.table_name}? This cannot be undone.`)) return

    // CRITICAL: Prevent double execution (React Strict Mode + double clicks)
    if (deletingTableId === table.id) {
      console.warn('⚠️ [DELETE TABLE] Delete already in progress for table:', table.id)
      return // Already deleting - safe no-op
    }

    // SECURITY: Check authentication and ownership before delete
    console.log('🔍 [DELETE TABLE] Starting delete validation')
    
    // 1. Ensure auth is initialized
    if (!user) {
      console.error('❌ [DELETE TABLE] Authentication failed: user is null')
      toast({
        title: 'Authentication Required',
        description: 'You must be signed in to delete tables. Please sign in and try again.',
        variant: 'destructive',
      })
      return
    }
    
    console.log('✅ [DELETE TABLE] User authenticated:', {
      uid: (user as any).id,
      email: user.email
    })
    
    // 2. Check restaurant data is loaded
    if (!restaurant) {
      console.error('❌ [DELETE TABLE] Restaurant data not loaded')
      toast({
        title: 'Error',
        description: 'Restaurant data is not available. Please refresh the page and try again.',
        variant: 'destructive',
      })
      return
    }
    
    if (!restaurantId) {
      console.error('❌ [DELETE TABLE] Restaurant ID is missing')
      toast({
        title: 'Error',
        description: 'Restaurant ID is missing. Please refresh the page and try again.',
        variant: 'destructive',
      })
      return
    }
    
    const currentUserUid = user.id
    const restaurantOwnerId = resolveRestaurantOwnerId(restaurant)

    console.log('🔍 [DELETE TABLE] Ownership check:', {
      currentUserUid,
      restaurantOwnerId,
      owner_id: restaurant.owner_id,
      userRestaurantId: userData?.restaurant_id,
      canDelete: canDeleteTablesForRestaurant(currentUserUid, restaurant, userData, restaurantId),
    })

    if (!canDeleteTablesForRestaurant(currentUserUid, restaurant, userData, restaurantId)) {
      console.error('❌ [DELETE TABLE] Ownership verification failed')
      console.error('   Current user UID:', currentUserUid)
      console.error('   Restaurant owner (id/uid):', restaurantOwnerId)
      toast({
        title: 'Permission Denied',
        description: 'You do not have permission to delete tables. Only the restaurant owner can delete tables.',
        variant: 'destructive',
      })
      return
    }
    
    console.log('✅ [DELETE TABLE] Ownership verified - user is restaurant owner')
    
    // 4. Set deleting state to prevent double execution
    setDeletingTableId(table.id)
    
    // 5. Log table being deleted
    console.log('🗑️ [DELETE TABLE] Deleting table:', {
      tableId: table.id,
      tableName: table.table_name,
      tableNumber: table.table_number,
      restaurantId: restaurantId
    })

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) {
        toast({
          title: 'Authentication Required',
          description: 'Your session expired. Please sign in again.',
          variant: 'destructive',
        })
        return
      }

      await deleteTable(table.id, { restaurantId, accessToken })
      
      console.log('✅ [DELETE TABLE] Table deleted successfully')
      
      // CRITICAL: Immediately update UI state to remove deleted table (no ghost tables)
      setTables(prev => prev.filter(t => t.id !== table.id))
      
      toast({
        title: 'Success',
        description: 'Table deleted successfully',
      })
      
      // Optional: Reload tables list to ensure consistency (but UI is already updated)
      // This is a safety net, but the immediate filter above ensures no ghost tables
      try {
        const updatedTables = await getTables(restaurantId, true)
        setTables(updatedTables)
      } catch (reloadError: any) {
        // If reload fails, UI is already updated, so just log
        console.warn('⚠️ [DELETE TABLE] Failed to reload tables, but UI is already updated:', reloadError.message)
      }
    } catch (err: any) {
      // Log full error details for debugging
      console.error('❌ [DELETE TABLE] Delete operation failed:', {
        error: err.message,
        code: err.code,
        stack: err.stack,
        tableId: table.id,
        restaurantId: restaurantId,
        fullError: err
      })
      
      // Check if it's a permission error
      if (err?.code === 'permission-denied' || err?.message?.includes('permission')) {
        console.error('❌ [DELETE TABLE] Permission denied - check Firestore rules')
        console.error('   This may be due to:')
        console.error('   1. Firestore rules not deployed yet (rules take time to propagate)')
        console.error('   2. Restaurant document missing owner_id field')
        console.error('   3. User UID does not match restaurant.owner_id')
        console.error('   Current user UID:', (user as any).id)
        console.error('   Restaurant owner_id:', restaurant.owner_id)
        toast({
          title: 'Permission Denied',
          description: 'You do not have permission to delete this table. If you are the owner, wait a few seconds for Firestore rules to propagate, then try again.',
          variant: 'destructive',
        })
      } else {
        // Show the actual error message
        const errorMessage = err.message || 'Failed to delete table'
        console.error('❌ [DELETE TABLE] Error details:', errorMessage)
        toast({
          title: 'Error',
          description: errorMessage,
          variant: 'destructive',
        })
      }
    } finally {
      // CRITICAL: Always clear deleting state, even on error
      setDeletingTableId(null)
    }
  }

  const handleCopyLink = async (url: string, linkId: string = 'main') => {
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url)
        setCopiedLinkId(linkId)
        toast({
          title: 'Link Copied!',
          description: 'Link copied to clipboard',
        })
        // Reset after 2 seconds
        setTimeout(() => setCopiedLinkId(null), 2000)
        return
      }
      
      // Fallback for older browsers
      const textArea = document.createElement('textarea')
      textArea.value = url
      textArea.style.position = 'fixed'
      textArea.style.left = '-999999px'
      textArea.style.top = '-999999px'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      
      try {
        const successful = document.execCommand('copy')
        if (successful) {
          setCopiedLinkId(linkId)
          toast({
            title: 'Link Copied!',
            description: 'Link copied to clipboard',
          })
          // Reset after 2 seconds
          setTimeout(() => setCopiedLinkId(null), 2000)
        } else {
          throw new Error('Copy command failed')
        }
      } finally {
        document.body.removeChild(textArea)
      }
    } catch (err) {
      console.error('Failed to copy link:', err)
      toast({
        title: 'Copy failed',
        description: 'Please manually copy the link',
        variant: 'destructive',
      })
    }
  }

  // Helper function to download QR code as PNG
  const downloadQRCodeAsPNG = async (selector: string, filename: string, successMessage: string) => {
    try {
      const container = document.querySelector(selector)
      if (!container) {
        toast({
          title: 'Error',
          description: 'QR code container not found',
          variant: 'destructive',
        })
        return
      }

      const svgElement = container.querySelector('svg')
      if (!svgElement) {
        toast({
          title: 'Error',
          description: 'QR code SVG not found',
          variant: 'destructive',
        })
        return
      }

      // Clone the SVG to avoid modifying the original
      const clonedSvg = svgElement.cloneNode(true) as SVGElement
      
      // Get SVG data
      const svgData = new XMLSerializer().serializeToString(clonedSvg)
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
      const svgUrl = URL.createObjectURL(svgBlob)

      // Create an image element to convert SVG to canvas
      const img = new Image()
      img.onload = () => {
        // Create a canvas
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        
        if (!ctx) {
          toast({
            title: 'Error',
            description: 'Failed to create canvas context',
            variant: 'destructive',
          })
          URL.revokeObjectURL(svgUrl)
          return
        }

        // Draw the image on canvas
        ctx.drawImage(img, 0, 0)
        
        // Convert canvas to blob and download
        canvas.toBlob((blob) => {
          if (!blob) {
            toast({
              title: 'Error',
              description: 'Failed to create image blob',
              variant: 'destructive',
            })
            URL.revokeObjectURL(svgUrl)
            return
          }

          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          
          // Clean up
          URL.revokeObjectURL(url)
          URL.revokeObjectURL(svgUrl)
          
          toast({
            title: 'Success',
            description: successMessage,
          })
        }, 'image/png')
      }

      img.onerror = () => {
        toast({
          title: 'Error',
          description: 'Failed to load QR code image',
          variant: 'destructive',
        })
        URL.revokeObjectURL(svgUrl)
      }

      img.src = svgUrl
    } catch (error: any) {
      console.error('Error downloading QR code:', error)
      toast({
        title: 'Error',
        description: error.message || 'Failed to download QR code',
        variant: 'destructive',
      })
    }
  }

  const handleDownloadQR = async (table: Table) => {
    await downloadQRCodeAsPNG(
      `#qr-${table.id}`,
      `qr-code-table-${table.table_number}.png`,
      `QR code for ${table.table_name} downloaded`
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  // Ensure restaurantId exists before generating URLs
  if (!restaurantId) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-gray-900 mb-2">Restaurant ID Missing</h2>
          <p className="text-gray-600 mb-4">Please sign in again to access QR codes.</p>
          <Button onClick={() => router.push('/signin')}>Sign In</Button>
        </div>
      </div>
    )
  }
  
  // Use centralized base URL utility to ensure QR codes point to production
  // Updated to use /v2 route for cache-busting
  const mainMenuUrl = buildMenuUrl(restaurantId)
  
  console.log("📌 [QR DEBUG] Main Menu URL Generated:", mainMenuUrl)
  
  console.log("📌 [QR DEBUG] Main Menu URL Generated:", mainMenuUrl)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard')}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <h1 className="text-2xl font-bold text-gray-900">Tables</h1>
            </div>
            <Button
              onClick={() => setIsAddModalOpen(true)}
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Table
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Main Menu QR Code */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Main Menu QR Code</h2>
          <p className="text-sm text-gray-600 mb-4">
            This QR code links to your main menu. Customers can scan it to view your menu.
          </p>
          <div className="flex items-start gap-6">
            <div id="main-menu-qr" className="bg-white p-4 rounded-lg border-2 border-gray-200">
              <QRCodeSVG value={mainMenuUrl} size={200} />
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <Label className="text-sm font-medium text-gray-700">Menu URL</Label>
                <div className="mt-1 p-2 bg-gray-50 rounded border text-sm font-mono break-all">
                  {mainMenuUrl}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleCopyLink(mainMenuUrl, 'main')}
                  className={copiedLinkId === 'main' ? 'bg-green-50 border-green-500 text-green-700' : ''}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  {copiedLinkId === 'main' ? 'Link Copied!' : 'Copy Link'}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => downloadQRCodeAsPNG(
                    '#main-menu-qr',
                    'qr-code-main-menu.png',
                    'Main menu QR code downloaded'
                  )}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Table-Specific QR Codes */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Tables</h2>
          {tables.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 mb-4">No tables created yet</p>
              <Button onClick={() => setIsAddModalOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create First Table
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {tables.map((table) => {
                const liveStatus = tableStatusByNumber[table.table_number] ?? 'empty'
                return (
                <div
                  key={table.id}
                  className={cn(
                    'bg-gray-50 rounded-lg p-4 border border-gray-200',
                    liveStatus === 'needs_payment' && 'border-red-200',
                    liveStatus === 'active' && 'border-orange-200'
                  )}
                >
                  <div className="text-center mb-3 space-y-2">
                    <h3 className="font-semibold text-lg">Table {table.table_number}</h3>
                    <TableStatusBadge status={liveStatus} />
                    {table.location && (
                      <p className="text-sm text-gray-600">{table.location}</p>
                    )}
                  </div>
                  <div className="flex justify-center mb-3">
                    <div id={`qr-${table.id}`} className="bg-white p-2 rounded">
                      <QRCodeSVG
                        value={
                          (table.is_kiosk ? buildMenuUrl(restaurantId, table.table_number, true) : null)
                          || table.qr_code_url
                          || buildMenuUrl(restaurantId, table.table_number)
                        }
                        size={150}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full border-red-300 text-red-700 hover:bg-red-50"
                      onClick={() => void handleCloseTable(table.table_number)}
                      disabled={closingTableNumber === table.table_number}
                    >
                      <DoorClosed className="w-4 h-4 mr-2" />
                      {closingTableNumber === table.table_number ? 'Closing...' : 'Close Table'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`w-full ${copiedLinkId === table.id ? 'bg-green-50 border-green-500 text-green-700' : ''}`}
                      onClick={() =>
                        handleCopyLink(
                          (table.is_kiosk ? buildMenuUrl(restaurantId, table.table_number, true) : null)
                          || table.qr_code_url
                          || buildMenuUrl(restaurantId, table.table_number),
                          table.id
                        )
                      }
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      {copiedLinkId === table.id ? 'Link Copied!' : 'Copy Link'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => handleDownloadQR(table)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-red-600 hover:text-red-700"
                      onClick={() => handleDeleteTable(table)}
                      disabled={deletingTableId === table.id || deletingTableId !== null}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      {deletingTableId === table.id ? 'Deleting...' : 'Delete'}
                    </Button>
                  </div>
                </div>
              )})}
            </div>
          )}
        </div>
      </div>

      {/* Add Table Modal */}
      <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Table</DialogTitle>
            <DialogDescription>
              Create a new table with a unique table number and optional location.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="table-number">Table Number *</Label>
              <Input
                id="table-number"
                type="number"
                value={newTableNumber}
                onChange={(e) => setNewTableNumber(e.target.value)}
                onKeyDown={(e) => {
                  // Prevent Enter key from closing dialog
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleAddTable()
                  }
                }}
                placeholder="e.g., 7"
                min="1"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="table-location">Location (Optional)</Label>
              <Input
                id="table-location"
                value={newTableLocation}
                onChange={(e) => setNewTableLocation(e.target.value)}
                onKeyDown={(e) => {
                  // Prevent Enter key from closing dialog
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleAddTable()
                  }
                }}
                placeholder="e.g., Main Dining Area, Window Side"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddTable}
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
            >
              Create Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
