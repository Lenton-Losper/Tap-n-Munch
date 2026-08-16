'use client'

/**
 * The customer's edit surface: remove a line, reduce a quantity, change the note.
 *
 * Two things this component deliberately does NOT do.
 *
 * It does not decide whether editing is allowed. It asks — POST acquires the lock, and the
 * server refuses with a reason. The button below is hidden when `editRefusalReason` says the
 * order is closed to editing, but that is an AFFORDANCE, not a guard: a browser guard is not a
 * lock, and every refusal path here handles being told "no" after the button was shown.
 *
 * It does not compute money. The commit sends line indexes and quantities; the server re-sums
 * from its own priced lines. Cart prices have always been display-only on this project and an
 * edit is not the place to change that.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Minus, Pencil, Plus, XCircle } from 'lucide-react'
import {
  EDIT_COPY,
  editRefusalReason,
  normalizeSessionIds,
  requestEditRefusalReason,
} from '@/lib/orders/edit-lock'
import {
  OrderEditRefused,
  acquireOrderEditLock,
  commitOrderEdit,
  releaseOrderEditLock,
  type EditLockGrant,
} from '@/lib/guest-orders/client'

type WorkingLine = {
  index: number
  quantity: number
  originalQuantity: number
  name: string
  removed: boolean
}

function lineName(item: Record<string, unknown>): string {
  return String(item.displayName ?? item.name ?? 'Item')
}

function toWorkingLines(items: Array<Record<string, unknown>>): WorkingLine[] {
  return items.map((item, index) => {
    const quantity = Number(item.quantity)
    const safeQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1
    return {
      index,
      quantity: safeQuantity,
      originalQuantity: safeQuantity,
      name: lineName(item),
      removed: false,
    }
  })
}

export function OrderEditPanel({
  orderId,
  restaurantId,
  sessionIds: sessionIdsProp,
  order,
  currency,
  onEdited,
}: {
  orderId: string
  restaurantId: string
  /**
   * EVERY session id this browser holds, not one. The app mints two in different storages and
   * nothing syncs them; an order carries whichever the placing screen held, and the cart submits
   * the tab-context one. Passing a single id sent the customer's own order a 404 — measured on
   * the deployed worker. See EditLockAsker in lib/orders/edit-lock.ts.
   */
  sessionIds: Array<string | null | undefined>
  /** The order/request row as the customer's screen already has it. */
  order: Record<string, unknown>
  currency: string
  /** Called after a committed edit so the parent can refetch. */
  onEdited: () => void
}) {
  // Normalised once. Memoised on the JOINED value rather than the array identity, because a
  // parent that rebuilds the array each render would otherwise re-run every effect keyed to it.
  const sessionIdsKey = normalizeSessionIds(sessionIdsProp).join('|')
  const sessionIds = useMemo(() => (sessionIdsKey ? sessionIdsKey.split('|') : []), [sessionIdsKey])

  const [grant, setGrant] = useState<EditLockGrant | null>(null)
  const [lines, setLines] = useState<WorkingLine[]>([])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)

  // Held in a ref as well as state so the unmount cleanup can release a lock it did not close
  // over. Without this, navigating away mid-edit leaves the order locked — and the dashboard
  // saying "customer is changing this order" — until the three minutes elapse.
  const grantRef = useRef<EditLockGrant | null>(null)
  useEffect(() => {
    grantRef.current = grant
  }, [grant])

  // A clock in state rather than Date.now() in the render body. Someone else's lock going stale
  // is the passage of time and nothing else — no row changes when it expires — so the
  // affordance has to be recomputed on a tick, and reading the wall clock during render is
  // both impure (react-hooks/purity) and wouldn't re-render anyway.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(interval)
  }, [])

  // Stated by the server (see redactGuestOrderRow / mapOrderRequestToGuestRow), not inferred:
  // the two tables have different status vocabularies, and every way of guessing which one a
  // row came from is wrong for some row.
  const isRequestSurface = order.surface === 'order_requests'
  const refusal = isRequestSurface
    ? requestEditRefusalReason(order, { sessionIds, nowMs })
    : editRefusalReason(order, { sessionIds, nowMs })

  const release = useCallback(() => {
    const held = grantRef.current
    if (!held) return
    grantRef.current = null
    void releaseOrderEditLock({
      orderId,
      restaurantId,
      sessionIds,
      lockToken: held.lockToken,
    })
  }, [orderId, restaurantId, sessionIds])

  useEffect(() => release, [release])

  // Countdown. Purely informational — the server refuses an expired token regardless of what
  // this says, and the display closing the editor at zero is a courtesy, not the enforcement.
  useEffect(() => {
    if (!grant) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(grant.expiresAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        setGrant(null)
        grantRef.current = null
        setError(EDIT_COPY.lockExpired)
      }
    }
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [grant])

  const open = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const acquired = await acquireOrderEditLock({ orderId, restaurantId, sessionIds })
      setGrant(acquired)
      setLines(toWorkingLines(acquired.items))
      setNotes(String(acquired.orderInstructions ?? ''))
    } catch (err) {
      setError(err instanceof OrderEditRefused ? err.message : 'Could not open this order for editing')
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    release()
    setGrant(null)
    setLines([])
    setAdditions([])
    setError(null)
  }

  const decrement = (index: number) => {
    setLines((prev) =>
      prev.map((line) =>
        line.index === index
          ? line.quantity <= 1
            ? { ...line, removed: true }
            : { ...line, quantity: line.quantity - 1 }
          : line,
      ),
    )
  }

  const remove = (index: number) => {
    setLines((prev) => prev.map((line) => (line.index === index ? { ...line, removed: true } : line)))
  }

  const restore = (index: number) => {
    setLines((prev) =>
      prev.map((line) =>
        line.index === index ? { ...line, removed: false, quantity: line.originalQuantity } : line,
      ),
    )
  }

  /**
   * ADDING ONE MORE OF A LINE ALREADY ON THE ORDER.
   *
   * Deliberately NOT expressed as a raised `keep` quantity. `repriceKeptLines` refuses a raise
   * BY CONSTRUCTION, and that refusal is load-bearing: the reduction path re-sums from the
   * order's own stored lines, so a raise there would multiply a stored price without ever
   * touching the stock check, the quantity cap or the live menu.
   *
   * So a raise is sent as an ADDITION of the same menu item, which goes through
   * applyEditAdditions and therefore through all three guards. The order ends up with two lines
   * of the same item rather than one line of two — which is what the bill honestly shows: the
   * first at the price quoted when it was ordered, the second at today's.
   */
  const [additions, setAdditions] = useState<Array<Record<string, unknown>>>([])

  const addOneMore = (index: number) => {
    const item = (Array.isArray(order.items) ? (order.items as Array<Record<string, unknown>>) : [])[index]
    // No menu item id means nothing can be priced against the live menu, so the control is not
    // offered for that line at all (see the render below). Belt and braces here.
    const menuItemId = String(item?.menuItemId ?? item?.menu_item_id ?? '').trim()
    if (!menuItemId) return
    setAdditions((prev) => [
      ...prev,
      {
        menuItemId,
        name: item?.name ?? item?.displayName ?? '',
        displayName: item?.displayName ?? item?.name ?? '',
        quantity: 1,
        selectedVariants: item?.selectedVariants ?? {},
        size: item?.size ?? null,
        addons: item?.addons ?? [],
        specialInstructions: item?.specialInstructions ?? '',
      },
    ])
  }

  const undoAddition = (position: number) => {
    setAdditions((prev) => prev.filter((_, i) => i !== position))
  }

  /** Whether a line can be added to at all — no menu item id, no live pricing, no control. */
  const lineHasMenuItemId = (index: number): boolean => {
    const item = (Array.isArray(order.items) ? (order.items as Array<Record<string, unknown>>) : [])[index]
    return Boolean(String(item?.menuItemId ?? item?.menu_item_id ?? '').trim())
  }

  const kept = lines.filter((line) => !line.removed)
  const itemsChanged =
    lines.some((line) => line.removed || line.quantity !== line.originalQuantity) ||
    additions.length > 0
  const notesChanged = grant != null && notes.trim() !== String(grant.orderInstructions ?? '').trim()

  const save = async () => {
    if (!grant) return
    setBusy(true)
    setError(null)
    try {
      const result = await commitOrderEdit({
        orderId,
        restaurantId,
        sessionIds,
        lockToken: grant.lockToken,
        // `keep` is sent whenever the SURVIVING lines changed. It is deliberately not sent for
        // an additions-only edit: an unchanged `keep` would be a no-op the server still has to
        // reprice, and omitting it keeps the reduction path untouched in that case.
        ...(lines.some((line) => line.removed || line.quantity !== line.originalQuantity)
          ? { keep: kept.map((line) => ({ index: line.index, quantity: line.quantity })) }
          : {}),
        ...(additions.length > 0 ? { add: additions } : {}),
        ...(notesChanged ? { orderInstructions: notes } : {}),
      })
      // The lock is spent by a successful commit, so there is nothing to release.
      grantRef.current = null
      setGrant(null)
      setLines([])
    setAdditions([])
      setNotice(
        result.totalChanged
          ? result.message.replace('{total}', `${currency}${result.total.toFixed(2)}`)
          : result.message,
      )
      onEdited()
    } catch (err) {
      if (err instanceof OrderEditRefused) {
        setError(err.message)
        // Every refusal on commit means the lock is gone: the kitchen took the order, the
        // token expired, or somebody else holds it. Closing the editor stops the customer
        // pressing Save into a wall.
        grantRef.current = null
        setGrant(null)
      } else {
        setError('Could not save your changes')
      }
    } finally {
      setBusy(false)
    }
  }

  if (notice) {
    return (
      <div className="rounded-lg border border-[#E5E7EB] bg-[#F0FDF4] p-4 text-sm text-[#166534]">
        {notice}
      </div>
    )
  }

  if (!grant) {
    // Refusal reasons are not shown unprompted — an order that has moved on simply has no edit
    // button, the same way it has no cancel button. The message appears only after the
    // customer tried, which is the only moment it answers a question they asked.
    if (refusal) {
      return error ? (
        <div className="rounded-lg border border-[#E5E7EB] bg-[#FEF2F2] p-4 text-sm text-[#991B1B]">
          {error}
        </div>
      ) : null
    }
    return (
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg border border-[#E5E7EB] bg-[#FEF2F2] p-4 text-sm text-[#991B1B]">
            {error}
          </div>
        )}
        <Button
          variant="outline"
          className="w-full font-semibold"
          onClick={() => void open()}
          disabled={busy || sessionIds.length === 0}
        >
          <Pencil className="mr-2 h-4 w-4" />
          {EDIT_COPY.editCta}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-lg border border-[#E5E7EB] bg-white p-4">
      {/* THE DEADLINE LEADS; THE HOLD IS A FOOTNOTE. Spec section 21.
          This used to be one line — "164s left to make changes" — which is the HOLD wearing the
          DEADLINE's words. The deadline is event-driven and uncounted (until the restaurant
          starts preparing); the hold is a three-minute concurrency device. A customer reading a
          countdown believes the first and is being shown the second. */}
      <p className="text-sm font-semibold text-[#111827]">{EDIT_COPY.editDeadline}</p>
      <p className="text-xs text-[#6B7280]">
        {EDIT_COPY.holdSecondary.replace('{seconds}', String(secondsLeft))}
      </p>

      {error && (
        <div className="rounded-lg border border-[#E5E7EB] bg-[#FEF2F2] p-3 text-sm text-[#991B1B]">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {lines.map((line) => (
          <div
            key={line.index}
            className={`flex items-center justify-between gap-2 text-sm ${
              line.removed ? 'text-[#9CA3AF] line-through' : 'text-[#111827]'
            }`}
          >
            <span className="flex-1">
              {line.quantity}× {line.name}
            </span>
            {line.removed ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => restore(line.index)}>
                Undo
              </Button>
            ) : (
              <div className="flex shrink-0 items-center gap-2">
                {/* One more of this line. Sent as an ADDITION, never as a raised `keep`
                    quantity — see the comment on addOneMore for why that distinction is
                    load-bearing rather than stylistic. Offered only when the stored line
                    carries a menu item id, because without one nothing can be priced against
                    the live menu and the server would refuse. */}
                {lineHasMenuItemId(line.index) && (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    onClick={() => addOneMore(line.index)}
                    aria-label={`${EDIT_COPY.addOneMore} — ${line.name}`}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => decrement(line.index)}
                  aria-label={`Reduce ${line.name}`}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => remove(line.index)}
                  aria-label={`Remove ${line.name}`}
                >
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* PENDING ADDITIONS. Nothing here has been sent: they exist only in this component's
          state until Save, and they are priced by the SERVER at commit — no amount is shown
          beside them, because the client does not know what they cost and a client-side figure
          beside a real bill is exactly what this project has ruled against. */}
      {additions.length > 0 && (
        <div className="space-y-1 rounded-md border border-dashed border-[#E5E7EB] p-2">
          {additions.map((addition, position) => (
            <div
              key={`addition-${position}`}
              className="flex items-center justify-between gap-2 text-sm text-[#111827]"
            >
              <span className="flex-1">
                + {String(addition.displayName ?? addition.name ?? 'Item')}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => undoAddition(position)}
                aria-label={`Undo ${String(addition.displayName ?? addition.name ?? 'item')}`}
              >
                Undo
              </Button>
            </div>
          ))}
        </div>
      )}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-[#374151]">Notes for the kitchen</span>
        <textarea
          className="w-full rounded-md border border-[#E5E7EB] p-2 text-sm"
          rows={3}
          value={notes}
          maxLength={280}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      {kept.length === 0 && (
        <p className="text-sm text-[#991B1B]">{EDIT_COPY.cannotEmpty}</p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          className="flex-1 bg-[#16A34A] font-semibold text-white hover:bg-green-700"
          onClick={() => void save()}
          disabled={busy || kept.length === 0 || (!itemsChanged && !notesChanged)}
        >
          Save changes
        </Button>
      </div>
    </div>
  )
}
