'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  calendarDateInTimeZone,
  DATE_RANGE_PRESETS,
  describeDateRangeProblem,
  matchesPreset,
  resolveDateRangePreset,
  type DateRangePresetId,
} from '@/lib/reports/date-range-presets'
import { DEFAULT_REPORT_TIMEZONE } from '@/lib/reports/format-report-datetime'
import { REPORTING_PENDING_COPY } from '@/lib/reporting/reporting-copy'

type OrderItem = {
  name?: string
  display_name?: string
  quantity?: number
}

type HistoryOrder = {
  id: string
  order_number?: number | null
  table_number?: number | null
  total?: number | null
  status?: string | null
  payment_method?: string | null
  placed_at?: string | null
  items?: OrderItem[] | null
  memberName?: string
  paymentStatus?: 'paid' | 'partially_refunded' | 'refunded' | null
  refundedAmount?: number
}

type HistoryResponse = {
  orders: HistoryOrder[]
  total: number
  page: number
  pageSize: number
  /** null when the venue has not opened -- the figures are withheld, not zero. */
  totalRevenue: number | null
  totalOrders: number | null
  avgOrderValue: number | null
  preLaunch?: { name: string; reason: string } | null
  error?: string
}

// The rest of this screen already reports in restaurant-local time (see formatPlacedAt),
// and the history API reads the date fields as local calendar days. Deriving "today" from
// toISOString() would be UTC-relative and read as yesterday until 02:00 local.
function todayIso() {
  return calendarDateInTimeZone(new Date(), DEFAULT_REPORT_TIMEZONE)
}

function currency(value: number, symbol: string) {
  return `${symbol}${value.toFixed(2)}`
}

