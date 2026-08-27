'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ComponentType } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import {
  resolveOrderRestaurantScope,
  type OrderRestaurantScope,
} from '@/lib/supabase/restaurants'
import { subscribeRestaurantOrdersRealtime, getAllOpenRestaurantOrders } from '@/lib/supabase/orders'
import {
  subscribeOrderRequestsRealtime,
  getWaitingOrderRequests,
  applyOrderRequestRealtimeEvent,
  type OrderRequest,
} from '@/lib/supabase/order-requests'
import {
  applyOrderRealtimeEvent,
  countPendingHostedOrders,
  unlockNewOrderSound,
} from '@/lib/dashboard/order-realtime'
import {
  announceIncomingOrder,
  suppressOrderAlert,
  getAlertArmedState,
  isOrderAlertMuted,
  setOrderAlertMuted,
  subscribeAlertArmedState,
  type AlertArmedState,
} from '@/lib/dashboard/order-alert-sound'
import {
  registerFeedChannel,
  reportFeedChannelStatus,
  getFeedConnectionState,
  subscribeFeedConnectionState,
  startFeedFallback,
  type FeedConnectionState,
  type FeedRefetchReason,
} from '@/lib/dashboard/realtime-connection'
import { FEED_CONNECTION_COPY } from '@/lib/dashboard/feed-connection-copy'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  effectiveRequestPricing,
  type OrderRequestPricingRow,
} from '@/lib/orders/order-request-pricing'
import {
  STALE_REQUEST_THRESHOLD_MS,
  isRequestOverdue,
  requestWaitingMinutes,
} from '@/lib/orders/customer-status'
import { OrderEditBadges, OrderEditTotalDelta } from '@/components/order-edit-indicators'
import { TAB_FLAG_COPY } from '@/lib/tabs/tab-flag-copy'
/*
 * PRODUCTION INCIDENT 2026-08-26. This import was missing and the three usages at :2860, :2861 and
 * :2875 threw `ReferenceError: STRANDED_CLAIM_COPY is not defined`, taking the staff dashboard down.
 *
 * Introduced by 9a2c3165 (2026-08-25) and live across THREE production deploys before anyone saw
 * it, because this file is `@ts-nocheck`: tsc skips it entirely, eslint's no-undef is off for TS on
 * the assumption tsc owns it, and `check-nocheck-imports-resolve.mjs` verifies that named imports
 * RESOLVE -- which is the one shape it cannot catch, since there was no import statement to inspect.
 */
import { STRANDED_CLAIM_COPY } from '@/lib/customer-copy/stranded-claim-copy'
import {
  TAB_PENDING_REQUEST_COLUMNS,
  TAB_PENDING_REQUEST_STATUSES,
  TAB_TOTAL_ORDER_COLUMNS,
  computeTabFigures,
} from '@/lib/tabs/tab-outstanding'
import { RefreshCw, Clock, ArrowLeft, CheckCircle2, ChefHat, Package, XCircle, Banknote, CreditCard, DollarSign, DoorClosed, Loader2, Mail, Printer, Pencil, Minus, ClipboardList, Volume2, VolumeX, BellOff, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { supabase } from '@/lib/supabase/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getAccessToken, onboardingFetch } from '@/lib/onboarding/api-client'
import {
  filterOrdersByStationScope,
  orderVisibleForStationScope,
} from '@/lib/order-routing'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'

async function markFirstPaymentSetupComplete() {
  try {
    await onboardingFetch('/api/admin/setup-status', {
      method: 'PATCH',
      body: JSON.stringify({ flag: 'first_payment_completed' }),
    })
  } catch {
    // non-blocking
  }
}

type TerminalStatus = 'pending' | 'failed' | null

// PART 2: Standardize Order Status Model
type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

/** Dashboard tab ids (UI) may differ from Supabase order status values. */
type DashboardTabId =
  | 'waiting_review'
  | 'new'
  | 'pending_payment'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'completed'

function supabaseStatusForTab(tab: DashboardTabId): string | null {
  if (tab === 'waiting_review') return null
  if (tab === 'pending_payment') return null
  if (tab === 'new') return 'pending'
  if (tab === 'preparing') return 'preparing'
  return tab
}
type Order = Record<string, any> & {
  id: string
  status: string
  payment_method: string
  payment_status: string
  placed_at: string
  total: number
  items: any[]
}

function paymentChannelOf(order: Order): string {
  return String((order as Order & { payment_channel?: string }).payment_channel || '').toLowerCase()
}

function isOrderPaid(order: Order): boolean {
  return String(order.payment_status || '').toLowerCase() === 'paid'
}

function canMarkManualPaid(order: Order): boolean {
  if (isOrderPaid(order)) return false
  const ps = String(order.payment_status || '').toLowerCase()
  const workflowStatus = String(order.status || '').toLowerCase()
  if (ps === 'cancelled') return false
  if (workflowStatus === 'completed' && ps === 'paid') return false
  const ch = paymentChannelOf(order)
  if (ch === 'cash' || ch === 'card_manual') return true
  if (order.payment_method === 'cash' && (ps === 'cash_pending' || ps === 'pending')) return true
  return false
}

/** At-table payment channels stay in New Orders until staff advances workflow status. */
function isAtTablePaymentChannel(order: Order): boolean {
  const ch = paymentChannelOf(order)
  return ch === 'cash' || ch === 'card_manual' || ch === 'other'
}

function isCustomerReadyToPay(order: Order): boolean {
  return order.customer_ready_to_pay === true
}

function tabIdOf(order: Order): string {
  return String((order as Order & { tab_id?: string | null }).tab_id || '').trim()
}

/** Orders added to an open tab — pay at settlement, must stay visible on the kitchen dashboard. */
function isTabOrder(order: Order): boolean {
  return tabIdOf(order) !== ''
}

const tabs: { id: DashboardTabId; label: string }[] = [
  { id: 'waiting_review', label: 'Waiting for Review' },
  { id: 'new', label: 'New Orders' },
  { id: 'pending_payment', label: 'Pending Payment' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
]

function orderActionKey(orderId: string, action: string) {
  return `${orderId}:${action}`
}

function ButtonSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} aria-hidden />
}

function ActionButtonContent({
  loading,
  icon: Icon,
  label,
  loadingLabel,
}: {
  loading: boolean
  icon?: ComponentType<{ className?: string }>
  label: string
  loadingLabel?: string
}) {
  return (
    <>
      {loading ? (
        <ButtonSpinner className="mr-2" />
      ) : Icon ? (
        <Icon className="h-4 w-4 mr-2" />
      ) : null}
      {loading ? loadingLabel ?? label : label}
    </>
  )
}

function requestItemLabel(item: Record<string, any>): string {
  const parts: string[] = []
  if (item?.size) parts.push(String(item.size))
  const addons = Array.isArray(item?.addons) ? item.addons : []
  for (const addon of addons) {
    if (typeof addon === 'string') parts.push(addon)
    else if (addon?.name) parts.push(String(addon.name))
  }
  return parts.join(', ')
}

/**
 * One card in the Waiting for Review tab. Item edits (remove / quantity) are staged locally
 * and only sent to the server on "Save Review" -- the parent then persists items_reviewed via
 * calculateOrderPricing server-side (never re-priced client-side here).
 */
