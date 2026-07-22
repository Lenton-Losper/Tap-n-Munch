'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { DocumentFormModal } from '@/components/documents/document-form-modal'
import { RecordPaymentModal } from '@/components/documents/record-payment-modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/hooks/use-permissions'
import { useToast } from '@/hooks/use-toast'
import { PERMISSIONS } from '@/lib/permissions'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'

type DocumentType = 'quote' | 'invoice'

type DocumentStatus =
  | 'draft'
  | 'sent'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'void'
  | 'converted'
  | 'expired'
  | 'declined'

type DocumentListItem = {
  id: string
  type: DocumentType
  document_number: string
  issued_at: string
  due_date: string | null
  bill_to: string | null
  total: number
  balance: number
  status: DocumentStatus
}

function formatMoney(value: number) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 'NAD 0.00'
  return `NAD ${amount.toFixed(2)}`
}

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString()
}

function typeBadge(type: DocumentType) {
  if (type === 'invoice') {
    return <Badge className="bg-[#2E75B6] hover:bg-[#2E75B6]">Invoice</Badge>
  }
  return <Badge variant="secondary">Quote</Badge>
}

const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  partially_paid: 'Partially Paid',
  overdue: 'Overdue',
  void: 'Void',
  converted: 'Converted',
  expired: 'Expired',
  declined: 'Declined',
}

const STATUS_CLASSES: Record<DocumentStatus, string> = {
  draft: 'bg-[#E9E9E7] text-[#6B675F] hover:bg-[#E9E9E7]',
  sent: 'bg-[#2E75B6] hover:bg-[#2E75B6]',
  paid: 'bg-green-600 hover:bg-green-600',
  partially_paid: 'bg-amber-500 hover:bg-amber-500',
  overdue: 'bg-red-600 hover:bg-red-600',
  void: 'bg-[#6B675F] hover:bg-[#6B675F]',
  converted: 'bg-purple-600 hover:bg-purple-600',
  expired: 'bg-[#6B675F] hover:bg-[#6B675F]',
  declined: 'bg-[#6B675F] hover:bg-[#6B675F]',
}

function statusBadge(status: DocumentStatus) {
  return <Badge className={STATUS_CLASSES[status]}>{STATUS_LABELS[status]}</Badge>
}