function formatPlacedAt(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  // Match PDF/CSV exports: restaurant local time (Namibia), not raw UTC.
  return date.toLocaleString('en-GB', {
    timeZone: 'Africa/Windhoek',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatItemsSummary(items: unknown) {
  if (!Array.isArray(items) || items.length === 0) return '—'
  return items
    .map((item) => {
      const name = String(item?.display_name || item?.name || 'Item')
      const qty = Number(item?.quantity) || 1
      return qty > 1 ? `${qty}× ${name}` : name
    })
    .join(', ')
}

function formatPaymentMethod(method: string | null | undefined) {
  if (!method) return '—'
  return String(method).replace(/_/g, ' ')
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const normalized = String(status || '').toLowerCase()
  switch (normalized) {
    case 'pending':
      return <Badge variant="destructive">Pending</Badge>
    case 'completed':
      return <Badge variant="secondary">Completed</Badge>
    case 'cancelled':
      return <Badge className="bg-red-100 text-red-800 border-red-200">Cancelled</Badge>
    default:
      return <Badge variant="outline">{status || '—'}</Badge>
  }
}

function PaymentStatusBadge({
  paymentStatus,
}: {
  paymentStatus?: 'paid' | 'partially_refunded' | 'refunded' | null
}) {
  if (paymentStatus === 'refunded') {
    return (
      <Badge className="bg-gray-100 text-gray-700 border-gray-200">Refunded</Badge>
    )
  }
  if (paymentStatus === 'partially_refunded') {
    return (
      <Badge className="bg-amber-50 text-amber-800 border-amber-200">
        Partially Refunded
      </Badge>
    )
  }
  return null
}

export function OrderHistoryContent() {
  const { restaurant, restaurantId, user } = useAuth()
  const currencySymbol = String(restaurant?.currency || 'N$')

  const [startDate, setStartDate] = useState(todayIso)
  const [endDate, setEndDate] = useState(todayIso)
  const [tableNumber, setTableNumber] = useState('')
  const [status, setStatus] = useState('all')
  const [orderNumber, setOrderNumber] = useState('')
  const [page, setPage] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)

  // An end date before the start date makes the API's .gte(start)/.lt(end) window empty, so
  // the screen would report a confident "0 orders" that is indistinguishable from real data.
  // Catch it here and never send the request.
  const rangeProblem = describeDateRangeProblem(startDate, endDate)

  const applyPreset = (preset: DateRangePresetId) => {
    const { startDate: nextStart, endDate: nextEnd } = resolveDateRangePreset(preset, {
      timeZone: DEFAULT_REPORT_TIMEZONE,
    })
    setStartDate(nextStart)
    setEndDate(nextEnd)
    // Bump the nonce so re-picking the preset already in effect still refreshes rather
    // than doing nothing. These updates batch, so a preset click is one fetch, not two.
    setRefreshNonce((n) => n + 1)
  }

  const filterKey = `${startDate}|${endDate}|${tableNumber}|${status}|${orderNumber}`
  const [pageFilterKey, setPageFilterKey] = useState(filterKey)
  if (pageFilterKey !== filterKey) {
    setPageFilterKey(filterKey)
    setPage(1)
  }

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [downloading, setDownloading] = useState<'pdf' | 'csv' | null>(null)
  const [showDownloadMenu, setShowDownloadMenu] = useState(false)
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [emailAddress, setEmailAddress] = useState('')
  const [emailFormat, setEmailFormat] = useState<'pdf' | 'csv'>('pdf')
  const [sendingEmail, setSendingEmail] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    if (!restaurantId) {
      setData(null)
      setLoading(false)
      return
    }

    // Refuse to query an impossible range rather than rendering an empty result as fact.
    if (describeDateRangeProblem(startDate, endDate)) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams({
        restaurantId,
        startDate,
        endDate,
        page: String(page),
      })
      if (tableNumber.trim()) params.set('table', tableNumber.trim())
      if (status) params.set('status', status)
      if (orderNumber.trim()) params.set('orderNumber', orderNumber.trim())

      const res = await fetch(`/api/orders/history?${params.toString()}`)
      const json = (await res.json()) as HistoryResponse
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load order history')
      }
      setData(json)
    } catch (err: unknown) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Failed to load order history')
      setData(null)
    } finally {
      setLoading(false)
    }
    // refreshNonce is deliberately unused in the body: it is the re-fetch trigger for
    // re-picking the preset that is already in effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, startDate, endDate, tableNumber, status, orderNumber, page, refreshNonce])

  const handleDownload = async (format: 'pdf' | 'csv') => {
    // The export route applies the same date window, so an invalid range would produce a
    // silently empty PDF/CSV -- worse than the on-screen version, since it leaves the app.
    if (describeDateRangeProblem(startDate, endDate)) return
    setDownloading(format)
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/orders/history/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          format,
          startDate,
          endDate,
          tableNumber: tableNumber.trim() || undefined,
          status: status !== 'all' ? status : undefined,
        }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error || 'Download failed')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `flashtap-report-${startDate}-to-${endDate}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download failed', err)
    } finally {
      setDownloading(null)
    }
  }

  const sendReportEmail = async (format: 'pdf' | 'csv') => {
    if (!restaurantId || !emailAddress) return
    const problem = describeDateRangeProblem(startDate, endDate)
    if (problem) {
      setEmailError(problem)
      return
    }
    setSendingEmail(true)
    setEmailSent(false)
    setEmailError(null)
    try {
      const token = await getAccessToken()

      const res = await fetch(
        `/api/admin/restaurants/${restaurantId}/reports/email`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            email: emailAddress,
            format,
            startDate,
            endDate,
            tableNumber: tableNumber.trim() || undefined,
            status: status !== 'all' ? status : undefined,
          }),
        }
      )
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        const serverError = typeof json.error === 'string' ? json.error : ''
        throw new Error(serverError || 'Failed to send report')
      }
      setEmailSent(true)
      setTimeout(() => {
        setShowEmailModal(false)
        setEmailSent(false)
        setEmailError(null)
      }, 2000)
    } catch (err) {
      console.error('Email send failed', err)
      setEmailError(err instanceof Error ? err.message : 'Failed to send report')
    } finally {
      setSendingEmail(false)
    }
  }

  const handleSendEmail = async () => {
    await sendReportEmail(emailFormat)
  }

  const openEmailModal = () => {
    setEmailError(null)
    setEmailSent(false)
    setEmailFormat('pdf')
    setShowEmailModal(true)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadHistory()
  }, [loadHistory])

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div className="min-h-screen bg-[#F7F6F3]">
      <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Order History</h1>
            <p className="mt-1 text-sm text-[#6B675F]">Browse and filter past orders for your venue.</p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEmailAddress(user?.email ?? '')
                openEmailModal()
              }}
              disabled={rangeProblem !== null}
              className="border-[#E9E9E7]"
            >
              Send by Email
            </Button>
            <div className="relative">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDownloadMenu((prev) => !prev)}
                disabled={downloading !== null || rangeProblem !== null}
                className="border-[#E9E9E7]"
              >
                {downloading ? 'Downloading...' : 'Download'}
              </Button>
              {showDownloadMenu && (
                <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-gray-200 bg-white shadow-lg">
                  <button
                    type="button"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-50"
                    onClick={() => {
                      setShowDownloadMenu(false)
                      void handleDownload('csv')
                    }}
                  >
                    Download CSV
                  </button>
                  <button
                    type="button"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-50"
                    onClick={() => {
                      setShowDownloadMenu(false)
                      void handleDownload('pdf')
                    }}
                  >
                    Download PDF
                  </button>
                </div>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadHistory()}
              disabled={loading}
              className="border-[#E9E9E7]"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-medium text-[#6B675F]">Quick select</span>
            {DATE_RANGE_PRESETS.map((preset) => {
              const active = matchesPreset({ startDate, endDate }, preset.id, {
                timeZone: DEFAULT_REPORT_TIMEZONE,
              })
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyPreset(preset.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-[#2E75B6] bg-[#EBF3FB] text-[#2E75B6]'
                      : 'border-[#E9E9E7] text-[#6B675F] hover:bg-gray-50'
                  }`}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Start date</label>
              <Input
                type="date"
                value={startDate}
                max={endDate || undefined}
                onChange={(e) => setStartDate(e.target.value)}
                aria-invalid={rangeProblem ? true : undefined}
                className={`border-[#E9E9E7] ${rangeProblem ? 'border-amber-400' : ''}`}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">End date</label>
              <Input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                aria-invalid={rangeProblem ? true : undefined}
                className={`border-[#E9E9E7] ${rangeProblem ? 'border-amber-400' : ''}`}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Table (optional)</label>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 5"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Status</label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-full border-[#E9E9E7]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[#6B675F]">Order #</label>
              <Input
                type="number"
                min={1}
                placeholder="Search order number"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
          </div>

          {rangeProblem && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <span>{rangeProblem}</span>
              {endDate && startDate && endDate < startDate && (
                <button
                  type="button"
                  onClick={() => {
                    setStartDate(endDate)
                    setEndDate(startDate)
                  }}
                  className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Swap dates
                </button>
              )}
            </div>
          )}
        </div>

        {rangeProblem ? (
          // Deliberately not the zeroed stat cards and "No orders found" table: an
          // unanswerable filter must not be presented as a real result of zero orders.
          <div className="rounded-2xl border border-[#E9E9E7] bg-white p-10 text-center">
            <p className="text-sm font-medium text-[#37352F]">Nothing to show yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-[#6B675F]">{rangeProblem}</p>
          </div>
        ) : loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl border border-[#E9E9E7] bg-white" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800">{error}</div>
        ) : (
          <>
            {/*
              A venue that has not opened reports test data, not trade. Ruled 2026-08-21.

              WITHHELD, NOT ZEROED, and that distinction is the whole point. Rendering
              `currency(0)` in the same three cards would be indistinguishable from a venue that
              genuinely took nothing all week -- a plausible, well-formatted, wrong number, which is
              the failure shape this codebase keeps paying for. The cards are replaced outright so
              there is no figure to misread.

              THE ORDERS THEMSELVES ARE UNTOUCHED. The table below still lists every row, so nothing
              is hidden from inspection -- only the roll-up is suppressed. No financial record was
              altered to produce this, and deleting the PRE_LAUNCH_RESTAURANTS entry brings every
              figure back.
            */}
            {data?.preLaunch ? (
              <div className="rounded-2xl border border-[#E9E9E7] bg-[#FAFAF8] p-5">
                <p className="text-sm font-medium text-[#37352F]">
                  {REPORTING_PENDING_COPY.preLaunchTitle}
                </p>
                <p className="mt-1 text-xs text-[#6B675F]">
                  {REPORTING_PENDING_COPY.preLaunchBody}
                </p>
              </div>
            ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Revenue</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(data?.totalRevenue || 0, currencySymbol)}
                </p>
                <p className="mt-1 text-xs text-[#8A867E]">Paid orders in range</p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Total Orders</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">{data?.totalOrders || 0}</p>
              </div>
              <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
                <p className="text-sm text-[#6B675F]">Average Order Value</p>
                <p className="mt-2 text-3xl font-semibold text-[#37352F]">
                  {currency(data?.avgOrderValue || 0, currencySymbol)}
                </p>
              </div>
            </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-[#E9E9E7] bg-white">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-[#E9E9E7] bg-[#FAFAF8] text-xs uppercase tracking-wide text-[#6B675F]">
                    <tr>
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Order #</th>
                      <th className="px-4 py-3 font-medium">Table</th>
                      <th className="px-4 py-3 font-medium">Member</th>
                      <th className="px-4 py-3 font-medium">Items</th>
                      <th className="px-4 py-3 font-medium">Total</th>
                      <th className="px-4 py-3 font-medium">Payment</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.orders || []).length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-12 text-center text-[#6B675F]">
                          No orders found for the selected filters.
                        </td>
                      </tr>
                    ) : (
                      (data?.orders || []).map((order) => (
                        <tr key={order.id} className="border-b border-[#F1F0EC] last:border-0">
                          <td className="px-4 py-3 whitespace-nowrap text-[#37352F]">
                            {formatPlacedAt(order.placed_at)}
                          </td>
                          <td className="px-4 py-3 font-medium text-[#37352F]">
                            #{order.order_number ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-[#37352F]">{order.table_number ?? '—'}</td>
                          <td className="px-4 py-3 text-[#37352F]">{order.memberName || '—'}</td>
                          <td className="max-w-xs px-4 py-3 text-[#6B675F]">
                            <span className="line-clamp-2">{formatItemsSummary(order.items)}</span>
                          </td>
                          <td className="px-4 py-3 font-medium text-[#37352F]">
                            <div>{currency(Number(order.total) || 0, currencySymbol)}</div>
                            {Number(order.refundedAmount) > 0 && (
                              <div className="mt-0.5 text-xs font-normal text-[#8A867E]">
                                -{currency(Number(order.refundedAmount), currencySymbol)} refunded
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 capitalize text-[#37352F]">
                            {formatPaymentMethod(order.payment_method)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge status={order.status} />
                              <PaymentStatusBadge paymentStatus={order.paymentStatus} />
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-[#E9E9E7] px-4 py-3">
                <p className="text-sm text-[#6B675F]">
                  Page {data?.page || 1} of {totalPages}
                  {data?.total ? ` · ${data.total} order${data.total === 1 ? '' : 's'}` : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="border-[#E9E9E7]"
                  >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                    className="border-[#E9E9E7]"
                  >
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {showEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-[#37352F]">Send Report by Email</h2>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium text-[#37352F]">Email address</label>
              <input
                type="email"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                className="w-full rounded-md border border-[#E9E9E7] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]"
                placeholder="recipient@example.com"
              />
            </div>

            <div className="mb-6">
              <label className="mb-1 block text-sm font-medium text-[#37352F]">Format</label>
              <div className="flex gap-3">
                {(['csv', 'pdf'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    disabled={sendingEmail}
                    onClick={() => setEmailFormat(fmt)}
                    className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${
                      emailFormat === fmt
                        ? 'border-[#2E75B6] bg-[#EBF3FB] text-[#2E75B6]'
                        : 'border-[#E9E9E7] text-[#6B675F] hover:bg-gray-50'
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {emailError && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p>{emailError}</p>
              </div>
            )}

            {emailSent && (
              <p className="mb-4 text-sm font-medium text-green-600">Report sent successfully.</p>
            )}

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowEmailModal(false)}
                disabled={sendingEmail}
                className="border-[#E9E9E7]"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSendEmail()}
                disabled={sendingEmail || !emailAddress}
              >
                {sendingEmail ? 'Sending...' : 'Send Report'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
