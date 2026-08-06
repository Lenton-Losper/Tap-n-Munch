'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'
import {
  getSupabaseTables as getTables,
  createOrderingPointViaApi,
  updateOrderingPointViaApi,
} from '@/lib/supabase/tables'
import { supabase } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'
import {
  summariseClearImpact,
  clearTableConfirmationMessage,
  type ClearTableImpact,
} from '@/lib/tables/clear-table'
import { buildMenuUrl } from '@/lib/base-url'
import {
  KIOSK_NAME_PRESETS,
  VIEW_ONLY_NAME_PRESETS,
  orderingPointDisplayName,
  resolveOrderingPointQrUrl,
  type OrderingPointRow,
} from '@/lib/tables/ordering-points'
import {
  resolveOrderRestaurantScope,
  type OrderRestaurantScope,
} from '@/lib/supabase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowLeft, Copy, Download, MoreHorizontal, Plus } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

type TableLiveStatus = 'active' | 'needs_payment' | 'empty'

type OpenOrderRow = {
  table_number?: number | null
  status?: string | null
  payment_status?: string | null
}

const ACTIVE_STATUSES = new Set(['pending', 'accepted', 'ready', 'ready_for_terminal'])
const TERMINAL_STATUSES = new Set(['completed', 'cancelled'])

function computeTableStatus(orders: OpenOrderRow[]): TableLiveStatus {
  const open = orders.filter((o) => !TERMINAL_STATUSES.has(String(o.status || '').toLowerCase()))
  if (open.length === 0) return 'empty'

  const needsPayment = open.some(
    (o) =>
      String(o.payment_status || '').toLowerCase() === 'pending' &&
      String(o.status || '').toLowerCase() === 'ready',
  )
  if (needsPayment) return 'needs_payment'

  const isActive = open.some((o) => ACTIVE_STATUSES.has(String(o.status || '').toLowerCase()))
  if (isActive) return 'active'

  return 'empty'
}

function groupOrdersByTableStatus(orders: OpenOrderRow[]): Record<number, TableLiveStatus> {
  const byTable = new Map<number, OpenOrderRow[]>()
  for (const order of orders) {
    const tableNum = Number(order.table_number)
    if (!Number.isFinite(tableNum) || tableNum <= 0) continue
    const list = byTable.get(tableNum) || []
    list.push(order)
    byTable.set(tableNum, list)
  }
  const result: Record<number, TableLiveStatus> = {}
  byTable.forEach((tableOrders, tableNum) => {
    result[tableNum] = computeTableStatus(tableOrders)
  })
  return result
}

function StatusBadge({ status, inactive }: { status: TableLiveStatus; inactive?: boolean }) {
  if (inactive) {
    return <Badge variant="outline" className="font-semibold">Inactive</Badge>
  }
  if (status === 'needs_payment') {
    return <Badge className="bg-red-600 text-white font-semibold">Needs payment</Badge>
  }
  if (status === 'active') {
    return <Badge className="bg-orange-500 text-white font-semibold">Occupied</Badge>
  }
  return <Badge className="bg-gray-500 text-white font-semibold">Empty</Badge>
}

async function downloadQrPng(selector: string, filename: string) {
  const container = document.querySelector(selector)
  const svgElement = container?.querySelector('svg')
  if (!svgElement) throw new Error('QR code not found')

  const svgData = new XMLSerializer().serializeToString(svgElement)
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)

  await new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to create canvas'))
        return
      }
      ctx.drawImage(img, 0, 0)
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to create image'))
          return
        }
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
        URL.revokeObjectURL(svgUrl)
        resolve()
      }, 'image/png')
    }
    img.onerror = () => reject(new Error('Failed to load QR image'))
    img.src = svgUrl
  })
}

