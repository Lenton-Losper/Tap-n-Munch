"use client"

import { useState } from "react"
import { ArrowLeft, Plus, Download, MoreVertical, Copy, Printer, Edit, Trash2, Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { QRCodeSVG } from "qrcode.react"

interface Table {
  id: string
  name: string
  location?: string
}

const initialTables: Table[] = [
  { id: "1", name: "Table 1" },
  { id: "2", name: "Table 2" },
  { id: "3", name: "Table 3" },
  { id: "4", name: "Table 4" },
  { id: "5", name: "Table 5" },
  { id: "6", name: "Table 6" },
]

export function QRCodeManagement() {
  const [tables, setTables] = useState<Table[]>(initialTables)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [newTableName, setNewTableName] = useState("")
  const [newTableLocation, setNewTableLocation] = useState("")
  const [showToast, setShowToast] = useState(false)
  const [toastMessage, setToastMessage] = useState("")

  const restaurantId = "demo-restaurant"
  const baseUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/menu`

  const handleAddTable = () => {
    if (!newTableName.trim()) return

    const newTable: Table = {
      id: Date.now().toString(),
      name: newTableName,
      location: newTableLocation || undefined,
    }

    setTables([...tables, newTable])
    setNewTableName("")
    setNewTableLocation("")
    setIsAddModalOpen(false)
    showToastMessage(`${newTable.name} created! Download QR code to print.`)
  }

  const handleDeleteTable = (id: string) => {
    setTables(tables.filter((t) => t.id !== id))
    showToastMessage("Table deleted successfully")
  }

  const handleCopyLink = (tableId: string, tableName: string) => {
    const link = `${baseUrl}?table=${tableId}`
    navigator.clipboard.writeText(link)
    showToastMessage("Link copied to clipboard!")
  }

  const showToastMessage = (message: string) => {
    setToastMessage(message)
    setShowToast(true)
    setTimeout(() => setShowToast(false), 3000)
  }

  const downloadQR = (tableName: string, tableId: string) => {
    // In a real app, this would generate a proper downloadable QR code
    showToastMessage(`Downloading QR code for ${tableName}...`)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast Notification */}
      {showToast && (
        <div className="fixed top-4 right-4 bg-green-600 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-in slide-in-from-top">
          {toastMessage}
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <button
                onClick={() => window.history.back()}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Go back"
              >
                <ArrowLeft className="w-5 h-5 text-gray-700" />
              </button>
              <h1 className="text-2xl font-bold text-gray-900">QR Codes & Tables</h1>
            </div>
            <Button onClick={() => setIsAddModalOpen(true)} className="bg-[#FF6B35] hover:bg-[#e55a28]">
              <Plus className="w-4 h-4 mr-2" />
              Add Table
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Main Menu QR Code Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Tap n Munch - Menu QR Code</h2>
          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* QR Code */}
            <div className="flex-shrink-0 p-4 bg-white border-2 border-gray-200 rounded-lg">
              <QRCodeSVG value={baseUrl} size={200} level="H" />
            </div>

            {/* Info and Actions */}
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Main Menu QR Code</h3>
              <p className="text-gray-600 mb-2">Customers scan this to browse your full menu</p>
              <p className="text-sm text-gray-500 mb-6">
                Perfect for window displays, social media, or delivery flyers
              </p>

              <div className="grid grid-cols-2 gap-3">
                <Button variant="outline" onClick={() => downloadQR("Main Menu", "main")}>
                  <Download className="w-4 h-4 mr-2" />
                  Download PNG
                </Button>
                <Button variant="outline" onClick={() => downloadQR("Main Menu", "main")}>
                  <Download className="w-4 h-4 mr-2" />
                  Download PDF
                </Button>
                <Button variant="outline" onClick={() => window.print()}>
                  <Printer className="w-4 h-4 mr-2" />
                  Print
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(baseUrl)
                    showToastMessage("Link copied to clipboard!")
                  }}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Share Link
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Table-Specific QR Codes */}
        <div>
          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-900">Table-Specific QR Codes</h2>
            <p className="text-sm text-gray-600 mt-1">
              Each table gets a unique QR code so you know where orders come from
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tables.map((table) => (
              <div
                key={table.id}
                className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow"
              >
                {/* Table Name */}
                <h3 className="text-lg font-bold text-gray-900 text-center mb-4">{table.name}</h3>

                {/* QR Code */}
                <div className="flex justify-center mb-4">
                  <div className="p-3 bg-white border border-gray-200 rounded-lg">
                    <QRCodeSVG value={`${baseUrl}?table=${table.id}`} size={150} level="H" />
                  </div>
                </div>

                {/* Actions */}
                <div className="space-y-2">
                  <Button
                    className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
                    onClick={() => downloadQR(table.name, table.id)}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="w-full bg-transparent">
                        <MoreVertical className="w-4 h-4 mr-2" />
                        More
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem>
                        <Edit className="w-4 h-4 mr-2" />
                        Edit Table Name
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => window.print()}>
                        <Printer className="w-4 h-4 mr-2" />
                        Print QR Code
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleCopyLink(table.id, table.name)}>
                        <Copy className="w-4 h-4 mr-2" />
                        Copy Link
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Eye className="w-4 h-4 mr-2" />
                        View Orders from This Table
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleDeleteTable(table.id)} className="text-red-600">
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete Table
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Add Table Modal */}
      <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Table</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="table-name">Table Name</Label>
              <Input
                id="table-name"
                placeholder="Table 7"
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="table-location">Location (Optional)</Label>
              <Input
                id="table-location"
                placeholder="Outdoor Patio"
                value={newTableLocation}
                onChange={(e) => setNewTableLocation(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddTable} className="bg-[#FF6B35] hover:bg-[#e55a28]">
              Create Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
