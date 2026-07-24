'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { EmptyState, KpiCard } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type PaymentRow = {
  id?: string
  order_id?: string
  order_ids?: string[]
  restaurant_id?: string
  restaurant_name?: string
  restaurants?: { name?: string } | Array<{ name?: string }> | null
  merchant_order_no?: string
  paycloud_merchant_order_no?: string
  business_order_no?: string
  order_number?: string
  event_type?: string
  payment_status?: string
  status?: string
  amount?: number | string
  total?: number | string
  gateway_result_message?: string
  error?: string
  created_at?: string
  placed_at?: string
}

type PaymentsPayload = {
  kpis?: Record<string, number | string | null>
  summary?: Record<string, number | string | null>
  failedPayments?: PaymentRow[]
  failed_payments?: PaymentRow[]
  failedOrders?: PaymentRow[]
  events?: PaymentRow[]
  recentEvents?: PaymentRow[]
  recent_events?: PaymentRow[]
  paymentEvents?: PaymentRow[]
}

function money(value: unknown) {
  const amount = Number(value || 0)
  return `N$${amount.toLocaleString('en-NA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function ref(row: PaymentRow) {
  return (
    row.merchant_order_no ||
    row.paycloud_merchant_order_no ||
    row.business_order_no ||
    row.order_number ||
    row.order_id ||
    '—'
  )
}

function restaurantName(row: PaymentRow) {
  const relation = Array.isArray(row.restaurants) ? row.restaurants[0] : row.restaurants
  return row.restaurant_name || relation?.name || '—'
}

export default function PaymentsPage() {
  const [data, setData] = useState<PaymentsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/payments', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load payments')
      setData(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load payments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  if (loading) return <p className="text-sm text-[#8A867C]">Loading payment operations…</p>
  if (error || !data) {
    return <EmptyState title="Payments unavailable" body={error || 'No payment data.'} />
  }

  const kpis = data.kpis || data.summary || {}
  const failed = data.failedOrders || data.failedPayments || data.failed_payments || []
  const events =
    data.paymentEvents || data.recentEvents || data.recent_events || data.events || []
  const successRate = kpis.successRate ?? kpis.success_rate ?? kpis.paymentSuccessRate
  const paidToday = kpis.paidToday ?? kpis.paid_today ?? kpis.revenueToday ?? 0
  const failedToday = kpis.failedToday ?? kpis.failed_today ?? kpis.failedPaymentsToday ?? failed.length
  const pending = kpis.pending ?? kpis.pendingPayments ?? kpis.pending_payments ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Payments</h1>
          <p className="mt-1 text-sm text-[#8A867C]">
            Payment health, failed transactions, and gateway events.
          </p>
        </div>
        <Link
          href="/admin/payments/lookup"
          className="rounded-md bg-[#C0392B] px-4 py-2 text-sm font-medium text-white hover:bg-[#A93226]"
        >
          Look up payment
        </Link>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Paid today" value={String(paidToday)} />
        <KpiCard
          label="Success rate"
          value={successRate == null ? '—' : `${Number(successRate).toFixed(1)}%`}
        />
        <KpiCard label="Failed today" value={String(failedToday)} />
        <KpiCard label="Pending" value={String(pending)} />
      </section>

      <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
        <div className="border-b border-[#E8E6E1] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Failed payments</h2>
        </div>
        {failed.length === 0 ? (
          <div className="p-6 text-sm text-[#8A867C]">No recent failed payments.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Restaurant</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {failed.map((row, index) => (
                  <tr key={row.id || `${ref(row)}-${index}`}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/payments/lookup?q=${encodeURIComponent(ref(row))}`}
                        className="font-medium text-[#C0392B] hover:underline"
                      >
                        {ref(row)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[#5C574E]">{restaurantName(row)}</td>
                    <td className="px-4 py-3 text-[#1A1A1A]">{money(row.amount ?? row.total)}</td>
                    <td className="max-w-xs truncate px-4 py-3 text-[#5C574E]">
                      {row.gateway_result_message || row.error || row.status || 'Failed'}
                    </td>
                    <td className="px-4 py-3 text-[#8A867C]">
                      {row.created_at || row.placed_at
                        ? new Date(String(row.created_at || row.placed_at)).toLocaleString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[#E8E6E1] bg-white">
        <div className="border-b border-[#E8E6E1] px-4 py-3">
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Recent payment events</h2>
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-sm text-[#8A867C]">No recent payment events.</div>
        ) : (
          <ul className="divide-y divide-[#EFEDE8]">
            {events.map((event, index) => (
              <li
                key={event.id || `${ref(event)}-${index}`}
                className="flex flex-col justify-between gap-2 px-4 py-3 sm:flex-row sm:items-center"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#1A1A1A]">{ref(event)}</span>
                    <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                      {event.event_type || event.payment_status || event.status || 'event'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-[#8A867C]">{restaurantName(event)}</p>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-[#1A1A1A]">
                    {money(event.amount ?? event.total)}
                  </div>
                  <div className="text-xs text-[#8A867C]">
                    {event.created_at ? new Date(event.created_at).toLocaleString() : '—'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
