'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import QRCode from 'qrcode'
import JSZip from 'jszip'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '@/components/ui/button'
import { getSupabaseTables } from '@/lib/supabase/tables'
import { buildOnboardingTableQrUrl } from '@/lib/onboarding/qr-url'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type TableRow = {
  id: string
  table_number: number
  table_name?: string | null
  qr_code_url?: string | null
}

type StepQrCodesProps = {
  restaurantId: string
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepQrCodes = forwardRef<StepHandle, StepQrCodesProps>(function StepQrCodes(
  { restaurantId, onError, setSaving },
  ref
) {
  const [tables, setTables] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [downloaded, setDownloaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const rows = await getSupabaseTables(restaurantId)
        if (!cancelled) setTables((rows || []) as TableRow[])
      } catch (error: unknown) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : 'Failed to load tables')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [restaurantId, onError])

  const getTableUrl = (table: TableRow) =>
    table.qr_code_url || buildOnboardingTableQrUrl(restaurantId, table.table_number)

  const downloadSingle = async (table: TableRow) => {
    const url = getTableUrl(table)
    const dataUrl = await QRCode.toDataURL(url, { width: 512, margin: 2 })
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = `table-${table.table_number}-qr.png`
    link.click()

    try {
      await onboardingFetch('/api/admin/setup-status', {
        method: 'PATCH',
        body: JSON.stringify({ flag: 'qr_downloaded' }),
      })
      setDownloaded(true)
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Failed to save QR download progress')
    }
  }

  const downloadAllZip = async () => {
    if (tables.length === 0) {
      onError('No tables found. Go back and configure tables first.')
      return
    }

    setSaving(true)
    onError('')

    try {
      const zip = new JSZip()
      for (const table of tables) {
        const url = getTableUrl(table)
        const dataUrl = await QRCode.toDataURL(url, { width: 512, margin: 2 })
        const base64 = dataUrl.split(',')[1]
        if (base64) {
          zip.file(`table-${table.table_number}-qr.png`, base64, { base64: true })
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'flashtap-table-qr-codes.zip'
      link.click()
      URL.revokeObjectURL(link.href)

      await onboardingFetch('/api/admin/setup-status', {
        method: 'PATCH',
        body: JSON.stringify({ flag: 'qr_downloaded' }),
      })
      setDownloaded(true)
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Failed to download QR codes')
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!downloaded) {
        onError('Download at least one QR code before continuing')
        return false
      }
      return true
    },
  }))

  if (loading) {
    return <p className="text-sm text-[#6B675F]">Loading tables...</p>
  }

  if (tables.length === 0) {
    return (
      <p className="text-sm text-[#6B675F]">
        No tables found. Go back to the Tables step and create your tables first.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          onClick={downloadAllZip}
          className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
        >
          Download All as ZIP
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tables.map((table) => {
          const url = getTableUrl(table)
          return (
            <div
              key={table.id}
              className="flex flex-col items-center rounded-lg border border-[#E9E9E7] bg-white p-4"
            >
              <p className="mb-3 text-sm font-medium text-[#37352F]">
                {table.table_name || `Table ${table.table_number}`}
              </p>
              <QRCodeSVG value={url} size={160} />
              <p className="mt-2 break-all text-center text-xs text-[#9B978E]">{url}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 rounded-lg border-[#E9E9E7]"
                onClick={() => downloadSingle(table)}
              >
                Download
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
})