export function DocumentsListContent() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const canWrite = permissionsLoaded && hasPermission(PERMISSIONS.DOCUMENTS_WRITE)

  const [documents, setDocuments] = useState<DocumentListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalType, setModalType] = useState<DocumentType>('quote')
  const [modalInstance, setModalInstance] = useState(0)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<DocumentListItem | null>(null)

  const loadDocuments = useCallback(async () => {
    if (!restaurantId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(
        `/api/admin/documents?restaurant_id=${encodeURIComponent(restaurantId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load documents')
      }
      setDocuments(Array.isArray(payload?.documents) ? payload.documents : [])
    } catch (error: unknown) {
      toast({
        title: 'Could not load documents',
        description: error instanceof Error ? error.message : 'Failed to load documents',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch
    void loadDocuments()
  }, [loadDocuments])

  const openCreateModal = (type: DocumentType) => {
    setModalType(type)
    setModalInstance((n) => n + 1)
    setModalOpen(true)
  }

  const handleDownloadPdf = async (doc: DocumentListItem) => {
    setDownloadingId(doc.id)
    try {
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(doc.id)}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload?.error || 'Download failed')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${doc.type}-${doc.document_number}.pdf`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch (error: unknown) {
      toast({
        title: 'Download failed',
        description: error instanceof Error ? error.message : 'Could not download PDF',
        variant: 'destructive',
      })
    } finally {
      setDownloadingId(null)
    }
  }

  const handleMarkSent = async (doc: DocumentListItem) => {
    setSendingId(doc.id)
    try {
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(doc.id)}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to mark as sent')
      }
      toast({ title: 'Marked as sent', description: `${doc.document_number} is now sent.` })
      void loadDocuments()
    } catch (error: unknown) {
      toast({
        title: 'Action failed',
        description: error instanceof Error ? error.message : 'Failed to mark as sent',
        variant: 'destructive',
      })
    } finally {
      setSendingId(null)
    }
  }

  const handleConvert = async (doc: DocumentListItem) => {
    setConvertingId(doc.id)
    try {
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/documents/${encodeURIComponent(doc.id)}/convert`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to convert quote to invoice')
      }
      toast({
        title: 'Converted to invoice',
        description: `Invoice #${payload?.invoice?.document_number ?? ''} created from ${doc.document_number}.`,
      })
      void loadDocuments()
    } catch (error: unknown) {
      toast({
        title: 'Conversion failed',
        description: error instanceof Error ? error.message : 'Failed to convert quote to invoice',
        variant: 'destructive',
      })
    } finally {
      setConvertingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Documents</h1>
            <p className="mt-1 text-sm text-[#6B675F]">
              Create and manage quotes and invoices for your restaurant.
            </p>
          </div>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => openCreateModal('quote')}>
                <Plus className="mr-2 h-4 w-4" />
                New Quote
              </Button>
              <Button
                type="button"
                className="bg-[#FF6B35] hover:bg-[#e55a28]"
                onClick={() => openCreateModal('invoice')}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Invoice
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="bg-card overflow-hidden rounded-lg border">
          {loading ? (
            <p className="px-6 py-8 text-sm text-muted-foreground">Loading documents...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
                  <tr>
                    <th className="px-5 py-3">Document #</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Bill To</th>
                    <th className="px-5 py-3">Issued</th>
                    <th className="px-5 py-3">Total</th>
                    <th className="px-5 py-3">Balance</th>
                    <th className="px-5 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-5 py-8 text-center text-[#6B675F]">
                        No documents yet. Create a quote or invoice to get started.
                      </td>
                    </tr>
                  ) : (
                    documents.map((doc) => (
                      <tr key={doc.id} className="border-t border-[#E9E9E7]">
                        <td className="px-5 py-3 font-medium text-[#37352F]">
                          {doc.document_number}
                        </td>
                        <td className="px-5 py-3">{typeBadge(doc.type)}</td>
                        <td className="px-5 py-3">{statusBadge(doc.status)}</td>
                        <td className="px-5 py-3 text-[#37352F]">{doc.bill_to || '—'}</td>
                        <td className="px-5 py-3 text-[#6B675F]">{formatDate(doc.issued_at)}</td>
                        <td className="px-5 py-3 text-[#37352F]">{formatMoney(doc.total)}</td>
                        <td className="px-5 py-3 text-[#37352F]">{formatMoney(doc.balance)}</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void handleDownloadPdf(doc)}
                              disabled={downloadingId === doc.id}
                            >
                              <Download className="mr-1.5 h-3.5 w-3.5" />
                              {downloadingId === doc.id ? 'Downloading...' : 'PDF'}
                            </Button>
                            {canWrite && doc.status === 'draft' ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleMarkSent(doc)}
                                disabled={sendingId === doc.id}
                              >
                                {sendingId === doc.id ? 'Sending...' : 'Mark Sent'}
                              </Button>
                            ) : null}
                            {canWrite &&
                            doc.type === 'invoice' &&
                            (doc.status === 'sent' ||
                              doc.status === 'partially_paid' ||
                              doc.status === 'overdue') ? (
                              <Button
                                type="button"
                                size="sm"
                                className="bg-[#FF6B35] hover:bg-[#e55a28]"
                                onClick={() => setPaymentTarget(doc)}
                              >
                                Record Payment
                              </Button>
                            ) : null}
                            {canWrite &&
                            doc.type === 'quote' &&
                            (doc.status === 'draft' || doc.status === 'sent') ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleConvert(doc)}
                                disabled={convertingId === doc.id}
                              >
                                {convertingId === doc.id ? 'Converting...' : 'Convert to Invoice'}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <DocumentFormModal
        key={modalInstance}
        open={modalOpen}
        onOpenChange={setModalOpen}
        documentType={modalType}
        onSuccess={() => void loadDocuments()}
      />

      {paymentTarget ? (
        <RecordPaymentModal
          open={Boolean(paymentTarget)}
          onOpenChange={(open) => {
            if (!open) setPaymentTarget(null)
          }}
          documentId={paymentTarget.id}
          documentNumber={paymentTarget.document_number}
          balance={paymentTarget.balance}
          onRecorded={() => void loadDocuments()}
        />
      ) : null}
    </div>
  )
}
