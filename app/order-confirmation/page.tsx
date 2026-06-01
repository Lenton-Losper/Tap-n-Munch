'use client'

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/supabase/restaurants'
import { getCurrentSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'

type OrderDoc = {
  id: string
  order_number?: number
  table_number?: number
  session_id?: string
  payment_status?: string
  payment_method?: string
  items?: Array<{
    name?: string
    quantity?: number
    subtotal?: number
  }>
  subtotal?: number
  tax?: number
  total?: number
  placed_at?: unknown
  created_at?: unknown
  paycloud_merchant_order_no?: string
}

const SESSION_STORAGE_KEY = 'flashtap_session_v1'

/** Prefer tab sessionStorage, then the same id from localStorage (see lib/session.ts). */
function getSessionIdForReceiptFallback(): string | null {
  if (typeof window === 'undefined') return null
  const fromSession = sessionStorage.getItem(SESSION_STORAGE_KEY)?.trim()
  if (fromSession) return fromSession
  return getCurrentSession()
}

const RECEIPT_FALLBACK_WINDOW_MS = 30 * 60 * 1000

/** Auto-redirect from paid receipt to menu; fixed delay — not derived from order fields. */
const REDIRECT_DELAY = 10

function isPaidOrCardOrder(o: OrderDoc): boolean {
  const paid = o.payment_status === 'paid'
  const card = o.payment_method === 'card'
  return paid || card
}

/**
 * When the return URL has no tn/orderId: find the latest order for this browser session
 * that looks paid (or card) and was placed within the last 30 minutes.
 */
async function resolveRecentPaidOrderBySession(
  restaurantId: string,
  sessionId: string
): Promise<{ rows: OrderDoc[]; restaurantId: string }> {
  if (!restaurantId.trim() || !sessionId.trim()) {
    return { rows: [], restaurantId }
  }

  const cutoff = Date.now() - RECEIPT_FALLBACK_WINDOW_MS
  const { data } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('session_id', sessionId)
    .order('placed_at', { ascending: false })
    .limit(80)
  const candidates = (data || []).map((r) => mapSupabaseRowToOrderDoc(r as Record<string, unknown>))

  const recent = candidates.filter((o) => {
    if (!isPaidOrCardOrder(o)) return false
    const ms = placedAtMillis(o.placed_at ?? o.created_at)
    return ms >= cutoff
  })

  recent.sort(
    (a, b) =>
      placedAtMillis(b.placed_at ?? b.created_at) -
      placedAtMillis(a.placed_at ?? a.created_at)
  )

  if (recent.length === 0) return { rows: [], restaurantId }
  return { rows: [recent[0]], restaurantId }
}

function placedAtMillis(v: unknown): number {
  if (v && typeof v === 'object' && 'toMillis' in v && typeof (v as { toMillis: () => number }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis()
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

function formatWhen(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    const d = (v as { toDate: () => Date }).toDate()
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toLocaleString()
  }
  if (typeof v === 'object' && v !== null && 'seconds' in v) {
    const sec = Number((v as { seconds: number }).seconds)
    if (Number.isFinite(sec)) return new Date(sec * 1000).toLocaleString()
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '—' : v.toLocaleString()
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }
  return '—'
}

type ReceiptView = OrderDoc & { merged?: boolean; orderDisplay?: string }

/**
 * Finatic PayCloud return redirect usually appends `?tn=<merchant_order_no>` (see checkout URL `tn=`).
 * Also accept aliases some gateways use.
 */
function getFinaticReturnOrderRef(searchParams: URLSearchParams): string {
  const keys = [
    'tn',
    'merchant_order_no',
    'merchantOrderNo',
    'out_trade_no',
    'outTradeNo',
    'order_id',
    'orderId',
  ] as const
  for (const key of keys) {
    const v = searchParams.get(key)?.trim()
    if (v) return v
  }
  return ''
}

function supabaseOrPaymentRef(tn: string): string {
  return `paycloud_merchant_order_no.eq.${tn},payment_reference.eq.${tn}`
}

function combinePaymentStatusFromRows(
  rows: { payment_status?: string | null }[]
): 'paid' | 'cancelled' | 'pending' {
  const s = rows.map((r) => String(r.payment_status || '').toLowerCase())
  if (s.some((x) => x === 'paid')) return 'paid'
  if (s.some((x) => x === 'cancelled' || x === 'failed')) return 'cancelled'
  return 'pending'
}

function inferCancelledFromSearchParams(searchParams: URLSearchParams): boolean {
  const keys = ['trade_status', 'status', 'payment_status', 'result', 'msg', 'resp_msg']
  const blob = keys.map((k) => searchParams.get(k) || '').join(' ').toLowerCase()
  return /cancel|cancelled|fail|failed|closed|void|declin|user.?abort/.test(blob)
}

function mapSupabaseRowToOrderDoc(row: Record<string, unknown>): OrderDoc {
  return {
    id: String(row.id ?? ''),
    order_number:
      typeof row.order_number === 'number' ? row.order_number : Number(row.order_number) || undefined,
    table_number:
      typeof row.table_number === 'number' ? row.table_number : Number(row.table_number) || undefined,
    session_id: typeof row.session_id === 'string' ? row.session_id : undefined,
    payment_status: typeof row.payment_status === 'string' ? row.payment_status : undefined,
    payment_method: typeof row.payment_method === 'string' ? row.payment_method : undefined,
    items: Array.isArray(row.items) ? (row.items as OrderDoc['items']) : [],
    subtotal: Number(row.subtotal) || 0,
    tax: Number(row.tax) || 0,
    total: Number(row.total) || 0,
    placed_at: row.placed_at,
    created_at: row.created_at,
    paycloud_merchant_order_no:
      typeof row.paycloud_merchant_order_no === 'string' ? row.paycloud_merchant_order_no : undefined,
  }
}

function aggregateOrders(rows: OrderDoc[]): ReceiptView {
  if (rows.length === 0) return { id: '', items: [], subtotal: 0, tax: 0, total: 0 }
  if (rows.length === 1) {
    const o = rows[0]
    const od =
      typeof o.order_number === 'number'
        ? `#${o.order_number}`
        : o.id
          ? o.id.slice(-8).toUpperCase()
          : '—'
    return { ...o, merged: false, orderDisplay: od }
  }
  const items = rows.flatMap((o) => (Array.isArray(o.items) ? o.items : []))
  const subtotal = rows.reduce((s, o) => s + (Number(o.subtotal) || 0), 0)
  const tax = rows.reduce((s, o) => s + (Number(o.tax) || 0), 0)
  const total = rows.reduce((s, o) => s + (Number(o.total) || 0), 0)
  let bestPlaced: unknown = rows[0]?.placed_at ?? rows[0]?.created_at
  let bestMs = placedAtMillis(bestPlaced)
  for (const o of rows) {
    const p = o.placed_at ?? o.created_at
    const ms = placedAtMillis(p)
    if (ms > bestMs) {
      bestMs = ms
      bestPlaced = p
    }
  }
  const nums = rows
    .map((o) => o.order_number)
    .filter((n): n is number => typeof n === 'number')
  const uniqueNums = [...new Set(nums)].sort((a, b) => a - b)
  const orderDisplay =
    uniqueNums.length > 0
      ? uniqueNums.map((n) => `#${n}`).join(', ')
      : `${rows.length} orders`
  return {
    id: rows.map((r) => r.id).join(','),
    table_number: rows[0]?.table_number,
    items,
    subtotal,
    tax,
    total,
    placed_at: bestPlaced,
    merged: true,
    orderDisplay,
  }
}

function applyReceiptPaymentState(
  rows: OrderDoc[],
  combined: 'paid' | 'cancelled' | 'pending',
  urlCancel: boolean
): ReceiptView {
  let effective: 'paid' | 'cancelled' | 'pending' = combined
  if (urlCancel && combined !== 'paid') effective = 'cancelled'
  const agg = aggregateOrders(rows)
  return {
    ...agg,
    payment_status: effective === 'paid' ? 'paid' : effective,
  }
}

async function resolveOrdersByTn(
  tn: string,
  restaurantIdHint: string | null
): Promise<{ rows: OrderDoc[]; restaurantId: string | null }> {
  if (!tn.trim()) return { rows: [], restaurantId: restaurantIdHint }

  const rid = restaurantIdHint?.trim() || null

  let query = supabase.from('orders').select('*').or(supabaseOrPaymentRef(tn)).limit(15)
  if (rid) query = query.eq('restaurant_id', rid)
  const { data } = await query
  if (data && data.length > 0) {
    const mapped = data.map((r) => mapSupabaseRowToOrderDoc(r as Record<string, unknown>))
    const first = data[0] as { restaurant_id?: string | null }
    return { rows: mapped, restaurantId: String(first.restaurant_id || rid || '') || null }
  }

  return { rows: [], restaurantId: rid }
}

function OrderConfirmationContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const orderRef = useMemo(
    () => getFinaticReturnOrderRef(searchParams),
    [searchParams.toString()]
  )
  const restaurantIdParam = searchParams.get('restaurantId')?.trim() || ''

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  /** Why the receipt is missing (for copy when notFound). */
  const [notFoundReason, setNotFoundReason] = useState<
    'tn-miss' | 'no-context' | 'fallback-empty' | null
  >(null)
  const [restaurant, setRestaurant] = useState<{ name?: string; currency?: string } | null>(null)
  const [resolvedRestaurantId, setResolvedRestaurantId] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ReceiptView | null>(null)
  const [dataSource, setDataSource] = useState<'supabase' | null>(null)
  const [confirmingPayment, setConfirmingPayment] = useState(false)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const hint =
        restaurantIdParam ||
        searchParams.get('rid')?.trim() ||
        (typeof window !== 'undefined' ? localStorage.getItem('current_restaurant_id') : null)

      try {
        if (orderRef) {
          const urlCancel = inferCancelledFromSearchParams(searchParams)

          const { data: sbRows, error: sbErr } = await supabase
            .from('orders')
            .select('*')
            .or(supabaseOrPaymentRef(orderRef))
          if (cancelled) return

          if (!sbErr && sbRows && sbRows.length > 0) {
            setDataSource('supabase')
            const docs = sbRows.map((r) => mapSupabaseRowToOrderDoc(r as Record<string, unknown>))
            const combined = combinePaymentStatusFromRows(sbRows)
            const merged = applyReceiptPaymentState(docs, combined, urlCancel)
            const firstRow = sbRows[0] as { restaurant_id?: string | null }
            setResolvedRestaurantId(String(firstRow.restaurant_id || hint || ''))
            setReceipt(merged)
            setNotFound(false)
            setNotFoundReason(null)
            if (merged.payment_status === 'paid') setPaymentConfirmed(true)
            if (!cancelled) setLoading(false)
            return
          }

          const { rows, restaurantId: ridFromFetch } = await resolveOrdersByTn(orderRef, hint)
          if (cancelled) return

          if (rows.length === 0) {
            setNotFound(true)
            setNotFoundReason('tn-miss')
            setReceipt(null)
            setResolvedRestaurantId(hint)
            if (!cancelled) setLoading(false)
            return
          }

          const combinedFs = combinePaymentStatusFromRows(rows)
          const mergedFs = applyReceiptPaymentState(rows, combinedFs, urlCancel)
          setResolvedRestaurantId(ridFromFetch || hint)
          setReceipt(mergedFs)
          setNotFound(false)
          setNotFoundReason(null)
          if (mergedFs.payment_status === 'paid') setPaymentConfirmed(true)
          if (!cancelled) setLoading(false)
          return
        }

        // No tn / orderId: fall back to restaurant + session (sessionStorage, then localStorage)
        const rid = hint?.trim() || ''
        const sessionId = getSessionIdForReceiptFallback()?.trim() || ''

        if (!rid || !sessionId) {
          if (!cancelled) {
            setNotFound(true)
            setNotFoundReason('no-context')
            setReceipt(null)
            setResolvedRestaurantId(rid || null)
          }
          return
        }

        const { rows, restaurantId: ridOut } = await resolveRecentPaidOrderBySession(rid, sessionId)
        if (cancelled) return

        if (rows.length === 0) {
          setNotFound(true)
          setNotFoundReason('fallback-empty')
          setReceipt(null)
          setResolvedRestaurantId(ridOut)
          setLoading(false)
          return
        }

        setDataSource('supabase')
        setResolvedRestaurantId(ridOut)
        setReceipt(aggregateOrders(rows))
        setNotFound(false)
        setNotFoundReason(null)
      } catch (e) {
        console.error('[order-confirmation] load failed', e)
        if (!cancelled) {
          setNotFound(true)
          setNotFoundReason(orderRef ? 'tn-miss' : 'fallback-empty')
          setReceipt(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [orderRef, restaurantIdParam, searchParams.toString()])

  useEffect(() => {
    const rid = resolvedRestaurantId || restaurantIdParam
    if (!rid) return
    getRestaurant(rid)
      .then((r) => setRestaurant(r))
      .catch(() => setRestaurant(null))
  }, [resolvedRestaurantId, restaurantIdParam])

  useEffect(() => {
    if (receipt?.payment_status === 'paid') {
      setPaymentConfirmed(true)
    }
  }, [receipt?.payment_status])

  useEffect(() => {
    if (!orderRef || paymentConfirmed) return
    if (dataSource !== 'supabase') return
    const ps = String(receipt?.payment_status || '').toLowerCase()
    if (ps === 'paid' || ps === 'cancelled' || ps === 'failed') return

    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      const { data } = await supabase.from('orders').select('*').or(supabaseOrPaymentRef(orderRef))
      if (!data?.length) return
      const combined = combinePaymentStatusFromRows(data)
      const urlCancel = inferCancelledFromSearchParams(searchParams)
      const docs = data.map((r) => mapSupabaseRowToOrderDoc(r as Record<string, unknown>))
      const merged = applyReceiptPaymentState(docs, combined, urlCancel)
      setReceipt(merged)
      if (merged.payment_status === 'paid') setPaymentConfirmed(true)
    }
    const id = setInterval(() => void tick(), 5000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [orderRef, dataSource, receipt?.payment_status, paymentConfirmed, searchParams.toString()])

  const currency = restaurant?.currency || 'N$'

  const goBackToMenu = () => {
    if (typeof window === 'undefined') return
    const restaurantId =
      resolvedRestaurantId || restaurantIdParam || localStorage.getItem('current_restaurant_id')
    const tableFromSession = sessionStorage.getItem('flashtap_return_table')
    const table = tableFromSession || ''
    if (restaurantId && table) {
      router.push(`/menu/${restaurantId}/v2?table=${encodeURIComponent(table)}`)
      return
    }
    if (restaurantId) {
      router.push(`/menu/${restaurantId}/v2`)
      return
    }
    router.push('/menu')
  }

  const displayOrderNumber = useMemo(() => {
    if (!receipt) return null
    if (receipt.orderDisplay) return receipt.orderDisplay
    if (typeof receipt.order_number === 'number') return `#${receipt.order_number}`
    return receipt.id ? receipt.id.slice(-8).toUpperCase() : null
  }, [receipt])

  const screenStatus = useMemo(() => {
    if (!receipt) return null
    const ps = String(receipt.payment_status || '').toLowerCase()
    if (ps === 'paid' || paymentConfirmed) return 'success' as const
    if (ps === 'cancelled' || ps === 'failed') return 'cancelled' as const
    return 'pending' as const
  }, [receipt, paymentConfirmed])

  const ridForLinks =
    searchParams.get('rid')?.trim() ||
    restaurantIdParam ||
    resolvedRestaurantId ||
    ''
  const tableForLinks =
    searchParams.get('table')?.trim() ||
    (typeof receipt?.table_number === 'number' && receipt.table_number > 0
      ? String(receipt.table_number)
      : '') ||
    (typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_return_table')?.trim() || '' : '')

  useEffect(() => {
    if (screenStatus !== 'success') return
    const restaurantId =
      resolvedRestaurantId?.trim() ||
      restaurantIdParam?.trim() ||
      (typeof window !== 'undefined' ? localStorage.getItem('current_restaurant_id')?.trim() : '') ||
      ''
    if (!restaurantId) return

    const tableNumber = tableForLinks.trim()
    const timer = setTimeout(() => {
      if (tableNumber) {
        router.push(`/menu/${restaurantId}/v2?table=${encodeURIComponent(tableNumber)}`)
      } else {
        router.push(`/menu/${restaurantId}/v2`)
      }
    }, REDIRECT_DELAY * 1000)

    return () => clearTimeout(timer)
  }, [screenStatus, resolvedRestaurantId, restaurantIdParam, tableForLinks, router])

  const shouldShowConfirmPayment = receipt?.payment_status === 'pending' && !paymentConfirmed

  const confirmPayment = async () => {
    if (!receipt || !shouldShowConfirmPayment || confirmingPayment) return
    const restaurantId = resolvedRestaurantId || restaurantIdParam
    if (!restaurantId) return

    const orderIds = String(receipt.id || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)

    if (orderIds.length === 0) return

    setConfirmingPayment(true)
    try {
      await Promise.all(orderIds.map((orderId) =>
        (supabase as any)
          .from('orders')
          .update({
            payment_status: 'paid',
            payment_confirmed_by: 'customer',
            payment_confirmed_at: new Date().toISOString(),
          } as any)
          .eq('id', orderId)
          .eq('restaurant_id', restaurantId)
      ))
      setPaymentConfirmed(true)
      setReceipt((prev) => (prev ? { ...prev, payment_status: 'paid' } : prev))
    } catch (error) {
      console.error('[order-confirmation] payment confirm failed', error)
    } finally {
      setConfirmingPayment(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto rounded-full" />
          <p className="mt-6 text-muted-foreground font-sans text-sm">Loading receipt…</p>
        </div>
      </div>
    )
  }

  if (notFound || !receipt) {
    const noContext = !orderRef && notFoundReason === 'no-context'
    const fallbackEmpty = !orderRef && notFoundReason === 'fallback-empty'
    const tnMiss = orderRef && notFoundReason === 'tn-miss'
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-10 text-center space-y-6">
          <AlertCircle className="w-16 h-16 text-destructive mx-auto stroke-[1.5]" aria-hidden />
          <h1 className="text-2xl font-serif font-bold text-foreground">
            {tnMiss ? 'Order not found' : 'Unable to show receipt'}
          </h1>
          {noContext ? (
            <p className="text-muted-foreground font-sans text-sm">
              No payment reference in the link (expected <code className="text-xs">tn</code> or{' '}
              <code className="text-xs">orderId</code> from the gateway). We couldn&apos;t match your
              session — open the menu from your table QR so this device has the restaurant and session,
              then open this page again.
            </p>
          ) : fallbackEmpty ? (
            <p className="text-muted-foreground font-sans text-sm">
              We couldn&apos;t find a recent paid or card order for this session from the last 30
              minutes. If you just paid, use the return link from your payment provider or check My
              orders from the menu.
            </p>
          ) : tnMiss ? (
            <p className="text-muted-foreground font-sans text-sm">
              We couldn&apos;t find an order for this payment reference. If you completed payment, wait
              a moment and refresh, or contact the restaurant.
            </p>
          ) : (
            <p className="text-muted-foreground font-sans text-sm">
              Something went wrong loading your receipt. Please go back to the menu and try again.
            </p>
          )}
          {orderRef ? (
            <p className="text-foreground font-sans text-xs break-all text-left bg-muted/50 border border-border p-3">
              Reference: <span className="font-semibold">{orderRef}</span>
            </p>
          ) : null}
          <Button
            type="button"
            onClick={goBackToMenu}
            className="w-full bg-foreground text-background hover:bg-foreground/90 py-6 font-semibold font-sans"
          >
            Back to menu
          </Button>
        </div>
      </div>
    )
  }

  if (screenStatus === 'cancelled') {
    const tryAgainHref =
      ridForLinks && tableForLinks
        ? `/menu/${encodeURIComponent(ridForLinks)}/receipt?table=${encodeURIComponent(tableForLinks)}`
        : ridForLinks
          ? `/menu/${encodeURIComponent(ridForLinks)}/receipt`
          : '/menu'
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center p-8">
          <div className="w-16 h-16 rounded-full border-2 border-red-500 flex items-center justify-center mx-auto mb-4">
            <span className="text-red-500 text-2xl" aria-hidden>
              ✕
            </span>
          </div>
          <h1 className="text-2xl font-bold mb-2 text-foreground">Payment Cancelled</h1>
          <p className="text-muted-foreground mb-6 font-sans text-sm">
            Your payment was not completed. Your order is still open.
          </p>
          <Link
            href={tryAgainHref}
            className="block bg-foreground text-background py-4 rounded-xl text-center font-semibold font-sans hover:bg-foreground/90"
          >
            Try Again
          </Link>
          <Button type="button" variant="ghost" className="w-full mt-4 font-sans" onClick={goBackToMenu}>
            Back to menu
          </Button>
        </div>
      </div>
    )
  }

  if (screenStatus === 'pending') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center p-8">
          <div className="w-16 h-16 rounded-full border-2 border-yellow-500 flex items-center justify-center mx-auto mb-4 animate-spin text-2xl">
            ⏳
          </div>
          <h1 className="text-2xl font-bold mb-2 text-foreground">Payment Processing</h1>
          <p className="text-muted-foreground mb-6 font-sans text-sm">
            Your payment is being confirmed. Please wait…
          </p>
          {ridForLinks && tableForLinks ? (
            <p className="text-xs text-muted-foreground font-sans">
              Table {tableForLinks}
              {displayOrderNumber ? ` · Order ${displayOrderNumber}` : ''}
            </p>
          ) : null}
          <Button type="button" variant="outline" className="w-full mt-8 font-sans" onClick={goBackToMenu}>
            Back to menu
          </Button>
        </div>
      </div>
    )
  }

  const subtotal = Number(receipt.subtotal) || 0
  const tax = Number(receipt.tax) || 0
  const total = Number(receipt.total) || 0
  const tableNum = receipt.table_number
  const when = formatWhen(receipt.placed_at ?? receipt.created_at)

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-lg mx-auto p-6 pb-12">
        <div className="bg-card border border-border overflow-hidden">
          <div className="bg-muted/40 border-b border-border px-6 py-8 text-center">
            <CheckCircle2
              className="w-14 h-14 text-green-600 mx-auto mb-4 stroke-[1.5]"
              aria-hidden
            />
            <h1 className="text-2xl sm:text-3xl font-serif font-bold text-foreground">
              Payment Successful
            </h1>
            {restaurant?.name ? (
              <p className="mt-2 text-muted-foreground font-sans text-sm">{restaurant.name}</p>
            ) : null}
          </div>

          <div className="px-6 py-6 space-y-6 font-sans">
            <div className="grid gap-2 text-sm border-b border-border pb-6">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Order number</span>
                <span className="font-semibold text-foreground">{displayOrderNumber || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Table</span>
                <span className="font-semibold text-foreground">
                  {tableNum != null && tableNum > 0 ? String(tableNum) : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Date &amp; time</span>
                <span className="font-medium text-foreground text-right">{when}</span>
              </div>
            </div>

            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Items
              </h2>
              {receipt.items && receipt.items.length > 0 ? (
                <ul className="space-y-3">
                  {receipt.items.map((item, idx) => (
                    <li key={idx} className="flex justify-between gap-4 text-sm">
                      <span className="text-foreground">
                        <span className="text-muted-foreground">{item.quantity ?? 1}×</span>{' '}
                        {item.name || 'Item'}
                      </span>
                      <span className="font-semibold text-foreground shrink-0">
                        {currency}
                        {(Number(item.subtotal) || 0).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No line items on file.</p>
              )}
            </div>

            <div className="border-t border-border pt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="text-foreground">
                  {currency}
                  {subtotal.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span className="text-foreground">
                  {currency}
                  {tax.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-base font-bold pt-2 border-t border-border">
                <span className="text-foreground">Total paid</span>
                <span className="text-foreground">
                  {currency}
                  {total.toFixed(2)}
                </span>
              </div>
            </div>

            {shouldShowConfirmPayment ? (
              <Button
                type="button"
                onClick={confirmPayment}
                disabled={confirmingPayment}
                className="w-full bg-green-600 text-white hover:bg-green-700 py-6 font-semibold font-sans text-base"
              >
                {confirmingPayment ? 'Confirming...' : 'Confirm Payment'}
              </Button>
            ) : paymentConfirmed ? (
              <div className="w-full border border-green-200 bg-green-50 text-green-700 py-4 px-4 flex items-center justify-center gap-2 font-semibold">
                <CheckCircle2 className="w-5 h-5" aria-hidden />
                <span>Payment Confirmed</span>
              </div>
            ) : null}

            <p className="text-sm text-muted-foreground text-center bg-muted/50 border border-border px-4 py-3 rounded-none">
              Show this to your waiter if needed
            </p>
          </div>
        </div>

        <Button
          type="button"
          onClick={goBackToMenu}
          className="w-full mt-6 bg-foreground text-background hover:bg-foreground/90 py-6 font-semibold font-sans text-base"
        >
          Back to menu
        </Button>
      </div>
    </div>
  )
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin rounded-full" />
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  )
}
