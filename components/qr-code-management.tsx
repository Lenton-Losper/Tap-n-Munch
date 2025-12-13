'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getTables, createTable, deleteTable, Table } from '@/lib/firebase/tables'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowLeft, Plus, Download, Copy, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'

export function QRCodeManagement() {
  const { user, restaurantId, restaurant } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [newTableNumber, setNewTableNumber] = useState('')
  const [newTableLocation, setNewTableLocation] = useState('')
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)

  useEffect(() => {
    if (!restaurantId) return

    const loadData = async () => {
      try {
        setLoading(true)
        console.log('Loading tables for restaurant:', restaurantId)
        const tablesData = await getTables(restaurantId)
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
  }, [restaurantId, toast])

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

      const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
      const qrCodeUrl = `${baseUrl}/menu/${restaurantId}?table=${tableNumber}`
      
      console.log('Creating table with QR URL:', qrCodeUrl)
      console.log('Restaurant ID:', restaurantId)

      await createTable({
        restaurant_id: restaurantId,
        table_number: tableNumber,
        table_name: `Table ${tableNumber}`,
        location: newTableLocation.trim() || undefined,
        qr_code_url: qrCodeUrl,
        active: true,
      })

      toast({
        title: 'Success',
        description: `Table ${tableNumber} created successfully`,
      })

      // Reload tables
      const updatedTables = await getTables(restaurantId)
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

    if (!restaurantId) return

    try {
      await deleteTable(table.id)
      toast({
        title: 'Success',
        description: 'Table deleted successfully',
      })
      const updatedTables = await getTables(restaurantId)
      setTables(updatedTables)
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete table',
        variant: 'destructive',
      })
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

  const handleDownloadQR = (table: Table) => {
    // Create a canvas element to render QR code
    const qrCode = document.getElementById(`qr-${table.id}`)
    if (!qrCode) return

    // For now, just copy the link - full PDF generation would require additional libraries
    handleCopyLink(table.qr_code_url, table.id)
    toast({
      title: 'Download',
      description: 'Use the copied link to generate QR codes externally, or print this page',
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const mainMenuUrl = restaurantId ? `${baseUrl}/menu/${restaurantId}` : ''
  
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => router.push('/')}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <h1 className="text-2xl font-bold text-gray-900">QR Codes & Tables</h1>
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
            <div className="bg-white p-4 rounded-lg border-2 border-gray-200">
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
                <Button variant="outline" onClick={() => window.print()}>
                  <Download className="w-4 h-4 mr-2" />
                  Print
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Table-Specific QR Codes */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Table-Specific QR Codes</h2>
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
              {tables.map((table) => (
                <div
                  key={table.id}
                  className="bg-gray-50 rounded-lg p-4 border border-gray-200"
                >
                  <div className="text-center mb-3">
                    <h3 className="font-semibold text-lg">{table.table_name}</h3>
                    {table.location && (
                      <p className="text-sm text-gray-600">{table.location}</p>
                    )}
                  </div>
                  <div className="flex justify-center mb-3">
                    <div id={`qr-${table.id}`} className="bg-white p-2 rounded">
                      <QRCodeSVG value={table.qr_code_url} size={150} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className={`w-full ${copiedLinkId === table.id ? 'bg-green-50 border-green-500 text-green-700' : ''}`}
                      onClick={() => handleCopyLink(table.qr_code_url, table.id)}
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
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
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
