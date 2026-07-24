'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronRight, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState, KpiCard } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'
import { cn } from '@/lib/utils'

type PaymentOpsStatus =
  | 'successful'
  | 'failed'
  | 'canceled'
  | 'refunded'
  | 'pending'
  | 'unknown'

type Txn = {
  id: string
  source: 'order' | 'payment_event'
  status: PaymentOpsStatus
  reference: string
  restaurantId: string | null
  restaurantName: string | null
  amount: number
  currency: string
  eventType: string | null
  paymentStatus: string | null
  gatewayCode: string | null
  gatewayMessage: string | null
  reasonNote: string | null
  hasPayload: boolean
  at: string
  href: string
}

type SpendRow = {
  restaurantId: string
  restaurantName: string
  purchasesQty: number
  purchasesAmount: number
  failedQty: number
  failedAmount: number
}

type TimelineItem = {
  id: string
  at: string
  label: string
  detail?: string | null
  status: 'ok' | 'fail' | 'info'
  payload?: unknown
}

type PaymentsPayload = {
  meta?: { rangeDays?: number; statusFilter?: string; since?: string }
  summary?: {
    paidToday?: number
    failedToday?: number
    canceledToday?: number
    successRate?: number | null
  }
  restaurantSpend?: SpendRow[]
  transactions?: Txn[]
  failedTransactions?: Txn[]
}