/** Exported for #175's rendering test — the number must be verifiable on the rendered card. */
export function OrderingPointCard({
  point,
  restaurantId,
  liveStatus,
  copiedLinkId,
  onCopyLink,
  onEdit,
  onDeactivate,
  onClearTable,
}: {
  point: OrderingPointRow
  restaurantId: string
  liveStatus: TableLiveStatus
  copiedLinkId: string | null
  onCopyLink: (url: string, id: string) => void
  onEdit: (point: OrderingPointRow) => void
  onDeactivate: (point: OrderingPointRow) => void
  /** #176. Absent for kiosks/view-only points and for staff without tables:manage. */
  onClearTable?: (point: OrderingPointRow) => void
}) {
  const qrUrl = resolveOrderingPointQrUrl(restaurantId, point)
  const displayName = orderingPointDisplayName(point)
  const inactive = point.active === false

  return (
    <div
      className={cn(
        'rounded-xl border bg-white p-4 shadow-sm',
        inactive && 'opacity-70',
        !inactive && liveStatus === 'needs_payment' && 'border-red-200',
        !inactive && liveStatus === 'active' && 'border-orange-200',
        !inactive && liveStatus === 'empty' && 'border-gray-200',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-semibold text-lg text-gray-900">{displayName}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={liveStatus} inactive={inactive} />
            {/*
              #175: the table NUMBER, which the card never showed. `orderingPointDisplayName`
              returns a custom name as-is, so for a table named e.g. "cash-settle-...-t9761" the
              number appeared nowhere in the UI -- and "Table number 9761 is already used" was
              then unexplainable. Numbers are what QR links and order history resolve by, so the
              merchant needs to see them.

              Dining tables only. Kiosk (9000+) and view-only (5000+) numbers are internal band
              allocations, not something written on a table, so showing them would be noise.
            */}
            {!point.is_kiosk && !point.is_view_only ? (
              <Badge variant="secondary" title={`Table number ${point.table_number}`}>
                No. {point.table_number}
              </Badge>
            ) : null}
            {!point.is_kiosk && !point.is_view_only && point.capacity != null && point.capacity > 0 ? (
              <Badge variant="outline">{point.capacity} seats</Badge>
            ) : null}
          </div>
          {point.location ? (
            <p className="text-sm text-gray-600">{point.location}</p>
          ) : (
            <p className="text-sm text-gray-400">No location set</p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(point)}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void downloadQrPng(`#qr-${point.id}`, `qr-${displayName.replace(/\s+/g, '-').toLowerCase()}.png`)
              }
            >
              Download QR
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCopyLink(qrUrl, point.id)}>
              {copiedLinkId === point.id ? 'Link copied' : 'Copy link'}
            </DropdownMenuItem>
            {/*
              #176: Clear Table ends the CURRENT SESSION so the next customer scans the same
              printed code and starts fresh. Deliberately listed above Deactivate and not styled
              as destructive, because the two are easy to confuse and only Deactivate kills the
              QR. Hidden without tables:manage rather than failing at the API.
            */}
            {onClearTable && point.active !== false ? (
              <DropdownMenuItem onClick={() => onClearTable(point)}>Clear table</DropdownMenuItem>
            ) : null}
            {point.active !== false ? (
              <DropdownMenuItem className="text-red-600" onClick={() => onDeactivate(point)}>
                Deactivate
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-4 flex justify-center">
        <Link
          href={qrUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-white p-2 ring-1 ring-gray-200 transition hover:ring-[#FF6B35]"
          id={`qr-wrap-${point.id}`}
        >
          <div id={`qr-${point.id}`}>
            <QRCodeSVG value={qrUrl} size={148} />
          </div>
        </Link>
      </div>
    </div>
  )
}

export function QRCodeManagement() {
  const { user, restaurantId } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const showInactive = searchParams.get('showInactive') === '1'

  const [tables, setTables] = useState<OrderingPointRow[]>([])
  // #176 clear-table confirmation. `clearImpact === null` while the unpaid count is still being
  // fetched, so the dialog can refuse to offer the button until it knows what is at stake.
  const [clearTarget, setClearTarget] = useState<OrderingPointRow | null>(null)
  const [clearImpact, setClearImpact] = useState<ClearTableImpact | null>(null)
  const [clearBusy, setClearBusy] = useState(false)
  const { hasPermission, permissionsLoaded } = usePermissions()
  const canManageTables = permissionsLoaded && hasPermission(PERMISSIONS.TABLES_MANAGE)
  const [loading, setLoading] = useState(true)
  const [isAddTableOpen, setIsAddTableOpen] = useState(false)
  const [isAddKioskOpen, setIsAddKioskOpen] = useState(false)
  const [isAddViewOnlyOpen, setIsAddViewOnlyOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [editingPoint, setEditingPoint] = useState<OrderingPointRow | null>(null)
  const [newTableNumber, setNewTableNumber] = useState('')
  const [newTableSeats, setNewTableSeats] = useState('')
  const [newTableLocation, setNewTableLocation] = useState('')
  const [newKioskName, setNewKioskName] = useState('')
  const [newKioskLocation, setNewKioskLocation] = useState('')
  const [newViewOnlyName, setNewViewOnlyName] = useState('')
  const [newViewOnlyLocation, setNewViewOnlyLocation] = useState('')
  const [editName, setEditName] = useState('')
  const [editSeats, setEditSeats] = useState('')
  const [editLocation, setEditLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const [orderScope, setOrderScope] = useState<OrderRestaurantScope | null>(null)
  const [tableStatusByNumber, setTableStatusByNumber] = useState<Record<number, TableLiveStatus>>({})

  const diningTables = useMemo(
    () => tables.filter((t) => !t.is_kiosk && !t.is_view_only),
    [tables],
  )
  const kiosks = useMemo(
    () => tables.filter((t) => t.is_kiosk),
    [tables],
  )
  const viewOnlyPoints = useMemo(
    () => tables.filter((t) => t.is_view_only),
    [tables],
  )

  const loadTables = useCallback(async () => {
    if (!restaurantId) return
    const tablesData = await getTables(restaurantId, true, { includeInactive: showInactive })
    setTables(tablesData)
  }, [restaurantId, showInactive])

  const refreshTableStatuses = useCallback(async () => {
    if (!restaurantId) return
    try {
      const scope = orderScope ?? (await resolveOrderRestaurantScope(restaurantId))
      if (!orderScope) setOrderScope(scope)

      const { data, error } = await supabase
        .from('orders')
        .select('table_number, status, payment_status')
        .eq('restaurant_id', scope.restaurantId)
        .eq('is_closed', false)
        .not('status', 'in', '("completed","cancelled")')

      if (error) throw error
      setTableStatusByNumber(groupOrdersByTableStatus((data || []) as OpenOrderRow[]))
    } catch (err) {
      console.error('[ORDERING CHANNELS] failed to refresh statuses', err)
    }
  }, [restaurantId, orderScope])

  useEffect(() => {
    if (!user || !restaurantId) return
    const run = async () => {
      try {
        setLoading(true)
        await loadTables()
      } catch (err: unknown) {
        toast({
          title: 'Error',
          description: err instanceof Error ? err.message : 'Failed to load ordering points',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }
    void run()
  }, [user, restaurantId, loadTables, toast])

  useEffect(() => {
    if (!restaurantId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional polling fetch for table statuses
    void refreshTableStatuses()
    const interval = setInterval(() => void refreshTableStatuses(), 30_000)
    return () => clearInterval(interval)
  }, [restaurantId, refreshTableStatuses])

  const getAccessToken = async () => {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('Your session expired. Please sign in again.')
    return token
  }

  const handleShowInactiveChange = (checked: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    if (checked) params.set('showInactive', '1')
    else params.delete('showInactive')
    const query = params.toString()
    router.push(query ? `/qr-codes?${query}` : '/qr-codes')
  }

  const handleCopyLink = async (url: string, linkId: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLinkId(linkId)
      toast({ title: 'Link copied' })
      setTimeout(() => setCopiedLinkId(null), 2000)
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' })
    }
  }

  const handleAddTable = async () => {
    if (!restaurantId) return
    const tableNumber = parseInt(newTableNumber, 10)
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      toast({ title: 'Invalid table number', variant: 'destructive' })
      return
    }

    try {
      setSaving(true)
      const token = await getAccessToken()
      await createOrderingPointViaApi(
        {
          kind: 'table',
          table_number: tableNumber,
          capacity: newTableSeats.trim() ? Number(newTableSeats) : null,
          location: newTableLocation.trim() || null,
        },
        { restaurantId, accessToken: token },
      )
      toast({ title: 'Table created', description: `Table ${tableNumber} is ready.` })
      setNewTableNumber('')
      setNewTableSeats('')
      setNewTableLocation('')
      setIsAddTableOpen(false)
      await loadTables()
    } catch (err: unknown) {
      toast({
        title: 'Failed to create table',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleAddKiosk = async () => {
    if (!restaurantId) return
    const kioskName = newKioskName.trim()
    if (!kioskName) {
      toast({ title: 'Kiosk name is required', variant: 'destructive' })
      return
    }

    try {
      setSaving(true)
      const token = await getAccessToken()
      await createOrderingPointViaApi(
        {
          kind: 'kiosk',
          kiosk_name: kioskName,
          location: newKioskLocation.trim() || null,
        },
        { restaurantId, accessToken: token },
      )
      toast({ title: 'Kiosk created', description: `${kioskName} is ready.` })
      setNewKioskName('')
      setNewKioskLocation('')
      setIsAddKioskOpen(false)
      await loadTables()
    } catch (err: unknown) {
      toast({
        title: 'Failed to create kiosk',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleAddViewOnly = async () => {
    if (!restaurantId) return
    const viewOnlyName = newViewOnlyName.trim()
    if (!viewOnlyName) {
      toast({ title: 'Name is required', variant: 'destructive' })
      return
    }

    try {
      setSaving(true)
      const token = await getAccessToken()
      await createOrderingPointViaApi(
        {
          kind: 'view_only',
          view_only_name: viewOnlyName,
          location: newViewOnlyLocation.trim() || null,
        },
        { restaurantId, accessToken: token },
      )
      toast({ title: 'View-only menu QR created', description: `${viewOnlyName} is ready.` })
      setNewViewOnlyName('')
      setNewViewOnlyLocation('')
      setIsAddViewOnlyOpen(false)
      await loadTables()
    } catch (err: unknown) {
      toast({
        title: 'Failed to create view-only menu QR',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (point: OrderingPointRow) => {
    setEditingPoint(point)
    setEditName(orderingPointDisplayName(point))
    setEditSeats(point.capacity != null ? String(point.capacity) : '')
    setEditLocation(point.location || '')
    setIsEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!restaurantId || !editingPoint) return
    try {
      setSaving(true)
      const token = await getAccessToken()
      const body: Record<string, unknown> = {
        table_name: editName.trim(),
        location: editLocation.trim() || null,
      }
      if (!editingPoint.is_kiosk && !editingPoint.is_view_only) {
        body.capacity = editSeats.trim() ? Number(editSeats) : null
      }
      await updateOrderingPointViaApi(editingPoint.id, body, {
        restaurantId,
        accessToken: token,
      })
      toast({ title: 'Saved' })
      setIsEditOpen(false)
      setEditingPoint(null)
      await loadTables()
    } catch (err: unknown) {
      toast({
        title: 'Failed to save',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  /**
   * #176: clearing a table detaches UNPAID orders with their payment_status untouched -- the
   * debt is preserved but stops appearing on the dashboard. So the merchant is told how much
   * money is at stake BEFORE anything happens, never after.
   *
   * The count uses the same isPaidPaymentStatus normaliser the close route uses. A raw
   * .eq('payment_status','paid') would classify a stray 'Paid' differently from the server, and
   * a confirmation that disagrees with what the server does is worse than no confirmation.
   */
  const handleClearRequest = async (point: OrderingPointRow) => {
    if (!restaurantId) return
    setClearTarget(point)
    setClearImpact(null)

    try {
      const scope = orderScope ?? (await resolveOrderRestaurantScope(restaurantId))
      const { data, error } = await supabase
        .from('orders')
        .select('id, payment_status, total')
        .in('restaurant_id', scope)
        .eq('table_number', point.table_number)
        .eq('is_closed', false)

      if (error) throw error
      setClearImpact(summariseClearImpact(data ?? []))
    } catch (err: unknown) {
      // Never fall back to "assume nothing is owed" -- that is exactly the silent write-off
      // this confirmation exists to prevent.
      setClearTarget(null)
      toast({
        title: 'Could not check open orders',
        description:
          err instanceof Error
            ? `${err.message}. Not clearing, because unpaid orders could not be counted.`
            : 'Not clearing, because unpaid orders could not be counted.',
        variant: 'destructive',
      })
    }
  }

  const handleClearConfirm = async () => {
    if (!restaurantId || !clearTarget) return
    const point = clearTarget

    try {
      setClearBusy(true)
      const token = await getAccessToken()
      const res = await fetch(`/api/tables/${point.table_number}/close`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ restaurantId }),
      })
      const body = (await res.json()) as {
        error?: string
        completed?: number
        closedUnpaid?: number
      }
      if (!res.ok) throw new Error(body.error || 'Failed to clear table')

      const parts: string[] = []
      if (body.completed) parts.push(`${body.completed} paid order(s) completed`)
      if (body.closedUnpaid) parts.push(`${body.closedUnpaid} unpaid order(s) still owed`)

      toast({
        title: `${orderingPointDisplayName(point)} cleared`,
        description: parts.length
          ? `${parts.join('; ')}. The next scan starts a fresh session.`
          : 'The next scan starts a fresh session.',
      })

      setClearTarget(null)
      setClearImpact(null)
      await loadTables()
      await refreshTableStatuses()
    } catch (err: unknown) {
      toast({
        title: 'Failed to clear table',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setClearBusy(false)
    }
  }

  const handleDeactivate = async (point: OrderingPointRow) => {
    if (!restaurantId) return
    const label = orderingPointDisplayName(point)
    if (!confirm(`Deactivate ${label}? Its QR code will stop accepting new orders.`)) return

    try {
      setSaving(true)
      const token = await getAccessToken()
      await updateOrderingPointViaApi(
        point.id,
        { active: false },
        { restaurantId, accessToken: token },
      )
      toast({ title: 'Deactivated', description: `${label} is now inactive.` })
      await loadTables()
    } catch (err: unknown) {
      toast({
        title: 'Failed to deactivate',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-[#FF6B35]" />
      </div>
    )
  }

  if (!restaurantId) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-center">
        <div>
          <h2 className="mb-2 text-xl font-bold">Restaurant ID missing</h2>
          <Button onClick={() => router.push('/signin')}>Sign in</Button>
        </div>
      </div>
    )
  }

  const mainMenuUrl = buildMenuUrl(restaurantId)

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Ordering Channels</h1>
            <p className="text-sm text-gray-600">Dining tables, kiosks, and your main menu QR.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="show-inactive-points"
            checked={showInactive}
            onCheckedChange={handleShowInactiveChange}
          />
          <Label htmlFor="show-inactive-points" className="text-sm text-gray-600">
            Show inactive
          </Label>
        </div>
      </div>

      <div className="mb-8 rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <h2 className="mb-2 text-xl font-bold text-gray-900">Main Menu QR</h2>
        <p className="mb-4 text-sm text-gray-600">
          Links to your menu without a specific table or kiosk.
        </p>
        <div className="flex flex-col items-start gap-6 sm:flex-row">
          <div id="main-menu-qr" className="rounded-lg border-2 border-gray-200 bg-white p-4">
            <QRCodeSVG value={mainMenuUrl} size={180} />
          </div>
          <div className="flex-1 space-y-3">
            <div className="rounded border bg-gray-50 p-2 font-mono text-sm break-all">{mainMenuUrl}</div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void handleCopyLink(mainMenuUrl, 'main')}>
                <Copy className="mr-2 h-4 w-4" />
                Copy link
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void downloadQrPng('#main-menu-qr', 'main-menu-qr.png').then(() =>
                    toast({ title: 'Downloaded' }),
                  )
                }
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            </div>
          </div>
        </div>
      </div>

      <section className="mb-8 rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Dining Tables</h2>
            <p className="text-sm text-gray-600">Table-side QR ordering via /v2 links.</p>
          </div>
          <Button className="bg-[#FF6B35] hover:bg-[#e55a28]" onClick={() => setIsAddTableOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Table
          </Button>
        </div>
        {diningTables.length === 0 ? (
          <p className="py-8 text-center text-gray-500">No dining tables yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {diningTables.map((table) => (
              <OrderingPointCard
                key={table.id}
                point={table}
                restaurantId={restaurantId}
                liveStatus={tableStatusByNumber[table.table_number] ?? 'empty'}
                copiedLinkId={copiedLinkId}
                onCopyLink={(url, id) => void handleCopyLink(url, id)}
                onEdit={openEdit}
                onDeactivate={(p) => void handleDeactivate(p)}
                // #176: dining tables only -- kiosks and view-only points have no seated
                // session to end. Undefined without tables:manage, so the item is hidden
                // rather than shown and then rejected by the API.
                onClearTable={
                  canManageTables ? (p) => void handleClearRequest(p) : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8 rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Self-Service Kiosks</h2>
            <p className="text-sm text-gray-600">Counter and buffet kiosks via /kiosk links.</p>
          </div>
          <Button className="bg-[#FF6B35] hover:bg-[#e55a28]" onClick={() => setIsAddKioskOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Kiosk
          </Button>
        </div>
        {kiosks.length === 0 ? (
          <p className="py-8 text-center text-gray-500">No kiosks yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {kiosks.map((kiosk) => (
              <OrderingPointCard
                key={kiosk.id}
                point={kiosk}
                restaurantId={restaurantId}
                liveStatus={tableStatusByNumber[kiosk.table_number] ?? 'empty'}
                copiedLinkId={copiedLinkId}
                onCopyLink={(url, id) => void handleCopyLink(url, id)}
                onEdit={openEdit}
                onDeactivate={(p) => void handleDeactivate(p)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-gray-900">View-Only Menu QRs</h2>
            <p className="text-sm text-gray-600">
              Menu only -- customers can browse but can never start a tab or place an order.
              Good for an entrance or noticeboard, not tied to a specific table.
            </p>
          </div>
          <Button
            className="bg-[#FF6B35] hover:bg-[#e55a28]"
            onClick={() => setIsAddViewOnlyOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add View-Only Menu QR
          </Button>
        </div>
        {viewOnlyPoints.length === 0 ? (
          <p className="py-8 text-center text-gray-500">No view-only menu QRs yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {viewOnlyPoints.map((point) => (
              <OrderingPointCard
                key={point.id}
                point={point}
                restaurantId={restaurantId}
                liveStatus={tableStatusByNumber[point.table_number] ?? 'empty'}
                copiedLinkId={copiedLinkId}
                onCopyLink={(url, id) => void handleCopyLink(url, id)}
                onEdit={openEdit}
                onDeactivate={(p) => void handleDeactivate(p)}
              />
            ))}
          </div>
        )}
      </section>

      {/*
        #176 clear-table confirmation. The button stays disabled until the unpaid count is
        known, so it is never possible to confirm without having been told what is at stake.
      */}
      <Dialog
        open={clearTarget !== null}
        onOpenChange={(open) => {
          if (!open && !clearBusy) {
            setClearTarget(null)
            setClearImpact(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Clear {clearTarget ? orderingPointDisplayName(clearTarget) : 'table'}?
            </DialogTitle>
            <DialogDescription>
              {clearImpact
                ? clearTableConfirmationMessage(clearImpact)
                : 'Checking open orders…'}
            </DialogDescription>
          </DialogHeader>

          {clearImpact?.requiresConfirmation ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              This money is still owed. Clearing the table keeps the record but removes it from
              the dashboard, so collect payment first if the customer is still here.
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setClearTarget(null)
                setClearImpact(null)
              }}
              disabled={clearBusy}
            >
              Cancel
            </Button>
            <Button
              variant={clearImpact?.requiresConfirmation ? 'destructive' : 'default'}
              onClick={() => void handleClearConfirm()}
              disabled={clearBusy || clearImpact === null}
            >
              {clearBusy
                ? 'Clearing…'
                : clearImpact?.requiresConfirmation
                  ? 'Clear anyway'
                  : 'Clear table'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddTableOpen} onOpenChange={setIsAddTableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add dining table</DialogTitle>
            <DialogDescription>Creates a table QR that opens the standard table ordering flow.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="table-number">Table number *</Label>
              <Input
                id="table-number"
                type="number"
                min={1}
                value={newTableNumber}
                onChange={(e) => setNewTableNumber(e.target.value)}
                placeholder="e.g. 7"
              />
            </div>
            <div>
              <Label htmlFor="table-seats">Seats (optional)</Label>
              <Input
                id="table-seats"
                type="number"
                min={1}
                value={newTableSeats}
                onChange={(e) => setNewTableSeats(e.target.value)}
                placeholder="e.g. 4"
              />
            </div>
            <div>
              <Label htmlFor="table-location">Location (optional)</Label>
              <Input
                id="table-location"
                value={newTableLocation}
                onChange={(e) => setNewTableLocation(e.target.value)}
                placeholder="e.g. Window side"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddTableOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleAddTable()}>
              Create table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddKioskOpen} onOpenChange={setIsAddKioskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add kiosk</DialogTitle>
            <DialogDescription>
              A table number is assigned automatically. Customers scan a /kiosk QR and enter their name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="kiosk-name">Kiosk name *</Label>
              <Input
                id="kiosk-name"
                value={newKioskName}
                onChange={(e) => setNewKioskName(e.target.value)}
                placeholder="e.g. Counter"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {KIOSK_NAME_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setNewKioskName(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="kiosk-location">Location (optional)</Label>
              <Input
                id="kiosk-location"
                value={newKioskLocation}
                onChange={(e) => setNewKioskLocation(e.target.value)}
                placeholder="e.g. Near entrance"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddKioskOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleAddKiosk()}>
              Create kiosk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddViewOnlyOpen} onOpenChange={setIsAddViewOnlyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add view-only menu QR</DialogTitle>
            <DialogDescription>
              A table number is assigned automatically, same as a kiosk, but this QR can never
              start a tab or place an order -- customers can only browse the menu.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="view-only-name">Name *</Label>
              <Input
                id="view-only-name"
                value={newViewOnlyName}
                onChange={(e) => setNewViewOnlyName(e.target.value)}
                placeholder="e.g. Entrance"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {VIEW_ONLY_NAME_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setNewViewOnlyName(preset)}
                  >
                    {preset}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="view-only-location">Location (optional)</Label>
              <Input
                id="view-only-location"
                value={newViewOnlyLocation}
                onChange={(e) => setNewViewOnlyLocation(e.target.value)}
                placeholder="e.g. Front noticeboard"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddViewOnlyOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleAddViewOnly()}>
              Create view-only menu QR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Edit {editingPoint?.is_kiosk ? 'kiosk' : editingPoint?.is_view_only ? 'view-only menu QR' : 'table'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            {!editingPoint?.is_kiosk && !editingPoint?.is_view_only ? (
              <div>
                <Label htmlFor="edit-seats">Seats (optional)</Label>
                <Input
                  id="edit-seats"
                  type="number"
                  min={1}
                  value={editSeats}
                  onChange={(e) => setEditSeats(e.target.value)}
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="edit-location">Location (optional)</Label>
              <Input
                id="edit-location"
                value={editLocation}
                onChange={(e) => setEditLocation(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleSaveEdit()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
