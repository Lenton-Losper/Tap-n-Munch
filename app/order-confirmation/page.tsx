'use client'

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { orderPath, ordersPath } from '@/lib/firebase/paths'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getCurrentSession } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { CheckCircle2 } from 'lucide-react'

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
  if (!db || !restaurantId.trim() || !sessionId.trim()) {
    return { rows: [], restaurantId }
  }

  const cutoff = Date.now() - RECEIPT_FALLBACK_WINDOW_MS
  let snap

  try {
    const q = query(
      collection(db, ordersPath(restaurantId)),
      where('session_id', '==', sessionId),
      orderBy('placed_at', 'desc'),
      limit(40)
    )
    snap = await getDocs(q)
  } catch {
    const q2 = query(
      collection(db, ordersPath(restaurantId)),
      where('session_id', '==', sessionId),
      limit(80)
    )
    snap = await getDocs(q2)
  }

  const candidates = snap.docs.map(
    (d) => ({ id: d.id, ...d.data() } as OrderDoc)
  )

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

async function resolveOrdersByTn(
  tn: string,
  restaurantIdHint: string | null
): Promise<{ rows: OrderDoc[]; restaurantId: string | null }> {
  if (!db || !tn.trim()) return { rows: [], restaurantId: restaurantIdHint }

  const rid = restaurantIdHint?.trim() || null

  if (rid) {
    const direct = await getDoc(doc(db, orderPath(rid, tn)))
    if (direct.exists()) {
      return {
        rows: [{ id: direct.id, ...(direct.data() as Record<string, unknown>) } as OrderDoc],
        restaurantId: rid,
      }
    }

    const byPaycloud = query(
      collection(db, ordersPath(rid)),
      where('paycloud_merchant_order_no', '==', tn),
      limit(15)
    )
    const snap = await getDocs(byPaycloud)
    if (!snap.empty) {
      return {
        rows: snap.docs.map((d) => ({ id: d.id, ...d.data() } as OrderDoc)),
        restaurantId: rid,
      }
    }
  }

  const groupQ = query(collectionGroup(db, 'orders'), where('paycloud_merchant_order_no', '==', tn), limit(15))
  const groupSnap = await getDocs(groupQ)
  if (!groupSnap.empty) {
    const parent = groupSnap.docs[0].ref.parent.parent
    const restId = parent?.id ?? null
    return {
      rows: groupSnap.docs.map((d) => ({ id: d.id, ...d.data() } as OrderDoc)),
      restaurantId: restId,
    }
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

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (!db) {
        setLoading(false)
        setNotFound(true)
        setNotFoundReason(orderRef ? 'tn-miss' : 'no-context')
        setReceipt(null)
        return
      }

      const hint =
        restaurantIdParam ||
        (typeof window !== 'undefined' ? localStorage.getItem('current_restaurant_id') : null)

      try {
        if (orderRef) {
          const { rows, restaurantId: ridFromFetch } = await resolveOrdersByTn(orderRef, hint)
          if (cancelled) return

          if (rows.length === 0) {
            setNotFound(true)
            setNotFoundReason('tn-miss')
            setReceipt(null)
            setResolvedRestaurantId(hint)
            setLoading(false)
            return
          }

          setResolvedRestaurantId(ridFromFetch || hint)
          setReceipt(aggregateOrders(rows))
          setNotFound(false)
          setNotFoundReason(null)
          setLoading(false)
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
  }, [orderRef, restaurantIdParam])

  useEffect(() => {
    const rid = resolvedRestaurantId || restaurantIdParam
    if (!rid) return
    getRestaurant(rid)
      .then((r) => setRestaurant(r))
      .catch(() => setRestaurant(null))
  }, [resolvedRestaurantId, restaurantIdParam])

  const currency = restaurant?.currency || 'N$'

  const goBackToMenu = () => {
    if (typeof window === 'undefined') return
    const restaurantId =
      resolvedRestaurantId || restaurantIdParam || localStorage.getItem('current_restaurant_id')
    const tableFromQuery = searchParams.get('table')
    const tableFromSession = sessionStorage.getItem('flashtap_return_table')
    const table = tableFromQuery || tableFromSession || ''
    if (restaurantId && table) {
      router.push(`/menu/${restaurantId}/v2?table=${encodeURIComponent(table)}`)
      return
    }
    if (restaurantId) {
      router.push(`/menu/${restaurantId}/browse`)
      return
    }
    router.push('/')
  }

  const displayOrderNumber = useMemo(() => {
    if (!receipt) return null
    if (receipt.orderDisplay) return receipt.orderDisplay
    if (typeof receipt.order_number === 'number') return `#${receipt.order_number}`
    return receipt.id ? receipt.id.slice(-8).toUpperCase() : null
  }, [receipt])

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
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border p-10 text-center space-y-6">
          <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto stroke-[1.5]" aria-hidden />
          <h1 className="text-2xl font-serif font-bold text-foreground">Payment successful</h1>
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
          ) : (
            <>
              <p className="text-muted-foreground font-sans text-sm">
                Your payment was received. We couldn&apos;t load the full receipt.
              </p>
              {orderRef ? (
                <p className="text-foreground font-sans text-sm break-all">
                  Order reference: <span className="font-semibold">{orderRef}</span>
                </p>
              ) : null}
            </>
          )}
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