function OrderRequestCard({
  request,
  currency,
  timeAgoLabel,
  nowMs,
  busy,
  onSaveReview,
  onAccept,
  onDecline,
}: {
  /**
   * `OrderRequestPricingRow` is named here rather than left to the index signature. `OrderRequest`
   * declares only id/restaurant_id/status by hand, and `OrderRequestPricingRow` is a weak type --
   * every member optional -- so passing one to the other is TS2559, "no properties in common", even
   * though the row carries them all at runtime. Declaring what this card actually needs is the
   * honest form; a cast at the call site would silence the same thing while hiding it.
   */
  request: OrderRequest & OrderRequestPricingRow & Record<string, any>
  currency: string
  timeAgoLabel: string
  /** The dashboard's shared clock, so a lock going stale re-renders without a row changing. */
  nowMs: number
  busy: boolean
  onSaveReview: (requestId: string, items: Record<string, any>[]) => Promise<void>
  onAccept: (requestId: string) => void
  onDecline: (requestId: string) => void
}) {
  // Precedence imported, not restated. This card used to carry its own two-tier copy of
  // "reviewed ?? original", which is now a THREE-tier rule because a customer can amend their
  // own request (order editing). A third copy is how staff come to review one item list while
  // Accept charges for another.
  const effective = effectiveRequestPricing(request)
  const isReviewed = effective.source === 'staff_reviewed'
  const wasCustomerEdited = (Number(request.customer_edit_count) || 0) > 0
  const effectiveItems = effective.items as Record<string, any>[]

  const [editing, setEditing] = useState(false)
  const [workingItems, setWorkingItems] = useState<Record<string, any>[]>(effectiveItems)
  const [saving, setSaving] = useState(false)

  const displayItems = editing ? workingItems : effectiveItems
  const displaySubtotal = effective.subtotal
  const displayTax = effective.tax
  const displayTotal = effective.total

  const startEditing = () => {
    setWorkingItems(effectiveItems.map((item) => ({ ...item })))
    setEditing(true)
  }

  const decrementQuantity = (index: number) => {
    setWorkingItems((prev) => {
      const next = [...prev]
      const item = { ...next[index] }
      const qty = Number(item.quantity) || 1
      if (qty <= 1) {
        next.splice(index, 1)
        return next
      }
      item.quantity = qty - 1
      next[index] = item
      return next
    })
  }

  const removeItem = (index: number) => {
    setWorkingItems((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSaveReview(request.id, workingItems)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    /**
      `data-request-id` is for TESTS, and it earned its place. A browser test that located a card
      by its table number accepted a DIFFERENT restaurant's request: the shared staging fixture had
      five waiting-review rows on it, and a text locator cannot tell them apart. A test that mutates
      data it does not own is worse than no test.
    */
    <div
      className="border border-border bg-card rounded-lg p-4"
      data-testid="order-request-card"
      data-request-id={request.id}
    >
      <div className="flex justify-between items-start gap-3 mb-2">
        <div>
          <span className="font-bold text-foreground">
            {request.channel === 'kiosk'
              ? `Kiosk${request.customer_name ? ` — ${request.customer_name}` : ''}`
              : `Table ${request.table_number ?? '—'}`}
          </span>
          <Badge className="ml-2 bg-purple-500 text-white border-0">Waiting for Review</Badge>
          {isReviewed && (
            <Badge variant="outline" className="ml-2">
              Edited
            </Badge>
          )}
          {/* Distinct from the "Edited" badge above, which means STAFF edited it. This one
              means the customer did, and staff have not necessarily seen the new list. */}
          <span className="ml-2 inline-flex items-center gap-2 align-middle">
            <OrderEditBadges order={request} nowMs={nowMs} />
          </span>
          <p className="text-muted-foreground text-sm mt-1">
            Requested {timeAgoLabel}
            {/*
              OVERDUE. Staff-facing and factual: it states the wait in minutes rather than telling
              anyone off. The number is the point — "waiting 41 min" is actionable in a way that a
              coloured dot is not.

              Beside the age the card already shows, because that is where someone triaging looks.
              The ranking is what makes an overdue request findable; this is what makes it legible
              once found.
            */}
            {isRequestOverdue(request.placed_at, nowMs) && (
              <span data-testid="request-overdue" className="ml-2 font-semibold text-amber-700">
                · waiting {requestWaitingMinutes(request.placed_at, nowMs)} min — no answer yet
              </span>
            )}
          </p>
          {wasCustomerEdited && (
            <OrderEditTotalDelta order={{ ...request, total: displayTotal }} currency={currency} />
          )}
        </div>
      </div>

      <div className="space-y-1 mb-3">
        {displayItems.length === 0 && (
          <p className="text-sm text-destructive">No items left — decline this request.</p>
        )}
        {displayItems.map((item, index) => (
          <div key={index} className="flex justify-between items-center gap-2 text-sm">
            <div className="flex-1">
              <span className="font-medium">{item.quantity}× {item.displayName || item.name}</span>
              {requestItemLabel(item) && (
                <span className="text-muted-foreground"> ({requestItemLabel(item)})</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-muted-foreground">
                {currency}
                {(Number(item.subtotal) || 0).toFixed(2)}
              </span>
              {editing && (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-6 w-6"
                    onClick={() => decrementQuantity(index)}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-6 w-6"
                    onClick={() => removeItem(index)}
                  >
                    <XCircle className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {request.order_instructions && (
        <p className="text-sm text-muted-foreground italic mb-2 break-words">&quot;{request.order_instructions}&quot;</p>
      )}

      <div className="flex justify-between items-baseline mb-3 pt-2 border-t border-border">
        <span className="text-sm text-muted-foreground">
          Subtotal {currency}{(Number(displaySubtotal) || 0).toFixed(2)} · Tax {currency}{(Number(displayTax) || 0).toFixed(2)}
        </span>
        <span className="font-bold text-foreground">
          {currency}
          {(Number(displayTotal) || 0).toFixed(2)}
        </span>
      </div>

      {editing ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 bg-blue-500 hover:bg-blue-600"
            onClick={handleSave}
            disabled={saving || workingItems.length === 0}
          >
            <ActionButtonContent loading={saving} label="Save Review" loadingLabel="Saving..." />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={startEditing} disabled={busy}>
            <ActionButtonContent icon={Pencil} loading={false} label="Edit Items" />
          </Button>
          <Button
            variant="outline"
            className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
            onClick={() => onDecline(request.id)}
            disabled={busy}
          >
            <ActionButtonContent icon={XCircle} loading={false} label="Decline" />
          </Button>
          <Button
            className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
            onClick={() => onAccept(request.id)}
            disabled={busy}
          >
            <ActionButtonContent loading={busy} icon={CheckCircle2} label="Accept" loadingLabel="Accepting..." />
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * SIGNED OFF 2026-08-19. Staff-facing, the three states of the incoming-order sound.
 *
 * Each string is used THREE times per state — visible label, `aria-label` and `title` — so each has
 * to read as a standalone statement, not as a fragment that only makes sense beside an icon.
 *
 * TWO STATE FACTS AND EXACTLY ONE INSTRUCTION. `blocked` is the only state where the staff member
 * has something to do, so it is the only imperative. Making another one imperative would turn a
 * status readout into three competing buttons.
 *
 * Kept as a constant rather than inline for the same reason lib/customer-copy/qr-redesign-copy.ts
 * exists: one place to read, and one place a marker can be found by grep. These three were the last
 * PENDING COPY strings rendering on production.
 */
const ORDER_ALERT_COPY = {
  armed: 'Sound on',
  blocked: 'Turn on sound',
  muted: 'Sound off',
} as const

/**
 * WHETHER A STAFF MEMBER WILL ACTUALLY HEAR AN INCOMING ORDER, and a control to change it.
 *
 * THIS IS THE POINT OF THE FEATURE, not decoration. Browsers block audio until the page has been
 * interacted with, so before this existed the dashboard could sit silent all shift with nothing
 * on screen saying so — and a silent alert nobody knows is silent is worse than no alert, because
 * staff stop watching the screen having been told they do not need to.
 *
 * THREE STATES, not two: `blocked` (the browser has not granted audio) is a different problem from
 * `muted` (a staff member turned it off) and needs a different action, so they must not collapse
 * into one "off". Clicking while blocked attempts the unlock; clicking while armed or muted
 * toggles the mute.
 *
 * The state is SUBSCRIBED, not read once: a browser can suspend an AudioContext without being
 * asked, and an indicator that went stale would be lying about the one thing it exists to report.
 */
function OrderAlertIndicator() {
  const [state, setState] = useState<AlertArmedState>('blocked')

  useEffect(() => {
    const sync = () => setState(getAlertArmedState())
    sync()
    return subscribeAlertArmedState(sync)
  }, [])

  const handleClick = () => {
    if (state === 'blocked') {
      // Inside a click, so this is the gesture the browser is waiting for.
      unlockNewOrderSound()
      setOrderAlertMuted(false)
    } else {
      setOrderAlertMuted(!isOrderAlertMuted())
    }
    setState(getAlertArmedState())
  }

  const Icon = state === 'armed' ? Volume2 : state === 'muted' ? VolumeX : BellOff
  const label = ORDER_ALERT_COPY[state]

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      data-testid="order-alert-indicator"
      data-alert-state={state}
      className={
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ' +
        (state === 'armed'
          ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
          : state === 'muted'
            ? 'border-border bg-muted text-muted-foreground hover:bg-muted/80'
            : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100')
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  )
}

/**
 * WHETHER THE ORDER LIST IS ACTUALLY BEING FED. #350.
 *
 * Built to the standard `OrderAlertIndicator` above sets, because it is the same argument with more
 * force: a dead socket loses the ORDERS, not just the noise announcing them. Before this, the
 * dashboard's only visible motion during an outage was a 60-second clock tick advancing "2 minutes
 * ago" to "3 minutes ago" on frozen data — the page looked alive while nothing was arriving.
 *
 * THREE STATES, and only one of them asks anything of a staff member. `reconnecting` is a blip
 * resolving itself and must not read as an alarm, or staff learn to ignore the indicator; `offline`
 * means the list is only as fresh as the slow poll and is the one state with an instruction.
 *
 * The state is SUBSCRIBED, not read once — see `subscribeFeedConnectionState`. Reading it at mount
 * would produce an indicator that goes stale, which is the exact failure it exists to report.
 *
 * NOT A BUTTON. The sound indicator is clickable because clicking is what unlocks audio. There is
 * no equivalent gesture here — the fallbacks already retry on their own — so this is a status
 * readout with `role="status"`, and adding a "reconnect" button would only offer staff a control
 * that does nothing the page is not already doing.
 */
export function FeedConnectionIndicator() {
  const [state, setState] = useState<FeedConnectionState>('reconnecting')

  useEffect(() => {
    const sync = () => setState(getFeedConnectionState())
    sync()
    return subscribeFeedConnectionState(sync)
  }, [])

  const Icon = state === 'live' ? Wifi : state === 'reconnecting' ? RefreshCw : WifiOff
  const label = FEED_CONNECTION_COPY[state]

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      data-testid="feed-connection-indicator"
      data-feed-state={state}
      className={
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ' +
        (state === 'live'
          ? 'border-green-300 bg-green-50 text-green-700'
          : state === 'reconnecting'
            ? 'border-amber-300 bg-amber-50 text-amber-800'
            : 'border-red-300 bg-red-50 text-red-700')
      }
    >
      <Icon className={cn('h-4 w-4', state === 'reconnecting' && 'animate-spin')} />
      <span>{label}</span>
    </span>
  )
}

export function OrdersDashboard() {
  const { user, restaurantId, restaurant } = useAuth()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const router = useRouter()
  const { toast } = useToast()
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])
  const [activeTab, setActiveTab] = useState<DashboardTabId>('new')
  const [pendingHostedCount, setPendingHostedCount] = useState(0)
  const [cancellingHostedOrderId, setCancellingHostedOrderId] = useState<string | null>(null)
  const [allOrders, setAllOrders] = useState<Order[]>([])
  const [completedOrders, setCompletedOrders] = useState<Order[]>([])
  const [orderRequests, setOrderRequests] = useState<OrderRequest[]>([])
  const [requestActionKey, setRequestActionKey] = useState<string | null>(null)
  const [declineTargetRequestId, setDeclineTargetRequestId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [showDeclineDialog, setShowDeclineDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const [markingPaidOrderId, setMarkingPaidOrderId] = useState<string | null>(null)
  const [markPaidTargetOrderId, setMarkPaidTargetOrderId] = useState<string | null>(null)
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState(false)
  const [closeTableTargetNumber, setCloseTableTargetNumber] = useState<number | null>(null)
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)
  const [showCloseTableDialog, setShowCloseTableDialog] = useState(false)
  /** #120's residual — the ids of `accepting` claims blocking the table the user just tried to close. */
  const [strandedClaimIds, setStrandedClaimIds] = useState<string[]>([])
  const [strandedTableNumber, setStrandedTableNumber] = useState<number | null>(null)
  const [releasingClaims, setReleasingClaims] = useState(false)
  const [emailReceiptTargetOrderId, setEmailReceiptTargetOrderId] = useState<string | null>(null)
  const [showEmailReceiptDialog, setShowEmailReceiptDialog] = useState(false)
  const [emailReceiptAddress, setEmailReceiptAddress] = useState('')
  const [sendingReceiptEmailOrderId, setSendingReceiptEmailOrderId] = useState<string | null>(null)
  const [printingReceiptOrderId, setPrintingReceiptOrderId] = useState<string | null>(null)
  const [statusUpdateKey, setStatusUpdateKey] = useState<string | null>(null)
  const [sendingToTerminalOrderId, setSendingToTerminalOrderId] = useState<string | null>(null)
  const [cancelingTerminalOrderId, setCancelingTerminalOrderId] = useState<string | null>(null)
  const [terminalDismissedPollingIds, setTerminalDismissedPollingIds] = useState<string[]>([])
  const [terminalStatusByOrderId, setTerminalStatusByOrderId] = useState<Record<string, TerminalStatus>>({})
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dashboardRestaurantId = String((restaurant as { id?: string } | null)?.id || restaurantId || '')
  const showDashboardLoading = loading && Boolean(user)
  const [orderScope, setOrderScope] = useState<OrderRestaurantScope | null>(null)
  const [orderScopeRestaurantId, setOrderScopeRestaurantId] = useState(dashboardRestaurantId)
  if (orderScopeRestaurantId !== dashboardRestaurantId) {
    setOrderScopeRestaurantId(dashboardRestaurantId)
    if (!dashboardRestaurantId) setOrderScope(null)
  }
  const [tabInfoById, setTabInfoById] = useState<
    Record<string, { status: string; payment_preference: string | null; members: any[]; linked_unpaid_tab_id: string | null }>
  >({})
  /**
   * Linked tabs that are STILL unpaid, by linked tab id. Staff-only: nothing in the customer
   * app reads this, and the flag is a prompt to ask, never a block on anything.
   */
  const [unpaidTabElsewhere, setUnpaidTabElsewhere] = useState<
    Record<string, { table_number: number | null; payable: number; pending: number }>
  >({})

  const tabInfoScopeId = orderScope?.restaurantId ?? ''
  const [tabInfoScopeKey, setTabInfoScopeKey] = useState(tabInfoScopeId)
  if (tabInfoScopeKey !== tabInfoScopeId) {
    setTabInfoScopeKey(tabInfoScopeId)
    if (!tabInfoScopeId) setTabInfoById({})
  }
  const orderScopeRef = useRef<OrderRestaurantScope | null>(null)
  const subscribedRestaurantIdRef = useRef<string | null>(null)
  useEffect(() => {
    orderScopeRef.current = orderScope
  }, [orderScope])

  const toDate = (timestamp: unknown): Date | null => {
    if (!timestamp) return null
    if (timestamp instanceof Date) return Number.isNaN(timestamp.getTime()) ? null : timestamp
    if (typeof (timestamp as { toDate?: unknown })?.toDate === 'function') {
      const date = (timestamp as { toDate: () => Date }).toDate()
      return Number.isNaN(date.getTime()) ? null : date
    }
    if (typeof timestamp === 'string' || typeof timestamp === 'number') {
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? null : date
    }
    return null
  }

  const isRecentCardPendingOrder = useCallback((order: Order) => {
    if (order.payment_method !== 'card' || order.payment_status !== 'pending') return false
    const ch = paymentChannelOf(order)
    if (ch === 'card_manual' || ch === 'other') return false
    if (ch === 'terminal') return true
    const createdDate = toDate((order as Order & { created_at?: unknown }).created_at) || toDate(order.placed_at)
    if (!createdDate) return true
    return Date.now() - createdDate.getTime() < 5 * 60 * 1000
  }, [])

  const shouldDisplayOrder = useCallback((order: Order) => {
    const isPaidSettlementOrder =
      String((order as Order & { tab_settlement_for_tab_id?: string | null }).tab_settlement_for_tab_id || '').trim() !== '' &&
      String(order.payment_status || '').toLowerCase() === 'paid'
    if (isPaidSettlementOrder) return false

    if (isTabOrder(order)) return true

    const ch = paymentChannelOf(order)
    if (ch === 'cash' || ch === 'card_manual' || ch === 'other') return true
    if (order.payment_method === 'other') return true
    if (order.payment_method === 'cash') return true
    if (order.payment_method === 'card_terminal') return true
    if (order.payment_method === 'card') {
      if (ch === 'card_manual' && order.payment_status === 'pending') return true
      if (ch === 'terminal' && order.payment_status === 'pending') return true
      if (order.payment_status === 'paid') return true
      return isRecentCardPendingOrder(order)
    }
    return true
  }, [isRecentCardPendingOrder])

  /**
   * #350. THIS INTERVAL ONLY TICKS A CLOCK -- it does not refetch, and never did. That is precisely
   * why a dropped socket was invisible: relative timestamps kept advancing on frozen data, so the
   * page looked alive while nothing was arriving. The refetching is `refreshOpenOrders` below, on
   * its own schedule. Do not merge the two: this one must stay cheap enough to run every minute
   * whether or not anything is wrong.
   */
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  /**
   * RE-READ THE OPEN ORDER LIST FROM THE DATABASE. #350.
   *
   * The single refetch path, shared by the header's manual refresh button, the reconnect handlers,
   * the slow fallback poll and `visibilitychange`. It exists because a Realtime socket that comes
   * back does NOT backfill what it missed -- resubscribing without refetching leaves the list
   * permanently missing a window of orders while looking healthy.
   *
   * `showSpinner` is off by default ON PURPOSE. A background poll that flashed the full-screen
   * spinner every minute would be its own defect, and one staff would learn to ignore.
   */
  const refreshOpenOrders = useCallback(
    async ({ showSpinner = false }: { showSpinner?: boolean } = {}) => {
      const scope = orderScopeRef.current
      if (!dashboardRestaurantId || !scope) return
      if (showSpinner) setLoading(true)
      try {
        const incoming = await getAllOpenRestaurantOrders(dashboardRestaurantId, scope)
        const list = Array.isArray(incoming) ? (incoming as Order[]) : []
        setAllOrders(list)
        setPendingHostedCount(countPendingHostedOrders(list))
      } catch (err) {
        console.error(err)
      } finally {
        if (showSpinner) setLoading(false)
      }
    },
    [dashboardRestaurantId],
  )

  /** The same, for the QR order requests channel. Requests are where a customer's order lands first. */
  const refreshWaitingRequests = useCallback(async () => {
    const scope = orderScopeRef.current
    if (!dashboardRestaurantId || !scope) return
    try {
      const incoming = await getWaitingOrderRequests(dashboardRestaurantId, scope)
      setOrderRequests(Array.isArray(incoming) ? incoming : [])
    } catch (err) {
      console.error(err)
    }
  }, [dashboardRestaurantId])

  /**
   * THE FALLBACKS. #350, items 3 and 4.
   *
   * A tab left open overnight is the NORMAL case for this screen and browsers let background tabs'
   * sockets die quietly, so becoming visible is the highest-value moment to refetch. The slow poll
   * runs whatever the reported connection state says, because a channel can report SUBSCRIBED and
   * still deliver nothing -- the requirement is that this list cannot be indefinitely stale.
   */
  useEffect(() => {
    // `user` as well as the id: the subscription effect refuses to run without one, and a poll
    // that fired anyway would be an unauthenticated read this repo has ruled out (#264).
    if (!user || !dashboardRestaurantId) return
    return startFeedFallback({
      refetch: (reason: FeedRefetchReason) => {
        void refreshOpenOrders()
        void refreshWaitingRequests()
        if (reason !== 'poll') console.info('[orders] feed refetch:', reason)
      },
    })
  }, [user, dashboardRestaurantId, refreshOpenOrders, refreshWaitingRequests])

  /* eslint-disable react-hooks/set-state-in-effect -- scope/tab hydration guards; React Query refactor out of scope */
  useEffect(() => {
    if (!dashboardRestaurantId) {
      return
    }

    if (restaurant?.id) {
      setOrderScope({
        restaurantId: String(restaurant.id),
        // Both halves, as `resolveOrderRestaurantScope` sets them on the branch below: the same
        // uuid twice. `firebaseRestaurantId` is deprecated and nothing in this file reads it, so
        // this is the shape being made honest, not a behaviour change.
        firebaseRestaurantId: String(restaurant.id),
      })
      return
    }

    let cancelled = false
    void resolveOrderRestaurantScope(dashboardRestaurantId)
      .then((scope) => {
        if (!cancelled) setOrderScope(scope)
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) setOrderScope(null)
      })
    return () => {
      cancelled = true
    }
  }, [dashboardRestaurantId, restaurant])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- tab info hydration; React Query refactor out of scope */
  useEffect(() => {
    const restaurantUuid = orderScope?.restaurantId
    if (!restaurantUuid) {
      return
    }

    const tabIds = [
      ...new Set(allOrders.map((order) => tabIdOf(order)).filter(Boolean)),
    ] as string[]
    if (!tabIds.length) {
      setTabInfoById({})
      return
    }

    let cancelled = false
    const loadTabs = async () => {
      const { data, error } = await supabase
        .from('tabs')
        .select('id, status, payment_preference, members, linked_unpaid_tab_id')
        .eq('restaurant_id', restaurantUuid)
        .in('id', tabIds)

      if (cancelled) return
      if (error) {
        console.error('[DASHBOARD] tab fetch error', error)
        return
      }

      const next: Record<string, { status: string; payment_preference: string | null; members: any[]; linked_unpaid_tab_id: string | null }> = {}
      for (const row of data || []) {
        next[String(row.id)] = {
          status: String(row.status || ''),
          payment_preference: row.payment_preference ? String(row.payment_preference) : null,
          members: Array.isArray(row.members) ? row.members : [],
          linked_unpaid_tab_id: row.linked_unpaid_tab_id ? String(row.linked_unpaid_tab_id) : null,
        }
      }
      /**
       * The unpaid-tab-elsewhere flag (#211 follow-up), resolved in a SECOND pass.
       *
       * A tab records the tab its customer already held when this one was created. The flag
       * must show only while that other tab is STILL unpaid — that is how "clears on settle"
       * is implemented without a write on the settle path: nothing clears the pointer, the
       * render simply stops matching once the linked tab leaves open/ready_to_pay.
       *
       * Second query rather than a join because the linked tab is usually NOT one of the tabs
       * already on screen — it belongs to a different table, which is the entire point.
       */
      const linkedIds = [...new Set(
        Object.values(next)
          .map((info) => info.linked_unpaid_tab_id)
          .filter((id): id is string => Boolean(id)),
      )]
      if (linkedIds.length > 0) {
        /**
         * `tabs.total` is NOT read here any more (#286).
         *
         * It was, and it is the cache: five writers, two incompatible definitions, and nothing
         * re-sums it when an order is cancelled (QRA-15). Measured on production 2026-08-15, of
         * 20 tabs carrying orders the two definitions agreed on ONE -- 13 rows stored "gross
         * ordered" and 6 stored "still outstanding", decided by whichever writer touched the row
         * last. So this badge was telling a staff member "Table 7 has an unpaid tab of N$X" where
         * X was, for most tables, undecidably one or the other.
         *
         * It now uses `computeTabFigures`, the same function every customer surface uses, over
         * the same columns that module names. One definition, everywhere.
         *
         * TWO FIGURES, per the standing ruling: this badge DISPLAYS, so it shows both. It decides
         * nothing -- it does not block ordering, accepting, preparing or settling; it is a prompt
         * to ask.
         */
        const [{ data: linkedRows }, { data: linkedOrders }, { data: linkedRequests }] =
          await Promise.all([
            supabase
              .from('tabs')
              .select('id, status, table_number')
              .eq('restaurant_id', restaurantUuid)
              .in('id', linkedIds),
            supabase
              .from('orders')
              .select(`tab_id, ${TAB_TOTAL_ORDER_COLUMNS}`)
              .eq('restaurant_id', restaurantUuid)
              .in('tab_id', linkedIds),
            supabase
              .from('order_requests')
              .select(`tab_id, ${TAB_PENDING_REQUEST_COLUMNS}`)
              .eq('restaurant_id', restaurantUuid)
              .in('tab_id', linkedIds)
              .in('status', [...TAB_PENDING_REQUEST_STATUSES]),
          ])
        if (cancelled) return

        const ordersByTab = new Map<string, Record<string, unknown>[]>()
        for (const row of linkedOrders || []) {
          const key = String((row as Record<string, unknown>).tab_id ?? '')
          if (!key) continue
          const list = ordersByTab.get(key) ?? []
          list.push(row as Record<string, unknown>)
          ordersByTab.set(key, list)
        }
        const requestsByTab = new Map<string, Record<string, unknown>[]>()
        for (const row of linkedRequests || []) {
          const key = String((row as Record<string, unknown>).tab_id ?? '')
          if (!key) continue
          const list = requestsByTab.get(key) ?? []
          list.push(row as Record<string, unknown>)
          requestsByTab.set(key, list)
        }

        const stillUnpaid: Record<
          string,
          { table_number: number | null; payable: number; pending: number }
        > = {}
        for (const row of linkedRows || []) {
          if (!['open', 'ready_to_pay'].includes(String(row.status || ''))) continue
          const id = String(row.id)
          const figures = computeTabFigures(
            (ordersByTab.get(id) ?? []) as never,
            (requestsByTab.get(id) ?? []) as never,
          )
          stillUnpaid[id] = {
            table_number: row.table_number != null ? Number(row.table_number) : null,
            payable: figures.payable,
            pending: figures.pending,
          }
        }
        setUnpaidTabElsewhere(stillUnpaid)
      } else {
        setUnpaidTabElsewhere({})
      }

      setTabInfoById(next)
    }

    void loadTabs()
    return () => {
      cancelled = true
    }
  }, [allOrders, orderScope?.restaurantId])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const restaurantUuid = orderScope?.restaurantId
    if (!restaurantUuid) return

    // Registered BEFORE the channel is created: `.subscribe()`'s callback can land first, and
    // registering afterwards would overwrite the status it just reported with `joining`.
    const unregister = registerFeedChannel(`tabs:${restaurantUuid}`)

    const channel = supabase
      .channel(`tabs-dash-${restaurantUuid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tabs',
          filter: `restaurant_id=eq.${restaurantUuid}`,
        },
        (payload: { new?: Record<string, unknown> | null }) => {
          const row = payload.new as {
            id?: string
            status?: string
            payment_preference?: string | null
            members?: unknown
            linked_unpaid_tab_id?: unknown
          }
          if (!row?.id) return
          setTabInfoById((prev) => ({
            ...prev,
            [String(row.id)]: {
              status: String(row.status || ''),
              payment_preference: row.payment_preference ? String(row.payment_preference) : null,
              members: Array.isArray(row.members)
                ? row.members
                : prev[String(row.id)]?.members ?? [],
              /**
               * CARRIED, not dropped. This entry REPLACES the one `loadTabs` built, and that one is
               * the only place the unpaid-tab-elsewhere pointer (#211 follow-up) ever came from.
               * Omitting it here erased the amber flag from every order on that tab the moment any
               * `tabs` row changed -- including the change that matters most, the customer moving
               * to `ready_to_pay`, which is exactly when staff need to know about the other tab.
               * Nothing else refills it: `unpaidTabElsewhere` is resolved in `loadTabs`'s second
               * pass and no realtime event re-runs it.
               *
               * Read the payload when it carries the column and fall back to the previous value
               * when it does not, so this is right whether or not the publication ships every
               * column. A stale pointer is harmless by construction: the badge only renders while
               * `unpaidTabElsewhere[linkedId]` still shows that tab unpaid, which is how it clears
               * on settle without anything writing to the settle path.
               */
              linked_unpaid_tab_id:
                'linked_unpaid_tab_id' in row
                  ? row.linked_unpaid_tab_id
                    ? String(row.linked_unpaid_tab_id)
                    : null
                  : prev[String(row.id)]?.linked_unpaid_tab_id ?? null,
            },
          }))
        }
      )
      /**
       * #350: this was a bare `.subscribe()` with no callback at all -- the channel could die and
       * nothing anywhere would know. On a RETURN to SUBSCRIBED we refetch the orders rather than
       * the tabs directly: the tab-info effect above keys on `allOrders`, so a fresh list re-reads
       * every tab row as a consequence, and there is one refetch path instead of two.
       */
      .subscribe((status: string) => {
        const { refetch } = reportFeedChannelStatus(`tabs:${restaurantUuid}`, status)
        if (refetch) void refreshOpenOrders()
      })

    return () => {
      unregister()
      supabase.removeChannel(channel)
    }
  }, [orderScope?.restaurantId, refreshOpenOrders])

  // Single Realtime subscription for all order INSERT/UPDATE/DELETE events
  /* eslint-disable react-hooks/set-state-in-effect -- subscription lifecycle guards; React Query refactor out of scope */
  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    if (!dashboardRestaurantId) {
      setLoading(false)
      return
    }

    if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let unregisterChannel: (() => void) | undefined

    const start = async () => {
      let scope = orderScopeRef.current
      if (!scope) {
        try {
          scope = await resolveOrderRestaurantScope(dashboardRestaurantId)
        } catch (err) {
          console.error(err)
          if (!cancelled) setLoading(false)
          return
        }
      }

      if (cancelled || !scope) return

      if (subscribedRestaurantIdRef.current === dashboardRestaurantId) return
      subscribedRestaurantIdRef.current = dashboardRestaurantId

      setLoading(true)

      // #350. Registered before the subscription exists, so the indicator reads `reconnecting`
      // from the first paint rather than claiming `live` on a channel that has not joined yet.
      unregisterChannel = registerFeedChannel(`orders:${dashboardRestaurantId}`)

      unsubscribe = subscribeRestaurantOrdersRealtime(
        dashboardRestaurantId,
        {
          onInitial: (incoming) => {
            if (cancelled) return
            const list = Array.isArray(incoming) ? (incoming as Order[]) : []
            setAllOrders(list)
            setPendingHostedCount(countPendingHostedOrders(list))
            setLoading(false)
          },
          onChange: (payload) => {
            if (cancelled) return
            setAllOrders((prev) => {
              const next = applyOrderRealtimeEvent(prev, payload)
              setPendingHostedCount(countPendingHostedOrders(next))
              return next
            })

            if (payload.eventType === 'INSERT') {
              const row = payload.new as Order | null
              /**
                An accepted request arrives here a SECOND time -- createOrder writes status
                'pending', so this branch used to chime again for an order the request
                subscription had already announced. announceIncomingOrder keys both events to one
                identity via source_request_id. See lib/dashboard/order-alert-sound.ts.
              */
              if (announceIncomingOrder(row, 'orders').notify) {
                toastRef.current({
                  title: 'New order',
                  description: `Order #${row?.order_number ?? '?'} — Table ${row?.table_number ?? '?'}`,
                })
              }
            }
          },
          /**
           * #350, ITEMS 1 AND 2. `subscribeRestaurantOrdersRealtime` has forwarded this status
           * since it was written and NO CALLER EVER PASSED ONE -- CHANNEL_ERROR, TIMED_OUT and
           * CLOSED went nowhere, so a dead socket froze this list in silence.
           *
           * REFETCHING ON RECONNECT IS THE LOAD-BEARING HALF, not the resubscribe. Postgres changes
           * that happened while the socket was away are gone -- Realtime does not replay them. A
           * dashboard that only resubscribed would sit there permanently missing a window of
           * orders while every indicator on the page said it was fine.
           */
          onStatus: (status) => {
            if (cancelled) return
            const { refetch } = reportFeedChannelStatus(`orders:${dashboardRestaurantId}`, status)
            if (refetch) void refreshOpenOrders()
          },
        },
        scope
      )

      if (cancelled) {
        unsubscribe()
        unregisterChannel?.()
        if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
          subscribedRestaurantIdRef.current = null
        }
      }
    }

    void start()

    return () => {
      cancelled = true
      if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
        subscribedRestaurantIdRef.current = null
      }
      unregisterChannel?.()
      unsubscribe?.()
    }
  }, [user, dashboardRestaurantId, refreshOpenOrders])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!dashboardRestaurantId) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let unregisterChannel: (() => void) | undefined

    const start = async () => {
      let scope = orderScopeRef.current
      if (!scope) {
        try {
          scope = await resolveOrderRestaurantScope(dashboardRestaurantId)
        } catch (err) {
          console.error(err)
          return
        }
      }
      if (cancelled || !scope) return

      unregisterChannel = registerFeedChannel(`order_requests:${dashboardRestaurantId}`)

      unsubscribe = subscribeOrderRequestsRealtime(
        dashboardRestaurantId,
        {
          onInitial: (incoming) => {
            if (cancelled) return
            setOrderRequests(incoming)
          },
          onChange: (payload) => {
            if (cancelled) return
            setOrderRequests((prev) => applyOrderRequestRealtimeEvent(prev, payload))

            if (payload.eventType === 'INSERT') {
              const row = payload.new
              // A customer's QR submission lands here first. The matching `orders` INSERT after
              // staff Accept is keyed to the SAME identity and stays silent.
              if (announceIncomingOrder(row, 'order_requests').notify) {
                toastRef.current({
                  title: 'New order request',
                  description: row?.channel === 'kiosk'
                    ? 'A kiosk order is waiting for review.'
                    : `A table order is waiting for review (Table ${row?.table_number ?? '?'}).`,
                })
              }
            }
          },
          /** #350. Same reconnect rule as the orders channel: a returning socket backfills nothing. */
          onStatus: (status) => {
            if (cancelled) return
            const { refetch } = reportFeedChannelStatus(
              `order_requests:${dashboardRestaurantId}`,
              status,
            )
            if (refetch) void refreshWaitingRequests()
          },
        },
        scope,
      )
    }

    void start()

    return () => {
      cancelled = true
      unregisterChannel?.()
      unsubscribe?.()
    }
  }, [dashboardRestaurantId, refreshWaitingRequests])

  useEffect(() => {
    if (activeTab !== 'completed' || !dashboardRestaurantId) return

    const fetchCompleted = async () => {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', dashboardRestaurantId)
        .eq('status', 'completed')
        .order('placed_at', { ascending: false })
        .limit(100)

      if (data) setCompletedOrders(data as Order[])
    }

    void fetchCompleted()
  }, [activeTab, dashboardRestaurantId])

  /**
   * OVERDUE REQUESTS RANK FIRST. Not merely flagged — a flag nobody scrolls to is the same defect
   * in a different colour.
   *
   * Production had a submission open for 477 HOURS. Every writer of `order_requests.status` is a
   * human action and the cron sweeps `orders` only, so nothing aged it, nothing ranked it, and
   * nothing told anyone. It sat wherever the fetch order happened to put it, indistinguishable
   * from one placed thirty seconds ago.
   *
   * Within each group the OLDEST comes first, so the queue reads worst-first rather than
   * newest-first. Ties fall back to id so the order cannot flicker between renders on equal
   * timestamps.
   *
   * READ-ONLY. This sorts and labels; it writes nothing and changes no request's status.
   */
  const rankedOrderRequests = useMemo(() => {
    const at = (r: OrderRequest) => {
      const t = Date.parse(String(r.placed_at ?? ''))
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
    }
    return [...orderRequests].sort((a, b) => {
      const ao = isRequestOverdue(a.placed_at, nowMs)
      const bo = isRequestOverdue(b.placed_at, nowMs)
      if (ao !== bo) return ao ? -1 : 1
      const d = at(a) - at(b)
      return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
    })
  }, [orderRequests, nowMs])

  const overdueRequestCount = useMemo(
    () => orderRequests.filter((r) => isRequestOverdue(r.placed_at, nowMs)).length,
    [orderRequests, nowMs],
  )

  const stationScope = useMemo(
    () => ({
      hasKitchenStation:
        permissionsLoaded && hasPermission(PERMISSIONS.ORDERS_STATION_KITCHEN),
      hasBarStation: permissionsLoaded && hasPermission(PERMISSIONS.ORDERS_STATION_BAR),
    }),
    [permissionsLoaded, hasPermission]
  )

  const stationFilteredOrders = useMemo(() => {
    if (!permissionsLoaded) return allOrders
    return filterOrdersByStationScope(allOrders, stationScope)
  }, [allOrders, stationScope, permissionsLoaded])

  const mergedSourceOrders = useMemo(() => {
    if (activeTab === 'pending_payment') {
      return stationFilteredOrders.filter(
        (order) =>
          paymentChannelOf(order) === 'hosted' &&
          String(order.payment_status || '').toLowerCase() === 'pending'
      )
    }
    if (activeTab === 'new') {
      return stationFilteredOrders.filter(
        (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
      )
    }
    if (activeTab === 'completed') {
      const fromRealtime = stationFilteredOrders.filter((order) => order.status === 'completed')
      const merged = [...fromRealtime]
      for (const order of completedOrders) {
        if (!orderVisibleForStationScope(order, stationScope)) continue
        if (!merged.find((existing) => existing.id === order.id)) {
          merged.push(order)
        }
      }
      return merged
    }
    const mappedStatus = supabaseStatusForTab(activeTab)
    if (!mappedStatus) return []
    return stationFilteredOrders.filter((order) => order.status === mappedStatus)
  }, [activeTab, stationFilteredOrders, completedOrders, stationScope])

  const tabCounts = useMemo(() => {
    const newCandidates = stationFilteredOrders.filter(
      (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
    )
    return {
      waiting_review: orderRequests.length,
      pending_payment: countPendingHostedOrders(stationFilteredOrders),
      new: newCandidates.length,
      accepted: stationFilteredOrders.filter((order) => order.status === 'accepted').length,
      preparing: stationFilteredOrders.filter((order) => order.status === 'preparing').length,
      ready: stationFilteredOrders.filter((order) => order.status === 'ready').length,
      completed: stationFilteredOrders.filter((order) => order.status === 'completed').length,
    } as Record<DashboardTabId, number>
  }, [stationFilteredOrders, orderRequests])

  const orders = useMemo(() => {
    if (!user || !dashboardRestaurantId) return []

    const newOrders = mergedSourceOrders

    const visibleOrders = newOrders.filter((order) => {
      if (activeTab === 'pending_payment') {
        return paymentChannelOf(order) === 'hosted' && order.payment_status === 'pending'
      }
      if (!shouldDisplayOrder(order)) {
        return false
      }
      if (activeTab === 'new') {
        if (isTabOrder(order)) return true
        if (isAtTablePaymentChannel(order)) return true
        if (order.payment_method === 'cash' || order.payment_method === 'other') return true
        if (order.payment_method === 'card_terminal' && order.payment_status === 'terminal_pending') return true
        if (paymentChannelOf(order) === 'terminal') return true
        if (order.payment_method === 'card' && order.payment_status === 'paid') return true
        if (
          order.payment_method === 'card' &&
          order.payment_status === 'pending' &&
          paymentChannelOf(order) === 'hosted'
        ) {
          return isRecentCardPendingOrder(order)
        }
        return false
      }
      return true
    })

    const sortNewTab = (list: Order[]) => {
      if (activeTab !== 'new') return list
      const rank = (o: Order) => {
        const term = paymentChannelOf(o) === 'terminal'
        if (term && o.status === 'ready_for_terminal') return 0
        if (term && o.payment_status === 'pending') return 1
        return 2
      }
      return [...list].sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        if (ra !== rb) return ra - rb
        const ta = toDate(a.placed_at)?.getTime() || 0
        const tb = toDate(b.placed_at)?.getTime() || 0
        return ta - tb
      })
    }

    const completedSortTime = (order: Order) =>
      toDate((order as Order & { completed_at?: unknown }).completed_at)?.getTime() ||
      toDate((order as Order & { accepted_at?: unknown }).accepted_at)?.getTime() ||
      toDate((order as Order & { updated_at?: unknown }).updated_at)?.getTime() ||
      toDate(order.placed_at)?.getTime() ||
      0

    const sortOrdersForTab = (list: Order[]) => {
      if (activeTab === 'new') return sortNewTab(list)
      if (activeTab === 'completed') {
        return [...list].sort((a, b) => completedSortTime(b) - completedSortTime(a))
      }
      return list
    }

    return activeTab === 'pending_payment' ? visibleOrders : sortOrdersForTab(visibleOrders)
  }, [user, dashboardRestaurantId, activeTab, mergedSourceOrders, shouldDisplayOrder, isRecentCardPendingOrder])

  const terminalPendingFromOrders = useMemo(
    () => orders.filter((o) => o.payment_status === 'terminal_pending').map((o) => o.id),
    [orders]
  )

  const terminalPollingOrderIds = useMemo(
    () => terminalPendingFromOrders.filter((id) => !terminalDismissedPollingIds.includes(id)),
    [terminalPendingFromOrders, terminalDismissedPollingIds]
  )

  const groupedOrders = useMemo(() => {
    const kiosk = orders.filter((o) => String(o.channel || '') === 'kiosk')
    const table = orders.filter((o) => String(o.channel || '') !== 'kiosk')
    return [...kiosk, ...table]
  }, [orders])

  const refreshPendingHostedCount = useCallback(async () => {
    if (!dashboardRestaurantId || !orderScope) return
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('restaurant_id', orderScope.restaurantId)
      .eq('payment_status', 'pending')
      .eq('payment_channel', 'hosted')
      .eq('is_closed', false)
    setPendingHostedCount(count ?? 0)
  }, [dashboardRestaurantId, orderScope])

  const cancelAndFreeHostedOrder = async (orderId: string) => {
    if (!dashboardRestaurantId) return
    try {
      setCancellingHostedOrderId(orderId)
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          payment_status: 'cancelled',
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to cancel order')
      toast({
        title: 'Order cancelled',
        description: 'Checkout was cleared — staff can track new orders as usual.',
      })
      await refreshPendingHostedCount()
    } catch (e: unknown) {
      toast({
        title: 'Cancel failed',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setCancellingHostedOrderId(null)
    }
  }

  const minutesSincePlaced = (order: Order) => {
    const d = toDate(order.placed_at) || toDate((order as Order & { created_at?: unknown }).created_at)
    if (!d) return 0
    return Math.max(0, Math.floor((nowMs - d.getTime()) / 60_000))
  }

  const isStatusUpdating = (orderId: string, action: string) =>
    statusUpdateKey === orderActionKey(orderId, action)

  const isOrderStatusBusy = (orderId: string) =>
    Boolean(statusUpdateKey?.startsWith(`${orderId}:`))

  const handleSaveRequestReview = async (requestId: string, items: Record<string, any>[]) => {
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to save review')
      setOrderRequests((prev) =>
        prev.map((request) => (request.id === requestId ? { ...request, ...data.request } : request)),
      )
      toast({ title: 'Review saved' })
    } catch (error: any) {
      toast({
        title: 'Failed to save review',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleAcceptRequest = async (requestId: string) => {
    if (requestActionKey) return
    setRequestActionKey(orderActionKey(requestId, 'accept'))
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to accept order')
      /**
        #SOUND. Accepting creates an `orders` row, which arrives back over realtime as an INSERT
        at status 'pending'. Keying both events to one identity already silences it whenever this
        dashboard chimed for the request -- but NOT when the request was already on screen at page
        load, which is the ordinary case: staff arrive, see something waiting, and accept it.
        Without this, their own click would chime at them.
      */
      suppressOrderAlert({ requestId, orderId: data?.orderId ?? null })
      setOrderRequests((prev) => prev.filter((request) => request.id !== requestId))
      toast({ title: 'Order accepted', description: 'It now appears in New Orders.' })
    } catch (error: any) {
      toast({
        title: 'Failed to accept order',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setRequestActionKey(null)
    }
  }

  const openDeclineDialog = (requestId: string) => {
    setDeclineTargetRequestId(requestId)
    setDeclineReason('')
    setShowDeclineDialog(true)
  }

  const handleDeclineRequest = async () => {
    const requestId = declineTargetRequestId
    if (!requestId || requestActionKey) return
    setRequestActionKey(orderActionKey(requestId, 'decline'))
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason.trim() || null }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to decline order')
      setOrderRequests((prev) => prev.filter((request) => request.id !== requestId))
      setShowDeclineDialog(false)
      setDeclineTargetRequestId(null)
      toast({ title: 'Order declined' })
    } catch (error: any) {
      toast({
        title: 'Failed to decline order',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setRequestActionKey(null)
    }
  }

  const handleStatusUpdate = async (orderId: string, newStatus: OrderStatus) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }

    const actionKey = orderActionKey(orderId, newStatus)
    if (statusUpdateKey) return

    setStatusUpdateKey(actionKey)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to update order status')
      }
      const timestampField = `${newStatus}_at`
      setAllOrders((prev) =>
        prev.map((order) =>
          order.id === orderId
            ? { ...order, status: newStatus, [timestampField]: new Date().toISOString() }
            : order
        )
      )
      toast({
        title: 'Order updated',
        description: `Order status changed to ${newStatus}`,
      })
    } catch (error: any) {
      console.error(error)
      toast({
        title: 'Update failed',
        description: error.message || 'Failed to update order status',
        variant: 'destructive',
      })
    } finally {
      setStatusUpdateKey(null)
    }
  }

  const closeMarkPaidDialog = useCallback(() => {
    setShowMarkPaidDialog(false)
    setMarkPaidTargetOrderId(null)
  }, [])

  const applyPaidLocally = useCallback((orderId: string, paidAt: string) => {
    const paidPatch = { payment_status: 'paid', paid_at: paidAt }
    setAllOrders((list) =>
      list.map((order) => (order.id === orderId ? { ...order, ...paidPatch } : order))
    )
  }, [])

  const handleMarkAsPaid = async (orderId: string) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }

    if (markingPaidOrderId) return

    const previousOrder = orders.find((order) => order.id === orderId)
    setMarkingPaidOrderId(orderId)

    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: 'paid' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to mark as paid')
      }

      const paidAt = String(data?.order?.paid_at || new Date().toISOString())
      applyPaidLocally(orderId, paidAt)
      closeMarkPaidDialog()

      void markFirstPaymentSetupComplete()

      toast({
        title: 'Payment recorded',
        description: 'Order has been marked as paid',
      })
    } catch (error: any) {
      if (previousOrder) {
        const revertPatch = {
          payment_status: previousOrder.payment_status,
          paid_at: (previousOrder as Order & { paid_at?: string | null }).paid_at ?? null,
        }
        const revert = (list: Order[]) =>
          list.map((order) => (order.id === orderId ? { ...order, ...revertPatch } : order))
        setAllOrders(revert)
      }

      console.error(error)
      toast({
        title: 'Failed to mark as paid',
        description: error.message || 'Failed to update payment status',
        variant: 'destructive',
      })
    } finally {
      setMarkingPaidOrderId(null)
    }
  }

  const openEmailReceiptDialog = (orderId: string) => {
    setEmailReceiptTargetOrderId(orderId)
    setEmailReceiptAddress('')
    setShowEmailReceiptDialog(true)
  }

  const closeEmailReceiptDialog = () => {
    setShowEmailReceiptDialog(false)
    setEmailReceiptTargetOrderId(null)
    setEmailReceiptAddress('')
  }

  const handleSendReceiptEmail = async () => {
    const orderId = emailReceiptTargetOrderId
    const email = emailReceiptAddress.trim()
    if (!orderId || !email) return
    if (sendingReceiptEmailOrderId) return

    setSendingReceiptEmailOrderId(orderId)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/receipt/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to send receipt email')
      }

      closeEmailReceiptDialog()
      toast({
        title: 'Receipt emailed',
        description: `Sent to ${email}`,
      })
    } catch (error: any) {
      console.error(error)
      toast({
        title: 'Failed to email receipt',
        description: error.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSendingReceiptEmailOrderId(null)
    }
  }

  // "Print from this computer" -- renders the receipt in a new tab and calls window.print()
  // there. Deliberately separate from the terminal's own Bluetooth/built-in printer flow,
  // which prints from the terminal device itself, not the manager's machine.
  const handlePrintReceipt = async (orderId: string) => {
    if (printingReceiptOrderId) return
    setPrintingReceiptOrderId(orderId)
    // Open synchronously, before the await below -- opening after an async gap can lose
    // the user-activation flag and get silently popup-blocked in some browsers.
    const printWindow = window.open('', '_blank')
    try {
      if (!printWindow) {
        throw new Error('Pop-up blocked -- allow pop-ups to print receipts from this computer')
      }

      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/receipt`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load receipt')
      }

      printWindow.document.open()
      printWindow.document.write(String(data.html || ''))
      printWindow.document.close()
      printWindow.focus()
      printWindow.onload = () => {
        printWindow.print()
      }
    } catch (error: any) {
      printWindow?.close()
      console.error(error)
      toast({
        title: 'Failed to print receipt',
        description: error.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setPrintingReceiptOrderId(null)
    }
  }

  const handleSendToTerminal = async (order: Order, bypassReadyCheck = false) => {
    if (!dashboardRestaurantId) return
    if (sendingToTerminalOrderId === order.id) return
    try {
      setSendingToTerminalOrderId(order.id)
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: 'pending' }))
      const token = await getAccessToken()
      const response = await fetch('/api/payments/push-to-terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId: order.id,
          tableNumber: order.table_number,
          orderNumber: order.order_number,
          bypassReadyCheck,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to send payment to terminal')
      }
      toast({ title: 'Payment sent to terminal' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Please try again.'
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: 'failed' }))
      toast({
        title: 'Failed to send to terminal',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSendingToTerminalOrderId(null)
    }
  }

  const handleCancelTerminalPayment = async (order: Order) => {
    if (!dashboardRestaurantId) return
    try {
      setCancelingTerminalOrderId(order.id)
      const token = await getAccessToken()
      const response = await fetch('/api/payments/cancel-terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderId: order.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to cancel terminal payment')
      }
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: null }))
      toast({
        title: 'Terminal payment cancelled',
        description: 'Order reverted to cash pending.',
      })
    } catch (error: any) {
      toast({
        title: 'Cancel failed',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setCancelingTerminalOrderId(null)
    }
  }

  useEffect(() => {
    if (!dashboardRestaurantId || terminalPollingOrderIds.length === 0) return
    const timer = setInterval(async () => {
      const doneIds: string[] = []
      try {
        // Single batched request for all pending-terminal-payment orders instead of one
        // round trip per order -- was previously N sequential .eq('id', orderId).single()
        // calls in a for loop every 5s.
        const { data } = await supabase
          .from('orders')
          .select('id,payment_status,order_number,terminal_status')
          .in('id', terminalPollingOrderIds)
        const rows = (data || []) as any[]
        const rowsById = new Map(rows.map((row) => [String(row.id), row]))

        for (const orderId of terminalPollingOrderIds) {
          const orderRow = rowsById.get(orderId) || null
          const status = String(orderRow?.payment_status || '').toLowerCase()
          const terminalStatus = String(orderRow?.terminal_status || '').toLowerCase()
          if (status === 'paid') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: null }))
            void markFirstPaymentSetupComplete()
            toast({
              title: 'Payment confirmed',
              description: `Order #${orderRow?.order_number || orderId.slice(-6)} was paid on terminal.`,
            })
          } else if (terminalStatus === 'failed') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: 'failed' }))
            toast({
              title: 'Terminal payment failed',
              description: `Order #${orderRow?.order_number || orderId.slice(-6)} failed on the terminal. You can retry.`,
              variant: 'destructive',
            })
          } else if (status !== 'terminal_pending') {
            doneIds.push(orderId)
          }
        }
      } catch (e) {
        // keep polling on transient failures
      }
      if (doneIds.length > 0) {
        setTerminalDismissedPollingIds((prev) => Array.from(new Set([...prev, ...doneIds])))
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [dashboardRestaurantId, terminalPollingOrderIds, toast])

  /**
   * STEP 4: Close Table functionality
   * 
   * Staff action to close a table session:
   * - Updates table_sessions/{id} status to "closed"
   * - Sets closed_at timestamp
   * - Once closed: Customer banner disappears, orders remain for audit
   * - Next QR scan creates a NEW session
   */
  const handleCloseTable = async (tableNumber: number) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Error',
        description: 'Unable to close table. Missing restaurant ID.',
        variant: 'destructive',
      })
      return
    }

    const tableNum = Number(tableNumber)
    if (isNaN(tableNum) || tableNum <= 0) {
      toast({
        title: 'Invalid table number',
        description: `Table number ${tableNumber} is invalid.`,
        variant: 'destructive',
      })
      return
    }

    if (closingTableNumber !== null) return

    setClosingTableNumber(tableNum)
    try {
      if (!orderScope) {
        throw new Error('Restaurant scope not loaded')
      }
      const { data: openOrders, error: countError } = await supabase
        .from('orders')
        .select('id')
        .eq('restaurant_id', orderScope.restaurantId)
        .eq('table_number', tableNum)
        .eq('is_closed', false)
      if (countError) throw countError

      const response = await fetch(`/api/tables/${encodeURIComponent(String(tableNum))}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: dashboardRestaurantId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
          /**
           * #120's RESIDUAL — the escape hatch, offered only where it applies.
           *
           * The close route answers 409 PENDING_ORDER_REQUESTS with a `pending_requests` array
           * carrying a STATUS per row. Only `accepting` rows may be released: they are the
           * transient claim the accept route takes, and a dead worker can strand one forever
           * (#215 — no reaper is possible until the claim records a timestamp).
           *
           * A `waiting_review` row is a REAL round a customer placed. Offering to release one
           * would let staff dismiss it, which is #120's own bug from the other side — so the
           * button appears only when a stranded claim is actually present.
           */
          const stranded = Array.isArray(data?.pending_requests)
            ? (data.pending_requests as Array<{ id?: unknown; status?: unknown }>).filter(
                (r) => String(r?.status ?? '') === 'accepting',
              )
            : []
          if (stranded.length > 0) {
            setStrandedClaimIds(stranded.map((r) => String(r.id)))
            setStrandedTableNumber(tableNum)
          }
        throw new Error(data?.error || 'Failed to close table')
      }

      toast({
        title: 'Table closed',
        description: `Table ${tableNum} closed. ${openOrders?.length || 0} order(s) completed.`,
      })

      setShowCloseTableDialog(false)
      setCloseTableTargetNumber(null)
    } catch (error: any) {
      console.error(error)

      toast({
        title: 'Failed to close table',
        description: error.message || 'Failed to close table.',
        variant: 'destructive',
      })
    } finally {
      setClosingTableNumber(null)
    }
  }

  /**
   * #120's RESIDUAL — release every stranded claim blocking this table, then let staff retry the
   * close. One button for all of them: staff care about the table, not the row ids, and a claim
   * stranded by a dead worker has no per-row decision to make.
   *
   * Each release is independently conditional server-side, so a claim the accept route finishes
   * releasing mid-loop answers ALREADY_RESOLVED and is counted as resolved rather than failed —
   * the row is no longer stranded either way, which is the outcome staff wanted.
   */
  const releaseStrandedClaims = async () => {
    if (releasingClaims || strandedClaimIds.length === 0) return
    setReleasingClaims(true)
    let resolved = 0
    let failed = 0
    try {
      for (const id of strandedClaimIds) {
        try {
          const res = await fetch(`/api/order-requests/${encodeURIComponent(id)}/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restaurantId: dashboardRestaurantId }),
          })
          const body = await res.json().catch(() => ({}) as Record<string, unknown>)
          if (res.ok || (body as { code?: string }).code === 'ALREADY_RESOLVED') resolved += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      toast({
        title: failed === 0 ? 'Stuck requests released' : 'Some requests could not be released',
        description:
          failed === 0
            ? `${resolved} request(s) are back in the review list. Table ${strandedTableNumber} can be closed now.`
            : `${resolved} released, ${failed} could not be. Refresh and try again.`,
        variant: failed === 0 ? undefined : 'destructive',
      })
      if (failed === 0) {
        setStrandedClaimIds([])
        setStrandedTableNumber(null)
      }
    } finally {
      setReleasingClaims(false)
    }
  }

  const getPaymentMethodIcon = (method: Order['payment_method']) => {
    switch (method) {
      case 'cash':
        return <Banknote className="h-4 w-4" />
      case 'card':
        return <CreditCard className="h-4 w-4" />
      default:
        return <DollarSign className="h-4 w-4" />
    }
  }

  const getPaymentMethodLabel = (order: Order) => {
    if (paymentChannelOf(order) === 'terminal') return 'Card Terminal'
    if (isTabOrder(order) && !paymentChannelOf(order)) return 'Tab'
    return String(order.payment_method || 'cash').replace(/_/g, ' ')
  }

  const getPaymentChannelBadge = (order: Order) => {
    const ch = paymentChannelOf(order)
    const tabStatus = String((order as Order & { tab_status?: string | null }).tab_status || '')

    // Tab orders: payment method is chosen at Ready to Pay, not when items are added
    if (isTabOrder(order) && tabStatus !== 'ready_to_pay') {
      return null
    }

    // Tab line items have no payment channel until the tab is settled — TAB badge is shown separately
    if (isTabOrder(order) && !ch) {
      return null
    }

    // Finatic hosted checkout only (never infer "online" from payment_method alone)
    if (ch === 'hosted') {
      return <Badge className="bg-blue-600 text-white font-semibold text-xs px-2.5 py-0.5">ONLINE</Badge>
    }
    if (ch === 'cash' || (order.payment_method === 'cash' && !ch)) {
      return <Badge className="bg-green-600 text-white font-semibold text-xs px-2.5 py-0.5">CASH</Badge>
    }
    if (ch === 'card_manual' || ch === 'terminal') {
      return <Badge className="bg-orange-500 text-white font-semibold text-xs px-2.5 py-0.5">CARD</Badge>
    }
    if (ch === 'other' || order.payment_method === 'other') {
      return <Badge className="bg-gray-500 text-white font-semibold text-xs px-2.5 py-0.5">OTHER</Badge>
    }
    if (order.payment_method === 'cash') {
      return <Badge className="bg-green-600 text-white font-semibold text-xs px-2.5 py-0.5">CASH</Badge>
    }
    return null
  }

  const getPaymentStatusBadge = (order: Order) => {
    if (String(order.payment_status || '').toLowerCase() === 'cancelled') {
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          Cancelled
        </Badge>
      )
    }
    if (order.payment_status === 'paid') {
      return (
        <Badge className="bg-green-500 text-white">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Paid
        </Badge>
      )
    }
    if (order.payment_status === 'terminal_pending') {
      return (
        <Badge className="bg-amber-500 text-white">
          <Clock className="h-3 w-3 mr-1" />
          Terminal Payment Pending
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="border-yellow-500 text-yellow-700 bg-yellow-50">
        <Clock className="h-3 w-3 mr-1" />
        Pending
      </Badge>
    )
  }

  const getTerminalStatus = (order: Order): TerminalStatus => {
    const local = terminalStatusByOrderId[order.id]
    if (local) return local
    const raw = String((order as Order & { terminal_status?: string | null }).terminal_status || '').toLowerCase()
    if (raw === 'pending' || raw === 'failed') return raw
    if (order.payment_status === 'terminal_pending') return 'pending'
    return null
  }

  const formatTimeAgo = (timestamp: any) => {
    if (!timestamp) return 'Just now'
    
    // Handle Firestore Timestamp objects
    let date: Date
    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate()
    } else if (timestamp instanceof Date) {
      date = timestamp
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp)
    } else if (typeof timestamp === 'number') {
      date = new Date(timestamp)
    } else {
      return 'Just now'
    }
    
    // Validate the date
    if (isNaN(date.getTime())) {
      return 'Just now'
    }
    
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    
    // Handle negative differences (future dates)
    if (diffMs < 0) return 'Just now'
    
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays}d ago`
  }

  const getStatusColor = (status: OrderStatus) => {
    switch (status) {
      case 'pending':
        return 'border-red-500'
      case 'accepted':
        return 'border-blue-500'
      case 'preparing':
        return 'border-orange-500'
      case 'ready':
        return 'border-green-500'
      case 'ready_for_terminal':
        return 'border-orange-600'
      case 'completed':
        return 'border-gray-300'
      case 'cancelled':
        return 'border-red-300'
      default:
        return 'border-border'
    }
  }

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'pending':
        return <Badge variant="destructive">New</Badge>
      case 'accepted':
        return <Badge className="bg-blue-500">Accepted</Badge>
      case 'preparing':
        return <Badge className="bg-orange-500">Preparing</Badge>
      case 'ready':
        return <Badge className="bg-green-500">Ready</Badge>
      case 'ready_for_terminal':
        return (
          <Badge className="bg-gradient-to-r from-orange-600 to-red-600 text-white border-0">READY FOR TERMINAL</Badge>
        )
      case 'completed':
        return <Badge variant="secondary">Completed</Badge>
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  if (showDashboardLoading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div
      className="min-h-screen bg-muted/30"
      onPointerDown={unlockNewOrderSound}
    >
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/dashboard')}
              className="h-11 w-11"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">Live Orders</h1>
            <OrderAlertIndicator />
            <FeedConnectionIndicator />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              // One refetch path (#350): the manual button, the reconnect handlers, the poll and
              // `visibilitychange` all go through `refreshOpenOrders`. The spinner is this
              // caller's alone -- a staff member who pressed a button is owed visible feedback.
              void refreshOpenOrders({ showSpinner: true })
            }}
          >
            <RefreshCw className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-card border-b border-border">
        <div className="container mx-auto px-6">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const count = tabCounts[tab.id] ?? 0
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'relative px-4 py-3 font-medium border-b-2 transition-colors whitespace-nowrap',
                    activeTab === tab.id
                      ? 'border-[#FF6B35] text-[#FF6B35]'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label} {count > 0 && `(${count})`}
                  {tab.id === 'pending_payment' && pendingHostedCount > 0 && (
                    <span className="absolute -top-1 -right-1 bg-yellow-500 text-white text-xs rounded-full min-w-[1rem] h-4 px-1 flex items-center justify-center">
                      {pendingHostedCount > 99 ? '99+' : pendingHostedCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="container mx-auto px-6 py-6">
        {activeTab === 'waiting_review' ? (
          orderRequests.length === 0 ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <div className="max-w-md mx-auto">
                <div className="text-6xl mb-4">🕒</div>
                <h3 className="text-xl font-semibold mb-2">No requests waiting for review</h3>
                <p className="text-muted-foreground">
                  New table and kiosk order requests will appear here first.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 max-w-3xl">
              {/*
                THE QUEUE-LEVEL COUNT. A per-card marker only helps someone already looking at that
                card; this says how many are overdue before anyone scrolls — the half that was
                missing when a request sat unanswered for 477 hours.
              */}
              {overdueRequestCount > 0 && (
                <div
                  data-testid="overdue-requests-banner"
                  className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
                >
                  {overdueRequestCount === 1
                    ? `1 request has been waiting more than ${Math.round(STALE_REQUEST_THRESHOLD_MS / 60000)} minutes with no answer. It is at the top of this list.`
                    : `${overdueRequestCount} requests have been waiting more than ${Math.round(STALE_REQUEST_THRESHOLD_MS / 60000)} minutes with no answer. They are at the top of this list.`}
                </div>
              )}
              {rankedOrderRequests.map((request) => (
                <OrderRequestCard
                  key={request.id}
                  request={request}
                  currency={restaurant?.currency || 'N$'}
                  timeAgoLabel={formatTimeAgo(request.placed_at)}
                  nowMs={nowMs}
                  busy={requestActionKey?.startsWith(`${request.id}:`) ?? false}
                  onSaveReview={handleSaveRequestReview}
                  onAccept={handleAcceptRequest}
                  onDecline={openDeclineDialog}
                />
              ))}
            </div>
          )
        ) : activeTab === 'pending_payment' ? (
          orders.length === 0 ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <div className="max-w-md mx-auto">
                <div className="text-6xl mb-4">💳</div>
                <h3 className="text-xl font-semibold mb-2">No pending online checkouts</h3>
                <p className="text-muted-foreground">
                  Customers who open Finatic but don&apos;t pay within 10 minutes are expired automatically.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 max-w-3xl">
              {orders.map((order) => {
                const items = Array.isArray(order.items) ? order.items : []
                const line = items
                  .map((item: { quantity?: number; name?: string; display_name?: string }) => {
                    const q = item?.quantity ?? 1
                    const n = item?.display_name || item?.name || 'Item'
                    return `${q}× ${n}`
                  })
                  .join(', ')
                return (
                  <div
                    key={order.id}
                    className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 text-left"
                  >
                    <div className="flex justify-between items-start gap-3 mb-2">
                      <div>
                        <span className="font-bold text-foreground">Table {order.table_number ?? '—'}</span>
                        <Badge className="ml-2 bg-yellow-500 text-white border-0">Awaiting Payment</Badge>
                        <p className="text-yellow-800 text-sm mt-1 font-sans">
                          Awaiting payment for {minutesSincePlaced(order)} min
                          {minutesSincePlaced(order) === 1 ? '' : 's'}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-red-500 text-white hover:bg-red-600 shrink-0"
                        disabled={cancellingHostedOrderId === order.id}
                        onClick={() => void cancelAndFreeHostedOrder(order.id)}
                      >
                        <ActionButtonContent
                          loading={cancellingHostedOrderId === order.id}
                          label="Cancel & Free Table"
                          loadingLabel="Cancelling…"
                        />
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground font-sans line-clamp-3">
                      {line || 'No line items'}
                    </p>
                    <p className="font-bold mt-2 font-sans text-foreground">
                      {restaurant?.currency || 'N$'}
                      {(Number(order.total) || 0).toFixed(2)}
                    </p>
                  </div>
                )
              })}
            </div>
          )
        ) : orders.length === 0 ? (
          <div className="text-center py-12 bg-card border rounded-lg">
            <div className="max-w-md mx-auto">
              <div className="text-6xl mb-4">📋</div>
              <h3 className="text-xl font-semibold mb-2">No {activeTab} orders</h3>
              <p className="text-muted-foreground">
                {activeTab === 'new' 
                  ? 'New orders will appear here when customers place them.'
                  : `No ${activeTab} orders at the moment.`
                }
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {groupedOrders.map((order, index, arr) => {
              const prevOrder = index > 0 ? arr[index - 1] : null
              const isKioskOrder = String(order.channel || '') === 'kiosk'
              const showKioskHeader =
                isKioskOrder && (index === 0 || String(prevOrder?.channel || '') !== 'kiosk')
              const showTableHeader =
                !isKioskOrder && prevOrder != null && String(prevOrder.channel || '') === 'kiosk'
              // DEFENSIVE NORMALIZATION: Ensure items is always an array before rendering
              // This prevents "Cannot read property 'length' of undefined" errors
              const tabInfo = tabIdOf(order) ? tabInfoById[tabIdOf(order)] : null
              const memberNameMap: Record<string, string> = {}
              tabInfo?.members?.forEach((m: any) => {
                if (m?.session_id) {
                  memberNameMap[String(m.session_id)] = String(m.display_name || '').trim() || 'Guest'
                }
              })
              const memberSessionId = String(
                (order as Order & { member_session_id?: string | null }).member_session_id || ''
              ).trim()
              /**
               * ANNOTATED `Order` ON PURPOSE — this is not decoration, it is 18 of this file's 22
               * type errors.
               *
               * `Order` is `Record<string, any> & { id; status; ... }`. Spreading a value of that
               * type into an object literal DROPS the index signature: TypeScript infers only the
               * named members plus what the literal adds. So without this annotation every access
               * to a column `Order` does not name by hand -- `order_number`, `channel`,
               * `table_number`, `tab_id`, `kiosk_order_number`, `customer_name`,
               * `order_instructions`, `table_session_id` -- is a TS2339, even though `order` itself
               * accepts all of them one line above. Runtime is identical either way; the object
               * really does carry those columns, which is why the screen renders them.
               */
              const normalizedOrder: Order = {
                ...order,
                items: Array.isArray(order.items) ? order.items : [],
                customer: order.customer || {},
                tab_status: tabInfo?.status ?? null,
                tab_ready_to_pay: tabInfo?.status === 'ready_to_pay',
                tab_payment_preference: tabInfo?.payment_preference ?? null,
              }

              const customerReadyToPay =
                order.customer_ready_to_pay === true ||
                tabInfo?.status === 'ready_to_pay'

              return (
              <Fragment key={order.id}>
                {showKioskHeader && (
                  <div className="col-span-full">
                    <h3 className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-1 px-1">
                      Kiosk Orders
                    </h3>
                  </div>
                )}
                {showTableHeader && (
                  <div className="col-span-full mt-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 px-1">
                      Table Orders
                    </h3>
                  </div>
                )}
              <div
                key={order.id}
                className={cn(
                  'bg-card border-2 rounded-lg p-6 space-y-4',
                  getStatusColor(order.status as OrderStatus),
                  customerReadyToPay && 'order-card-ready-to-pay'
                )}
              >
                {/* Order Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg font-bold">#{normalizedOrder.order_number || 'N/A'}</span>
                    {normalizedOrder.channel === 'kiosk' ? (
                      <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                        🖥 Kiosk
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Table {normalizedOrder.table_number || 0}</Badge>
                    )}
                    {normalizedOrder.tab_id && (
                      <Badge className="bg-purple-600 text-white">
                        TAB {String(normalizedOrder.tab_id).slice(-6)}
                      </Badge>
                    )}
                    {getStatusBadge(normalizedOrder.status as OrderStatus)}
                    {getPaymentChannelBadge(normalizedOrder)}
                    {getPaymentStatusBadge(normalizedOrder)}
                    <OrderEditBadges order={normalizedOrder} nowMs={nowMs} />
                    {/* Unpaid tab elsewhere (#211 follow-up). FLAG, never a block: staff are
                        told, nothing is prevented, and the customer never sees it. Renders only
                        while the LINKED tab is still unpaid, which is how it clears on settle
                        without anything writing to the settle path. */}
                    {(() => {
                      const linkedId = tabIdOf(order) ? tabInfoById[tabIdOf(order)]?.linked_unpaid_tab_id : null
                      const linked = linkedId ? unpaidTabElsewhere[linkedId] : null
                      if (!linked) return null
                      return (
                        <Badge className="border-0 bg-amber-600 text-white">
                          {TAB_FLAG_COPY.unpaidTabElsewhere
                            .replace('{table}', String(linked.table_number ?? '?'))
                            .replace(
                              '{total}',
                              `${restaurant?.currency || 'N$'}${linked.payable.toFixed(2)}` +
                                (linked.pending > 0
                                  ? ` + ${restaurant?.currency || 'N$'}${linked.pending.toFixed(2)} ${TAB_FLAG_COPY.unpaidTabElsewherePendingSuffix}`
                                  : ''),
                            )}
                        </Badge>
                      )
                    })()}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    {formatTimeAgo(normalizedOrder.placed_at)}
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-lg font-bold">
                    {restaurant?.currency || 'N$'}{(normalizedOrder.total ?? 0).toFixed(2)}
                  </span>
                  {/* What the total was before the customer changed it, and by how much. Sits
                      beside the figure staff act on, not in a detail panel they would have to
                      open to discover the number moved. */}
                  <OrderEditTotalDelta
                    order={normalizedOrder}
                    currency={restaurant?.currency || 'N$'}
                  />
                  {normalizedOrder.tab_status === 'ready_to_pay' && normalizedOrder.tab_payment_preference && (
                    <div className="flex items-center justify-end gap-1.5 mt-1">
                      <span className="text-sm">
                        {normalizedOrder.tab_payment_preference === 'cash'
                          ? '💵'
                          : normalizedOrder.tab_payment_preference === 'other'
                            ? '🤝'
                            : '💳'}
                      </span>
                      <span className="text-xs font-medium text-muted-foreground font-sans">
                        {normalizedOrder.tab_payment_preference === 'cash'
                          ? 'Cash'
                          : normalizedOrder.tab_payment_preference === 'card'
                            ? 'Card'
                            : 'Other'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Order Items - DEFENSIVE: Use normalizedOrder.items which is guaranteed to be an array */}
                <div className="space-y-2 border-t pt-3">
                  {normalizedOrder.channel === 'kiosk' && (
                    <div className="flex items-center gap-2 mb-2">
                      {normalizedOrder.kiosk_order_number && (
                        <span className="text-sm font-bold text-purple-700">
                          K-{String(normalizedOrder.kiosk_order_number).padStart(3, '0')}
                        </span>
                      )}
                      {normalizedOrder.customer_name && (
                        <>
                          <span className="text-gray-400">—</span>
                          <span className="text-sm font-medium">👤 {normalizedOrder.customer_name}</span>
                        </>
                      )}
                    </div>
                  )}
                  {memberSessionId && memberNameMap[memberSessionId] && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="text-sm">👤</span>
                      <span className="text-sm font-medium text-foreground font-sans">
                        {memberNameMap[memberSessionId]}
                      </span>
                    </div>
                  )}
                  {normalizedOrder.items.length > 0 ? (
                    normalizedOrder.items.map((item: any, index: number) => (
                      <div key={index} className="text-sm">
                        <span className="font-medium">
                          {item?.quantity ?? 1}× {item?.display_name || item?.name || 'Unknown Item'}
                        </span>
                        {item?.selected_variants && typeof item.selected_variants === 'object' && (
                          <span className="text-muted-foreground ml-2">
                            {Object.values(item.selected_variants).filter(Boolean).join(' / ')}
                          </span>
                        )}
                        {item?.selected_size?.name && (
                          <span className="text-muted-foreground ml-2">
                            ({item.selected_size.name})
                          </span>
                        )}
                        {Array.isArray(item?.selected_addons) && item.selected_addons.length > 0 && (
                          <span className="text-muted-foreground ml-2">
                            +{item.selected_addons.map((a: any) => a?.name ?? '').filter(Boolean).join(', ')}
                          </span>
                        )}
                        {item?.special_instructions && (
                          <div className="text-xs text-muted-foreground italic mt-1 break-words">
                            &ldquo;{item.special_instructions}&rdquo;
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground italic">
                      No items in this order
                    </div>
                  )}
                </div>

                {/* Order Instructions */}
                {normalizedOrder.order_instructions && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                    <p className="text-sm text-yellow-900 font-medium">Order Instructions:</p>
                    {/* Rows written before the client cap can be any length, and an unbroken
                        run of characters would otherwise push the card sideways. */}
                    <p className="text-sm text-yellow-800 break-words">{normalizedOrder.order_instructions}</p>
                  </div>
                )}

                {/* Table Session Info */}
                {normalizedOrder.table_session_id && (
                  <div className="text-sm text-muted-foreground">
                    Session: {normalizedOrder.table_session_id.slice(0, 12)}...
                  </div>
                )}

                {customerReadyToPay && (
                  <div
                    className="w-full rounded-md bg-amber-500 px-4 py-3 text-center text-sm font-bold text-white shadow-sm"
                    role="status"
                    aria-live="polite"
                  >
                    🔔 Customer is ready to pay
                  </div>
                )}

                {/* Close Table Button - Only show for staff */}
                {normalizedOrder.table_number && (
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setCloseTableTargetNumber(normalizedOrder.table_number)
                        setShowCloseTableDialog(true)
                      }}
                      disabled={closingTableNumber === normalizedOrder.table_number}
                    >
                      <ActionButtonContent
                        loading={closingTableNumber === normalizedOrder.table_number}
                        icon={DoorClosed}
                        label="Close Table"
                        loadingLabel="Closing..."
                      />
                    </Button>
                  </div>
                )}

                {/* Manual payment: mark paid for cash and card at table */}
                {canMarkManualPaid(normalizedOrder) && !isOrderPaid(normalizedOrder) && (
                    <div className="pt-2 space-y-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setMarkPaidTargetOrderId(normalizedOrder.id)
                          setShowMarkPaidDialog(true)
                        }}
                        disabled={markingPaidOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={markingPaidOrderId === normalizedOrder.id}
                          icon={DollarSign}
                          label="Mark as Paid"
                          loadingLabel="Marking as Paid..."
                        />
                      </Button>
                    </div>
                  )}

                {/* Card + physical terminal (Finatic): wait for customer, then push */}
                {normalizedOrder.payment_method === 'card' &&
                  paymentChannelOf(normalizedOrder) === 'terminal' &&
                  normalizedOrder.payment_status === 'pending' && (
                    <div className="pt-2 space-y-2">
                      {getTerminalStatus(normalizedOrder) === 'failed' && (
                        <div className="bg-red-100 text-red-700 px-3 py-1 rounded text-sm font-medium">
                          Payment Failed - Retry
                        </div>
                      )}
                      {getTerminalStatus(normalizedOrder) === 'pending' && (
                        <div className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded text-sm font-medium inline-flex items-center gap-2">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Awaiting Payment...
                        </div>
                      )}
                      {(() => {
                        const readyAt = Boolean(
                          (normalizedOrder as Order & { ready_for_terminal_at?: unknown })
                            .ready_for_terminal_at
                        )
                        const ready =
                          normalizedOrder.status === 'ready_for_terminal' || readyAt
                        const canSendToTerminal =
                          ready || paymentChannelOf(normalizedOrder) === 'terminal'
                        const isSending = sendingToTerminalOrderId === normalizedOrder.id
                        return (
                          <>
                            {!ready && (
                              <p className="text-sm text-muted-foreground font-sans">
                                Waiting for customer to request terminal
                              </p>
                            )}
                            <Button
                              className="w-full bg-[#FF6B35] hover:bg-[#e55a28] disabled:opacity-50 disabled:pointer-events-none"
                              onClick={() => handleSendToTerminal(normalizedOrder)}
                              disabled={isSending || !canSendToTerminal || getTerminalStatus(normalizedOrder) === 'pending'}
                            >
                              <ActionButtonContent
                                loading={isSending}
                                icon={CreditCard}
                                label="Send to Terminal"
                                loadingLabel="Sending to terminal..."
                              />
                            </Button>
                            {!ready && (
                              <Button
                                variant="ghost"
                                className="h-auto w-full p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                                onClick={() => handleSendToTerminal(normalizedOrder, true)}
                                disabled={isSending}
                              >
                                {isSending ? (
                                  <span className="inline-flex items-center gap-2 py-1">
                                    <ButtonSpinner />
                                    Sending...
                                  </span>
                                ) : (
                                  'Send Anyway'
                                )}
                              </Button>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}

                {/* After a successful push, payment_status is terminal_pending (canonical
                    value since push-to-terminal was introduced). Failure feedback must live
                    here — gating only on payment_status === 'pending' misses this state. */}
                {normalizedOrder.payment_status === 'terminal_pending' && (
                  <div className="pt-2 space-y-2">
                    {getTerminalStatus(normalizedOrder) === 'failed' ? (
                      <>
                        <div className="bg-red-100 text-red-700 px-3 py-1 rounded text-sm font-medium">
                          Payment Failed - Retry
                        </div>
                        <Button
                          className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
                          onClick={() => handleSendToTerminal(normalizedOrder, true)}
                          disabled={sendingToTerminalOrderId === normalizedOrder.id}
                        >
                          <ActionButtonContent
                            loading={sendingToTerminalOrderId === normalizedOrder.id}
                            icon={CreditCard}
                            label="Send to Terminal"
                            loadingLabel="Sending to terminal..."
                          />
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="w-full bg-amber-600 hover:bg-amber-700"
                        disabled
                      >
                        <Clock className="h-4 w-4 mr-2" />
                        Waiting for payment...
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => handleCancelTerminalPayment(normalizedOrder)}
                      disabled={cancelingTerminalOrderId === normalizedOrder.id}
                    >
                      <ActionButtonContent
                        loading={cancelingTerminalOrderId === normalizedOrder.id}
                        label="Cancel Terminal Payment"
                        loadingLabel="Canceling terminal payment..."
                      />
                    </Button>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  {(normalizedOrder.status === 'pending' || normalizedOrder.status === 'ready_for_terminal') && (
                    <>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'cancelled')}
                        disabled={isOrderStatusBusy(normalizedOrder.id)}
                      >
                        <ActionButtonContent
                          loading={isStatusUpdating(normalizedOrder.id, 'cancelled')}
                          icon={XCircle}
                          label="Decline"
                          loadingLabel="Declining..."
                        />
                      </Button>
                      <Button
                        className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'accepted')}
                        disabled={isOrderStatusBusy(normalizedOrder.id)}
                      >
                        <ActionButtonContent
                          loading={isStatusUpdating(normalizedOrder.id, 'accepted')}
                          icon={CheckCircle2}
                          label="Accept Order"
                          loadingLabel="Accepting..."
                        />
                      </Button>
                    </>
                  )}
                  {normalizedOrder.status === 'accepted' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'preparing')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'preparing')}
                        icon={ChefHat}
                        label="Start Preparing"
                        loadingLabel="Updating..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'preparing' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'ready')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'ready')}
                        icon={ChefHat}
                        label="Mark Ready"
                        loadingLabel="Updating..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'ready' &&
                    (isOrderPaid(normalizedOrder) || isTabOrder(normalizedOrder)) && (
                    <Button
                      className="flex-1 bg-green-500 hover:bg-green-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'completed')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'completed')}
                        icon={CheckCircle2}
                        label="Complete Order"
                        loadingLabel="Completing..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'completed' && (
                    <>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => openEmailReceiptDialog(normalizedOrder.id)}
                        disabled={sendingReceiptEmailOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={sendingReceiptEmailOrderId === normalizedOrder.id}
                          icon={Mail}
                          label="Email receipt"
                          loadingLabel="Sending..."
                        />
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1"
                        title="Print from this computer -- not the terminal's Bluetooth or built-in printer"
                        onClick={() => handlePrintReceipt(normalizedOrder.id)}
                        disabled={printingReceiptOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={printingReceiptOrderId === normalizedOrder.id}
                          icon={Printer}
                          label="Print from this computer"
                          loadingLabel="Preparing..."
                        />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              </Fragment>
            )})}
          </div>
        )}
      </div>

      {/* Mark as Paid Confirmation Dialog */}
      <Dialog
        open={showMarkPaidDialog}
        onOpenChange={(open) => {
          setShowMarkPaidDialog(open)
          if (!open) {
            setMarkPaidTargetOrderId(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Order as Paid</DialogTitle>
            <DialogDescription>
              Are you sure you want to mark this order as paid? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeMarkPaidDialog}
              disabled={Boolean(markingPaidOrderId)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => {
                if (markPaidTargetOrderId) {
                  void handleMarkAsPaid(markPaidTargetOrderId)
                }
              }}
              disabled={!markPaidTargetOrderId || Boolean(markingPaidOrderId)}
            >
              <ActionButtonContent
                loading={Boolean(markingPaidOrderId)}
                label="Mark as Paid"
                loadingLabel="Marking as Paid..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline Order Request Dialog */}
      <Dialog
        open={showDeclineDialog}
        onOpenChange={(open) => {
          setShowDeclineDialog(open)
          if (!open) {
            setDeclineTargetRequestId(null)
            setDeclineReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline Order Request</DialogTitle>
            <DialogDescription>
              This request will never become an order. The customer will see the request was declined, but not this note.
            </DialogDescription>
          </DialogHeader>
          <Input
            /*
             * "shown to staff only" was not merely imprecise -- it was false about the only
             * thing it claimed. `declined_reason` is WRITE-ONLY: a repo-wide grep for it
             * returns exactly two lines, both in
             * app/api/order-requests/[requestId]/decline/route.ts (:14 reads it off the body,
             * :49 writes it), and nothing anywhere reads it back. Not a customer surface, and
             * not a staff one either. The note is stored and rendered to nobody.
             *
             * So the label now says only what is certainly true -- the customer does not see it
             * -- rather than promising a staff surface that does not exist. Whether to BUILD
             * that surface or to relabel the field as an internal note is a product decision
             * (#210); this wording is correct under either.
             */
            placeholder="Reason (optional, not shown to the customer)"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowDeclineDialog(false)}
              disabled={Boolean(requestActionKey)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={() => void handleDeclineRequest()}
              disabled={!declineTargetRequestId || Boolean(requestActionKey)}
            >
              <ActionButtonContent
                loading={Boolean(requestActionKey)}
                label="Decline Order"
                loadingLabel="Declining..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Receipt Dialog */}
      <Dialog
        open={showEmailReceiptDialog}
        onOpenChange={(open) => {
          if (!open) closeEmailReceiptDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email Receipt</DialogTitle>
            <DialogDescription>
              Enter the customer&apos;s email address to send this receipt.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="email"
            placeholder="customer@example.com"
            value={emailReceiptAddress}
            onChange={(e) => setEmailReceiptAddress(e.target.value)}
            disabled={Boolean(sendingReceiptEmailOrderId)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeEmailReceiptDialog}
              disabled={Boolean(sendingReceiptEmailOrderId)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => void handleSendReceiptEmail()}
              disabled={!emailReceiptAddress.trim() || Boolean(sendingReceiptEmailOrderId)}
            >
              <ActionButtonContent
                loading={Boolean(sendingReceiptEmailOrderId)}
                icon={Mail}
                label="Send Receipt"
                loadingLabel="Sending..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

        {/*
          #120's RESIDUAL — the escape hatch for a table that cannot be closed.

          Opens only when the close was refused AND at least one blocking row is `accepting`, the
          transient claim. Never for `waiting_review`: that is a real round a customer placed, and
          offering to dismiss one would be #120's bug from the other side.

          The wording is signed (lib/customer-copy/stranded-claim-copy.ts) and reads as a repair
          rather than a routine action, because that is what it is — see #215 for why no reaper
          can do this automatically yet.
        */}
        <Dialog
          open={strandedClaimIds.length > 0}
          onOpenChange={(open) => {
            if (!open && !releasingClaims) {
              setStrandedClaimIds([])
              setStrandedTableNumber(null)
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{STRANDED_CLAIM_COPY.releaseLabel}</DialogTitle>
              <DialogDescription>{STRANDED_CLAIM_COPY.releaseBody}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={releasingClaims}
                onClick={() => {
                  setStrandedClaimIds([])
                  setStrandedTableNumber(null)
                }}
              >
                Cancel
              </Button>
              <Button onClick={releaseStrandedClaims} disabled={releasingClaims}>
                {releasingClaims ? 'Releasing...' : STRANDED_CLAIM_COPY.releaseLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      {/* Close Table Confirmation Dialog */}
      <Dialog
        open={showCloseTableDialog}
        onOpenChange={(open) => {
          if (!open && closingTableNumber === null) {
            setShowCloseTableDialog(false)
            setCloseTableTargetNumber(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close Table</DialogTitle>
            <DialogDescription>
              Are you sure you want to close Table {closeTableTargetNumber}? 
              This will end the current session. Customers will need to scan the QR code again to start a new session.
              Existing orders will remain for audit purposes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCloseTableDialog(false)
                setCloseTableTargetNumber(null)
              }}
              disabled={closingTableNumber !== null}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (closeTableTargetNumber) {
                  void handleCloseTable(closeTableTargetNumber)
                }
              }}
              disabled={!closeTableTargetNumber || closingTableNumber !== null}
            >
              <ActionButtonContent
                loading={closingTableNumber !== null}
                icon={DoorClosed}
                label="Close Table"
                loadingLabel="Closing..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
