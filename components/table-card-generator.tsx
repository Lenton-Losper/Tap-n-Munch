'use client'

import { useRef, useState, useEffect } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { QRCodeSVG } from 'qrcode.react'
import { toPng } from 'html-to-image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Download, Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { buildMenuUrl } from '@/lib/base-url'
import { getTables, Table } from '@/lib/firebase/tables'

export function TableCardGenerator() {
  const { user, restaurantId, restaurant } = useAuth()
  const { toast } = useToast()
  const cardRef = useRef<HTMLDivElement>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [selectedTable, setSelectedTable] = useState<number>(1)
  const [customTableNumber, setCustomTableNumber] = useState<string>('')
  const [tables, setTables] = useState<Table[]>([])
  const [loadingTables, setLoadingTables] = useState(true)

  useEffect(() => {
    if (!user || !restaurantId) {
      setLoadingTables(false)
      return
    }

    const loadTables = async () => {
      try {
        const tablesData = await getTables(restaurantId)
        setTables(tablesData)
        if (tablesData.length > 0) {
          setSelectedTable(tablesData[0].table_number)
        }
      } catch (error: any) {
        console.error('Error loading tables:', error)
      } finally {
        setLoadingTables(false)
      }
    }

    loadTables()
  }, [user, restaurantId])

  if (!restaurantId || !restaurant) {
    return (
      <div className="p-6 bg-white rounded-lg border">
        <p className="text-gray-600">Please sign in to generate table cards.</p>
      </div>
    )
  }

  // Helper function to create a fallback logo as data URL
  const createFallbackLogoDataUrl = (size: number = 80): string => {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    
    if (!ctx) return ''
    
    // Draw circular background
    ctx.fillStyle = '#FF6B35'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.fill()
    
    // Draw border
    ctx.strokeStyle = '#B8860B'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
    ctx.stroke()
    
    // Draw text (first letter of restaurant name)
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `bold ${size * 0.4}px Arial`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const firstLetter = restaurant?.name?.charAt(0) || 'R'
    ctx.fillText(firstLetter, size / 2, size / 2)
    
    return canvas.toDataURL('image/png')
  }

  // Pre-load images and replace failed ones with data URLs before calling toPng
  const preloadAndFixImages = async (element: HTMLElement): Promise<void> => {
    const images = element.querySelectorAll('img')
    const imagePromises: Promise<void>[] = []

    images.forEach((img) => {
      const promise = new Promise<void>((resolve) => {
        // If image already has a data URL, skip it
        if (img.src.startsWith('data:')) {
          resolve()
          return
        }

        // Create a new image to test loading
        const testImg = new Image()
        testImg.crossOrigin = 'anonymous'
        
        testImg.onload = () => {
          // Image loaded successfully, keep original
          resolve()
        }
        
        testImg.onerror = () => {
          // Image failed to load (CORS or other error), replace with fallback
          console.warn('Image failed to load, replacing with fallback:', img.src)
          const fallbackDataUrl = createFallbackLogoDataUrl(80)
          if (fallbackDataUrl) {
            // Make sure img is visible and replace src with data URL
            img.style.display = 'block'
            img.src = fallbackDataUrl
            // Hide any fallback divs since we're using data URL now
            const fallbackDiv = img.nextElementSibling as HTMLElement
            if (fallbackDiv) {
              fallbackDiv.style.display = 'none'
            }
          }
          resolve()
        }
        
        testImg.src = img.src
      })
      
      imagePromises.push(promise)
    })

    // Wait for all images to either load or be replaced
    await Promise.all(imagePromises)
    
    // Give browser a moment to render the changes
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  const handleDownloadCard = async (tableNumber: number) => {
    if (!cardRef.current) return

    setDownloading(tableNumber)
    try {
      // Pre-load and fix images before generating PNG
      // This prevents CORS errors from breaking the card generation
      await preloadAndFixImages(cardRef.current)

      // Generate high-resolution PNG (4x pixel ratio for print quality)
      // CORS Configuration: If logo fails to load, ensure Firebase Storage CORS is configured:
      // Run: gsutil cors set cors.json gs://YOUR-BUCKET-NAME
      // Where cors.json contains: [{"origin":["*"],"method":["GET"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 4,
        quality: 1.0,
        backgroundColor: '#FDF5E6',
        cacheBust: true, // Helps with CORS by adding cache-busting query params
        includeQueryParams: true, // Includes query params in image requests
      })

      // Create download link
      const link = document.createElement('a')
      link.download = `table-${tableNumber}-card.png`
      link.href = dataUrl
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      toast({
        title: 'Success',
        description: `Table ${tableNumber} card downloaded successfully!`,
      })
    } catch (error: any) {
      console.error('Error generating card:', error)
      toast({
        title: 'Error',
        description: error.message || 'Failed to generate card. If logo fails to load, check Firebase CORS settings.',
        variant: 'destructive',
      })
    } finally {
      setDownloading(null)
    }
  }

  const handleCustomTableGenerate = () => {
    const tableNum = parseInt(customTableNumber)
    if (isNaN(tableNum) || tableNum <= 0) {
      toast({
        title: 'Invalid table number',
        description: 'Please enter a valid table number',
        variant: 'destructive',
      })
      return
    }
    setSelectedTable(tableNum)
  }

  // Generate QR code URL
  const generateQRUrl = (tableNum: number) => {
    return buildMenuUrl(restaurantId, tableNum)
  }

  const currentTableNumber = selectedTable

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-2xl font-bold mb-4">QR Design Studio</h2>
        <p className="text-gray-600 mb-6">
          Generate print-ready table cards with QR codes. Each card is optimized for high-quality printing.
        </p>

        {/* Table Selection */}
        <div className="mb-6 space-y-4">
          {!loadingTables && tables.length > 0 && (
            <div>
              <Label className="text-sm font-medium text-gray-700 mb-2 block">
                Select Existing Table
              </Label>
              <div className="flex flex-wrap gap-2">
                {tables.map((table) => (
                  <Button
                    key={table.id}
                    variant={selectedTable === table.table_number ? 'default' : 'outline'}
                    onClick={() => setSelectedTable(table.table_number)}
                    className={
                      selectedTable === table.table_number
                        ? 'bg-[#FF6B35] hover:bg-[#e55a28] text-white'
                        : ''
                    }
                  >
                    Table {table.table_number}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="text-sm font-medium text-gray-700 mb-2 block">
              Or Enter Custom Table Number
            </Label>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="Enter table number"
                value={customTableNumber}
                onChange={(e) => setCustomTableNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCustomTableGenerate()
                  }
                }}
                className="max-w-xs"
              />
              <Button
                onClick={handleCustomTableGenerate}
                variant="outline"
              >
                Generate
              </Button>
            </div>
          </div>
        </div>

        {/* Preview Card */}
        <div className="flex justify-center mb-6">
          <div
            ref={cardRef}
            className="relative"
            style={{
              width: '500px',
              height: '750px',
              backgroundColor: '#FDF5E6',
              backgroundImage: `
                radial-gradient(circle at 1px 1px, rgba(0,0,0,0.03) 1px, transparent 0)
              `,
              backgroundSize: '20px 20px',
              border: '2px solid #B8860B',
              borderRadius: '8px',
              padding: '40px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            }}
          >
            {/* Ornate Corner Flourishes */}
            <svg
              className="absolute top-0 left-0"
              width="60"
              height="60"
              style={{ color: '#B8860B' }}
            >
              <path
                d="M 10 10 L 20 10 L 20 20 L 10 20 Z M 10 10 L 15 5 L 20 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <svg
              className="absolute top-0 right-0"
              width="60"
              height="60"
              style={{ color: '#B8860B' }}
            >
              <path
                d="M 50 10 L 40 10 L 40 20 L 50 20 Z M 50 10 L 45 5 L 40 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <svg
              className="absolute bottom-0 left-0"
              width="60"
              height="60"
              style={{ color: '#B8860B' }}
            >
              <path
                d="M 10 50 L 20 50 L 20 40 L 10 40 Z M 10 50 L 15 55 L 20 50"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <svg
              className="absolute bottom-0 right-0"
              width="60"
              height="60"
              style={{ color: '#B8860B' }}
            >
              <path
                d="M 50 50 L 40 50 L 40 40 L 50 40 Z M 50 50 L 45 55 L 40 50"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>

            {/* Header Section */}
            <div className="flex flex-col items-center mt-8">
              {/* Restaurant Logo */}
              <div className="mb-4">
                {restaurant.logo_url ? (
                  <img
                    src={restaurant.logo_url}
                    alt={restaurant.name}
                    width={80}
                    height={80}
                    className="rounded-full object-cover border-2 border-[#B8860B]"
                    crossOrigin="anonymous"
                    onError={(e) => {
                      // Fallback to placeholder if logo fails to load (CORS issue)
                      console.warn('Logo failed to load, using fallback')
                      const target = e.currentTarget
                      target.style.display = 'none'
                      // Show fallback div
                      const fallback = target.nextElementSibling as HTMLElement
                      if (fallback) {
                        fallback.style.display = 'flex'
                      }
                    }}
                  />
                ) : null}
                {/* Fallback logo - shown when logo_url is missing or fails to load */}
                <div
                  className={`w-20 h-20 rounded-full bg-[#FF6B35] flex items-center justify-center text-white text-2xl font-bold border-2 border-[#B8860B] ${restaurant.logo_url ? 'hidden' : ''}`}
                  style={{ display: restaurant.logo_url ? 'none' : 'flex' }}
                >
                  {restaurant.name?.charAt(0) || 'R'}
                </div>
              </div>

              {/* Restaurant Name - Large Serif */}
              <h1
                className="text-3xl font-serif font-bold text-gray-900 mb-1"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                {restaurant.name || "Isabel's Table"}
              </h1>

              {/* Subtitle - Small */}
              <p
                className="text-sm text-gray-600 italic"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                {restaurant.name?.split(' ')[0] || "Isabel"} at Table
              </p>
            </div>

            {/* Title Section */}
            <div className="text-center my-8">
              <h2
                className="text-2xl font-serif font-bold text-gray-900"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                Scan to Order & Pay
              </h2>
            </div>

            {/* QR Code Section */}
            <div className="flex flex-col items-center my-8">
              <div
                className="bg-white p-4 rounded-lg shadow-md"
                style={{
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                }}
              >
                <QRCodeSVG
                  value={generateQRUrl(currentTableNumber)}
                  size={200}
                  level="H"
                  includeMargin={true}
                />
              </div>
            </div>

            {/* Footer - Table Number */}
            <div className="mb-8">
              <p
                className="text-4xl font-serif font-bold text-gray-900 text-center"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                TABLE {currentTableNumber}
              </p>
            </div>
          </div>
        </div>

        {/* Download Button */}
        <div className="flex justify-center">
          <Button
            onClick={() => handleDownloadCard(currentTableNumber)}
            disabled={downloading === currentTableNumber}
            className="bg-[#FF6B35] hover:bg-[#e55a28] text-white"
            size="lg"
          >
            {downloading === currentTableNumber ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                Download Table {currentTableNumber} Card
              </>
            )}
          </Button>
        </div>

        <div className="mt-4 text-center text-sm text-gray-500">
          <p>Card dimensions: 500px × 750px</p>
          <p>Export resolution: 2000px × 3000px (4x for print quality)</p>
          <p className="mt-2 text-xs">QR Code URL: {generateQRUrl(currentTableNumber)}</p>
        </div>
      </div>
    </div>
  )
}

