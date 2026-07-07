'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { DocumentFormModal } from '@/components/documents/document-form-modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/hooks/use-permissions'
import { useToast } from '@/hooks/use-toast'
import { PERMISSIONS } from '@/lib/permissions'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'

type DocumentType = 'quote' | 'invoice'

type DocumentListItem = {
  id: string
  type: DocumentType
  document_number: string
  issued_at: string
  due_date: string | null
  bill_to: string | null
  total: number
  balance: number
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
                    <th className="px-5 py-3">Bill To</th>
                    <th className="px-5 py-3">Issued</th>
                    <th className="px-5 py-3">Total</th>
                    <th className="px-5 py-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-[#6B675F]">
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
                        <td className="px-5 py-3 text-[#37352F]">{doc.bill_to || '—'}</td>
                        <td className="px-5 py-3 text-[#6B675F]">{formatDate(doc.issued_at)}</td>
                        <td className="px-5 py-3 text-[#37352F]">{formatMoney(doc.total)}</td>
                        <td className="px-5 py-3 text-[#37352F]">{formatMoney(doc.balance)}</td>
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
    </div>
  )
}