function money(value: unknown, currency = 'NAD') {
  const amount = Number(value || 0)
  const prefix = currency === 'NAD' || currency === 'N$' ? 'N$' : `${currency} `
  return `${prefix}${amount.toLocaleString('en-NA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function StatusBadge({ status }: { status: PaymentOpsStatus }) {
  const map: Record<PaymentOpsStatus, { label: string; className: string }> = {
    successful: { label: 'Successful', className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    failed: { label: 'Failed', className: 'border-red-200 bg-red-50 text-red-800' },
    canceled: { label: 'Canceled', className: 'border-stone-200 bg-stone-100 text-stone-700' },
    refunded: { label: 'Refunded', className: 'border-sky-200 bg-sky-50 text-sky-800' },
    pending: { label: 'Pending', className: 'border-amber-200 bg-amber-50 text-amber-900' },
    unknown: { label: 'Unknown', className: 'border-[#E8E6E1] bg-white text-[#5C574E]' },
  }
  const m = map[status]
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', m.className)}>
      {m.label}
    </span>
  )
}

function PaymentsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const status = (searchParams.get('status') || 'all').toLowerCase()
  const rangeDays = Number(searchParams.get('rangeDays') || 7) || 7
  const eventId = searchParams.get('eventId') || ''

  const [data, setData] = useState<PaymentsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'inquiry' | 'summary' | 'failed'>('inquiry')
  const [detail, setDetail] = useState<{
    loading: boolean
    error?: string
    timeline?: TimelineItem[]
    title?: string
    subtitle?: string
    raw?: unknown
  } | null>(null)
  const [expandedPayload, setExpandedPayload] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const qs = new URLSearchParams({
        status,
        rangeDays: String(rangeDays),
      })
      const response = await fetch(`/api/platform/payments?${qs}`, {
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
  }, [status, rangeDays])

  const loadDetail = useCallback(async (id: string) => {
    setDetail({ loading: true })
    setExpandedPayload(null)
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('Not signed in')
      const response = await fetch(`/api/platform/payments/events/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load detail')

      if (body.kind === 'order') {
        setDetail({
          loading: false,
          title: String(body.order?.paycloud_merchant_order_no || body.order?.order_number || body.order?.id),
          subtitle: `${body.order?.restaurant_name || 'Restaurant'} · ${body.order?.payment_status}`,
          timeline: body.timeline || [],
          raw: body,
        })
      } else {
        setDetail({
          loading: false,
          title: String(body.event?.business_order_no || body.event?.id),
          subtitle: `${body.event?.restaurant_name || 'Restaurant'} · ${body.event?.event_type}`,
          timeline: body.timeline || [],
          raw: body,
        })
      }
    } catch (cause) {
      setDetail({
        loading: false,
        error: cause instanceof Error ? cause.message : 'Failed to load detail',
      })
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  useEffect(() => {
    if (eventId) void loadDetail(eventId)
    else setDetail(null)
  }, [eventId, loadDetail])

  const setQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key)
      else next.set(key, value)
    }
    router.push(`/admin/payments?${next.toString()}`)
  }

  const transactions = useMemo(() => data?.transactions || [], [data])
  const spend = data?.restaurantSpend || []
  const failed = data?.failedTransactions || transactions.filter((t) => t.status === 'failed')
  const summary = data?.summary || {}

  if (loading && !data) return <p className="text-sm text-[#8A867C]">Loading payment operations…</p>
  if (error && !data) {
    return <EmptyState title="Payments unavailable" body={error} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Payments</h1>
          <p className="mt-1 text-sm text-[#8A867C]">
            Inquiry, restaurant spend, failed transactions, and gateway payloads.
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
        <KpiCard label="Paid today" value={String(summary.paidToday ?? 0)} />
        <KpiCard
          label="Success rate"
          value={summary.successRate == null ? '—' : `${Number(summary.successRate).toFixed(1)}%`}
        />
        <KpiCard label="Failed today" value={String(summary.failedToday ?? 0)} />
        <KpiCard label="Canceled today" value={String(summary.canceledToday ?? 0)} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['inquiry', 'All transactions'],
            ['summary', 'Restaurant spend'],
            ['failed', 'Failed records'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13px] font-medium',
              tab === key ? 'bg-[#1A1A1A] text-white' : 'border border-[#E8E6E1] bg-white text-[#5C574E]',
            )}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          {[7, 30, 90].map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setQuery({ rangeDays: String(days) })}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium',
                rangeDays === days
                  ? 'bg-[#EFEDE8] text-[#1A1A1A]'
                  : 'text-[#8A867C] hover:bg-[#FAFAF8]',
              )}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {tab === 'inquiry' ? (
        <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
          <div className="flex flex-wrap items-center gap-2 border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Transaction inquiry</h2>
            <div className="ml-auto flex flex-wrap gap-1">
              {['all', 'successful', 'failed', 'canceled', 'refunded', 'pending'].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuery({ status: value === 'all' ? null : value })}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize',
                    status === value || (value === 'all' && status === 'all')
                      ? 'bg-[#1A1A1A] text-white'
                      : 'text-[#8A867C] hover:bg-[#FAFAF8]',
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          {transactions.length === 0 ? (
            <div className="p-6 text-sm text-[#8A867C]">No transactions in this range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                  <tr>
                    <th className="px-4 py-3">Reference</th>
                    <th className="px-4 py-3">Restaurant</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EFEDE8]">
                  {transactions.map((txn) => (
                    <tr
                      key={txn.id}
                      className="cursor-pointer hover:bg-[#FAFAF8]"
                      onClick={() => setQuery({ eventId: txn.id })}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-[#1A1A1A]">{txn.reference}</td>
                      <td className="px-4 py-3 text-[#5C574E]">{txn.restaurantName || '—'}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                          {txn.eventType || txn.paymentStatus || txn.source}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={txn.status} />
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {money(txn.amount, txn.currency)}
                      </td>
                      <td className="px-4 py-3 text-[#8A867C]">
                        {txn.at ? new Date(txn.at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="ml-auto h-4 w-4 text-[#C4C0B6]" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'summary' ? (
        <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
          <div className="border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Restaurant spend</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">
              Purchases by restaurant over the selected window (Finatic-style summary).
            </p>
          </div>
          {spend.length === 0 ? (
            <div className="p-6 text-sm text-[#8A867C]">No paid transactions in this range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                  <tr>
                    <th className="px-4 py-3">Restaurant</th>
                    <th className="px-4 py-3 text-right">Purchases qty</th>
                    <th className="px-4 py-3 text-right">Purchases amount</th>
                    <th className="px-4 py-3 text-right">Failed qty</th>
                    <th className="px-4 py-3 text-right">Failed amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EFEDE8]">
                  {spend.map((row) => (
                    <tr key={row.restaurantId} className="hover:bg-[#FAFAF8]">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/restaurants/${row.restaurantId}?tab=payments`}
                          className="font-medium text-[#1A1A1A] hover:underline"
                        >
                          {row.restaurantName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.purchasesQty}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {money(row.purchasesAmount)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-700">{row.failedQty}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-700">
                        {money(row.failedAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'failed' ? (
        <section className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white shadow-[0_1px_2px_rgb(0_0_0_/0.03)]">
          <div className="border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">Failed transaction records</h2>
            <p className="mt-0.5 text-xs text-[#8A867C]">
              Open a row to inspect gateway payloads and the transaction timeline.
            </p>
          </div>
          {failed.length === 0 ? (
            <div className="p-6 text-sm text-[#8A867C]">No failed transactions in this range.</div>
          ) : (
            <ul className="divide-y divide-[#EFEDE8]">
              {failed.map((txn) => (
                <li key={txn.id}>
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-[#FAFAF8]"
                    onClick={() => setQuery({ eventId: txn.id })}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-medium">{txn.reference}</span>
                        <StatusBadge status="failed" />
                        {txn.hasPayload ? (
                          <span className="text-[11px] font-medium text-[#8A867C]">Payload available</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm text-[#5C574E]">{txn.restaurantName || '—'}</p>
                      <p className="mt-0.5 truncate text-xs text-[#8A867C]">
                        {txn.gatewayMessage || txn.reasonNote || txn.gatewayCode || 'No gateway message'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold">{money(txn.amount, txn.currency)}</div>
                      <div className="text-[11px] text-[#8A867C]">
                        {txn.at ? new Date(txn.at).toLocaleString() : '—'}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Transaction logs / payload drawer */}
      {eventId ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setQuery({ eventId: null })}>
          <aside
            className="flex h-full w-full max-w-xl flex-col border-l border-[#E8E6E1] bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#E8E6E1] px-5 py-4">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8A867C]">
                  Transaction logs
                </div>
                <h2 className="mt-1 truncate text-lg font-semibold text-[#1A1A1A]">
                  {detail?.title || 'Loading…'}
                </h2>
                {detail?.subtitle ? (
                  <p className="mt-0.5 text-sm text-[#8A867C]">{detail.subtitle}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-md p-1 text-[#8A867C] hover:bg-[#F4F4F2]"
                onClick={() => setQuery({ eventId: null })}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detail?.loading ? (
                <p className="text-sm text-[#8A867C]">Loading timeline…</p>
              ) : detail?.error ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {detail.error}
                </p>
              ) : (
                <ol className="relative ml-2 space-y-0 border-l border-[#E8E6E1]">
                  {(detail?.timeline || []).map((item) => (
                    <li key={item.id} className="relative pb-5 pl-6 last:pb-0">
                      <span
                        className={cn(
                          'absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white',
                          item.status === 'ok' && 'bg-emerald-500',
                          item.status === 'fail' && 'bg-red-500',
                          item.status === 'info' && 'bg-[#C4C0B6]',
                        )}
                      />
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <time className="font-mono text-[11px] tabular-nums text-[#8A867C]">
                          {new Date(item.at).toLocaleString()}
                        </time>
                        <span className="text-sm font-medium text-[#1A1A1A]">{item.label}</span>
                      </div>
                      {item.detail ? (
                        <p className="mt-0.5 text-[12px] text-[#8A867C]">{item.detail}</p>
                      ) : null}
                      {item.payload != null ? (
                        <div className="mt-2">
                          <button
                            type="button"
                            className="text-[12px] font-medium text-[#C0392B] hover:underline"
                            onClick={() =>
                              setExpandedPayload((cur) => (cur === item.id ? null : item.id))
                            }
                          >
                            {expandedPayload === item.id ? 'Hide payload' : 'View payload'}
                          </button>
                          {expandedPayload === item.id ? (
                            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-[#E8E6E1] bg-[#FAFAF8] p-3 text-[11px] leading-relaxed text-[#1A1A1A]">
                              {JSON.stringify(item.payload, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  )
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-[#8A867C]">Loading payment operations…</p>}>
      <PaymentsPageInner />
    </Suspense>
  )
}
