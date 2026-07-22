'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { useToast } from '@/hooks/use-toast'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'

type AgedInvoiceRow = {
  id: string
  document_number: string
  bill_to: string
  due_date: string
  balance: number
  days_overdue: number
}

type ByCustomerRow = {
  customer: string
  balance: number
  invoiceCount: number
  maxDaysOverdue: number
}

function formatMoney(value: number) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 'NAD 0.00'
  return `NAD ${amount.toFixed(2)}`
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString()
}

export function AgedReceivablesContent() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const [invoices, setInvoices] = useState<AgedInvoiceRow[]>([])
  const [byCustomer, setByCustomer] = useState<ByCustomerRow[]>([])
  const [totalOutstanding, setTotalOutstanding] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!restaurantId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(
        `/api/admin/documents/aged-receivables?restaurant_id=${encodeURIComponent(restaurantId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load aged receivables')
      }
      setInvoices(Array.isArray(payload?.invoices) ? payload.invoices : [])
      setByCustomer(Array.isArray(payload?.byCustomer) ? payload.byCustomer : [])
      setTotalOutstanding(Number(payload?.totalOutstanding) || 0)
    } catch (error: unknown) {
      toast({
        title: 'Could not load aged receivables',
        description: error instanceof Error ? error.message : 'Failed to load aged receivables',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch
    void load()
  }, [load])

  if (loading) {
    return <p className="px-6 py-8 text-sm text-muted-foreground">Loading aged receivables...</p>
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-[#FAFAF8] p-4">
        <p className="text-sm text-[#6B675F]">Total outstanding (overdue)</p>
        <p className="text-2xl font-semibold text-[#37352F]">{formatMoney(totalOutstanding)}</p>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="border-b px-5 py-3 text-sm font-medium text-[#37352F]">By customer</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Overdue invoices</th>
                <th className="px-5 py-3">Balance</th>
                <th className="px-5 py-3">Oldest (days)</th>
              </tr>
            </thead>
            <tbody>
              {byCustomer.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-[#6B675F]">
                    No overdue invoices — nothing outstanding past due.
                  </td>
                </tr>
              ) : (
                byCustomer.map((row) => (
                  <tr key={row.customer} className="border-t border-[#E9E9E7]">
                    <td className="px-5 py-3 font-medium text-[#37352F]">{row.customer}</td>
                    <td className="px-5 py-3 text-[#37352F]">{row.invoiceCount}</td>
                    <td className="px-5 py-3 text-[#37352F]">{formatMoney(row.balance)}</td>
                    <td className="px-5 py-3 text-[#37352F]">{row.maxDaysOverdue}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="border-b px-5 py-3 text-sm font-medium text-[#37352F]">By invoice</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-[#FAFAF8] text-left text-xs font-medium uppercase tracking-wide text-[#6B675F]">
              <tr>
                <th className="px-5 py-3">Invoice #</th>
                <th className="px-5 py-3">Bill To</th>
                <th className="px-5 py-3">Due date</th>
                <th className="px-5 py-3">Balance</th>
                <th className="px-5 py-3">Days overdue</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-[#6B675F]">
                    No overdue invoices.
                  </td>
                </tr>
              ) : (
                invoices.map((row) => (
                  <tr key={row.id} className="border-t border-[#E9E9E7]">
                    <td className="px-5 py-3 font-medium text-[#37352F]">{row.document_number}</td>
                    <td className="px-5 py-3 text-[#37352F]">{row.bill_to}</td>
                    <td className="px-5 py-3 text-[#6B675F]">{formatDate(row.due_date)}</td>
                    <td className="px-5 py-3 text-[#37352F]">{formatMoney(row.balance)}</td>
                    <td className="px-5 py-3 text-red-600 font-medium">{row.days_overdue}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
