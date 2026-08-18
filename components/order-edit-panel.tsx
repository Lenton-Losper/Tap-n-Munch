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
import { editLeavesOrderEmpty } from '@/lib/orders/edit-emptiness'
import { deriveEditIntent, desiredFromStored } from '@/lib/orders/derive-edit-intent'
import { capIdentity } from '@/lib/orders/logical-item-identity'
import { lineConfigurationSummary } from '@/lib/orders/line-configuration'
import { useRouter } from 'next/navigation'
import {
  EDIT_PICK_PARAM,
  clearPendingAdditions,
  readPendingAdditions,
  writePendingAdditions,
} from '@/lib/orders/edit-pending-additions'
import {
  OrderEditRefused,
  acquireOrderEditLock,
  commitOrderEdit,
  releaseOrderEditLock,
  type EditLockGrant,
} from '@/lib/guest-orders/client'

import {
  mergePicks,
  pendingAdditionsFor,
  restoredQuantity,
  rowCanBeAddedTo,
  safeDeriveEditIntent,
  setRowQuantity,
  toWorkingRows,
  type WorkingRow,
} from '@/lib/orders/edit-panel-rows'

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
  const router = useRouter()
  const sessionIdsKey = normalizeSessionIds(sessionIdsProp).join('|')
  const sessionIds = useMemo(() => (sessionIdsKey ? sessionIdsKey.split('|') : []), [sessionIdsKey])

  const [grant, setGrant] = useState<EditLockGrant | null>(null)
  const [rows, setRows] = useState<WorkingRow[]>([])
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
      setRows(mergePicks(toWorkingRows(acquired.items), readPendingAdditions(orderId)))
      // The picks are ABSORBED into the rows here rather than kept beside them, and the store is
      // rewritten from those rows by the effect below -- which is what makes re-acquiring the
      // lock idempotent instead of counting every pick twice.
      //
      // A reopen after the menu round trip must keep what the customer just picked, which is why
      // the store is read here and not cleared.
      setNotes(String(acquired.orderInstructions ?? ''))
    } catch (err) {
      setError(err instanceof OrderEditRefused ? err.message : 'Could not open this order for editing')
    } finally {
      setBusy(false)
    }
  }

  /**
   * REOPEN AFTER THE MENU ROUND TRIP.
   *
   * No extra query parameter: a pending addition existing for this order IS the signal that an
   * edit is in progress. Cancel clears the list, which clears the storage, so this cannot loop.
   * The lock was released on unmount and is re-acquired here -- the holder renewing their own
   * lock is explicitly allowed.
   */
  const reopenedRef = useRef(false)
  useEffect(() => {
    if (reopenedRef.current) return
    if (grantRef.current) return
    if (readPendingAdditions(orderId).length === 0) return
    if (refusal) return
    reopenedRef.current = true
    /**
     * Scheduled, not called inline. `open()` sets state synchronously, and
     * `react-hooks/set-state-in-effect` is an error under the blocking lint gate. Deferring is
     * also the better behaviour: the customer sees their order in its normal state for one
     * frame and then the editor opens, rather than the screen assembling itself twice.
     */
    const timer = window.setTimeout(() => void open(), 0)
    return () => window.clearTimeout(timer)
    // Mount-only by construction: the ref makes a second run a no-op, and `open` is recreated
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const close = () => {
    release()
    setGrant(null)
    setRows([])
    clearPendingAdditions(orderId)
    setError(null)
  }

  /**
   * ALL FOUR CONTROLS SET ONE NUMBER. That is the entire point of the 2026-08-18 rewrite: there
   * is no longer a `+` path and a `-` path that accumulate into different lists, so pressing them
   * in any order leaves the same state, and Save derives the same wire form from it.
   *
   * `restore` returns to the ORIGINAL quantity rather than to 1, so undoing a removal undoes the
   * removal rather than silently reducing a 3 to a 1.
   */
  const setQuantity = (identity: string, next: number) =>
    setRows((prev) => setRowQuantity(prev, identity, next))

  const step = (identity: string, delta: number) => {
    const row = rows.find((r) => r.identity === identity)
    if (row) setQuantity(identity, row.quantity + delta)
  }

  const increment = (identity: string) => step(identity, 1)
  const decrement = (identity: string) => step(identity, -1)
  const remove = (identity: string) => setQuantity(identity, 0)

  const restore = (identity: string) => {
    const row = rows.find((r) => r.identity === identity)
    if (row) setQuantity(identity, restoredQuantity(row))
  }

  /**
   * WHY A RAISE STILL BECOMES AN `add`, EVEN THOUGH THE CUSTOMER JUST PRESSES `+`.
   *
   * `repriceKeptLines` refuses a raised `keep` BY CONSTRUCTION, and that refusal is load-bearing:
   * the reduction path re-sums from the order's own STORED lines, so a raise there would multiply
   * a stored price without ever touching the stock check, the quantity cap or the live menu.
   *
   * The customer no longer expresses that distinction -- `deriveEditIntent` does, at Save, by
   * splitting one desired number into `min(original, desired)` on `keep` and the remainder on
   * `add`. That is what lets `+` and `-` be the same control and still route a genuine increase
   * through all three guards.
   *
   * The order ends up with two stored lines of the same item rather than one line of two, which
   * is what the bill honestly shows: the first at the price quoted when it was ordered, the second
   * at today's. #307 aggregates them for display without merging the money.
   */

  /**
   * THE PICKER ROUND TRIP, and why picks are ABSORBED rather than held alongside.
   *
   * "+ Add something" leaves this ROUTE and unmounts this component -- which also releases the
   * edit lock, deliberately. See lib/orders/edit-pending-additions.ts for why the pending edit
   * cannot live in component state across that trip and must not live on the server either.
   *
   * A first attempt kept `picks` as a second state and merged it into the rows at render. That is
   * wrong in a way worth recording, because it looks fine: a pick that merges into an existing row
   * can then never be reduced to zero. The row's own quantity drops, the merge adds the pick back
   * on the next render, and the customer's `-` does nothing at the bottom of the range.
   *
   * So sessionStorage is a TRANSPORT, not a parallel state. Picks are folded into `rows` when the
   * lock is acquired and the store is cleared; on the way out, whatever is currently beyond the
   * stored order -- `intent.add`, the same value Save would send -- is written back for the return
   * leg. One state, one number per row, no reconciliation.
   *
   * KNOWN AND UNCHANGED: a REDUCTION does not survive the picker trip, because only additions are
   * carried. That was true before this rewrite too (the rows were rebuilt from the order on every
   * re-acquire) and closing it means persisting desired quantities, which changes the format the
   * browse picker appends to. Out of scope here; recorded rather than silently inherited.
   */
  const goPickSomething = () => {
    // From the ORDER ROW, not from props: this component is mounted on two different screens and
    // only the row knows which table and tab the order belongs to.
    const tableNumber = Number(order?.table_number) || 0
    const tabId = String(order?.tab_id ?? '').trim()
    const query = new URLSearchParams()
    if (tableNumber) query.set('table', String(tableNumber))
    if (tabId) query.set('tabId', tabId)
    query.set(EDIT_PICK_PARAM, orderId)
    router.push(`/menu/${restaurantId}/browse?${query.toString()}`)
  }

  /**
   * THE SINGLE SOURCE OF TRUTH FOR BOTH THE SCREEN AND THE SAVE.
   *
   * Rendered rows and saved intent come from the SAME value, so the screen cannot show one thing
   * and commit another. That was possible before: the list rendered `lines` while Save also sent
   * `additions`, and nothing tied the two together.
   */
  const displayRows = rows

  /**
   * Guarded, because `deriveEditIntent` THROWS on a fractional or duplicated row and this runs
   * during render. A stepper cannot produce either -- but the rows are seeded from
   * sessionStorage, which is the one input here that a previous version of the app, or a hand-
   * edited value, could have written. An exception in a `useMemo` is a blank screen; refusing to
   * enable Save is a customer who can still read their order.
   */
  const intent = safeDeriveEditIntent(order.items, displayRows)

  /**
   * KEEP THE TRANSPORT EQUAL TO THE DERIVED ADDITIONS, not to a list of presses.
   *
   * The store holds exactly what `intent.add` holds, rewritten whenever the rows move. That makes
   * absorbing it at acquisition IDEMPOTENT: rows are seeded as stored + store, the store is then
   * rewritten to the additions those rows imply, and a second acquisition seeds the same rows
   * again. An earlier version cleared the store on absorb instead, which loses every pick on an
   * ordinary unmount, and not clearing it at all double-counts on re-acquire. Neither is needed if
   * the two are simply kept equal.
   *
   * GATED ON `grant`. Before the editor is opened `rows` is empty, so `intent.add` is empty, and an
   * ungated effect would write [] over the customer's picks the moment this component mounted --
   * wiping the menu round trip it exists to carry.
   */
  useEffect(() => {
    if (!grant) return
    writePendingAdditions(
      orderId,
      pendingAdditionsFor(intent),
    )
  }, [grant, orderId, intent])

  // #291: emptiness is a property of the RESULT, so it counts additions too. Zero kept with one
  // addition is a swap, not an empty order. Imported, not restated -- the route decides the same
  // question with the same function.
  const wouldBeEmpty = editLeavesOrderEmpty({
    keptLineCount: intent.keep.length,
    additionCount: intent.add.length,
  })
  const itemsChanged = !intent.unchanged
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
        /**
         * DERIVED, never accumulated. `keep` is sent only when the surviving lines actually
         * changed -- an unchanged `keep` would be a no-op the server still has to reprice, and
         * omitting it keeps the reduction path untouched for an additions-only edit.
         *
         * The comparison is against what the order HOLDS, so a customer who reduced and then put
         * it back sends neither half. That is section 3's `2 -> 1 -> 2`, and it falls out of the
         * derivation rather than needing a case of its own.
         */
        ...(intent.reduced ? { keep: intent.keep } : {}),
        ...(intent.add.length > 0 ? { add: pendingAdditionsFor(intent) } : {}),
        ...(notesChanged ? { orderInstructions: notes } : {}),
      })
      // The lock is spent by a successful commit, so there is nothing to release.
      clearPendingAdditions(orderId)
      grantRef.current = null
      setGrant(null)
      setRows([])
      setNotice(
        result.totalChanged
          ? result.message.replace('{total}', `${currency}${result.total.toFixed(2)}`)
          : result.message,
      )
      onEdited()
    } catch (err) {
      if (err instanceof OrderEditRefused) {
        /**
         * `already_saved` is a refusal by status code only (#306). The customer's change LANDED —
         * they are here because the response was lost, on mobile data, and they pressed Save
         * again. Showing it through `setError` would tell them in red that their change was
         * saved, beside a stale order, which is only marginally better than the lie it replaced.
         *
         * So it takes the SUCCESS path: same cleanup, a notice rather than an error, and
         * `onEdited()` so the screen behind shows the order as it now stands — which is exactly
         * what the message claims is on display.
         */
        if (err.reason === 'already_saved') {
          clearPendingAdditions(orderId)
          grantRef.current = null
          setGrant(null)
          setRows([])
          clearPendingAdditions(orderId)
          const savedTotal = Number(err.details?.total)
          setNotice(
            Number.isFinite(savedTotal)
              ? `${err.message} ${currency}${savedTotal.toFixed(2)}`
              : err.message,
          )
          onEdited()
          return
        }
        setError(err.message)
        // Every other refusal on commit means the lock is gone: the kitchen took the order, the
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
        {displayRows.map((row) => (
          <div
            key={row.identity}
            className={`flex items-center justify-between gap-2 text-sm ${
              row.quantity === 0 ? 'text-[#9CA3AF] line-through' : 'text-[#111827]'
            }`}
          >
            <span className="flex-1">
              {/* ONE NUMBER, and it is the DESIRED one. Not the stored quantity, not the stored
                  quantity plus pending additions shown separately — what the customer will end up
                  with. The stepper beside it moves this and nothing else. */}
              {row.quantity}× {row.name}
              {/* #298: this is the screen the two indistinguishable Beef Burgers were on. */}
              {lineConfigurationSummary(row.raw) ? (
                <span className="block text-xs text-[#6B7280]">
                  {lineConfigurationSummary(row.raw)}
                </span>
              ) : null}
            </span>
            {row.quantity === 0 ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => restore(row.identity)}>
                Undo
              </Button>
            ) : (
              <div className="flex shrink-0 items-center gap-2">
                {/* `+` and `-` are the SAME control now: both set the desired quantity. Which
                    half of the wire form a press ends up in — `keep` or the guarded `add` — is
                    decided by deriveEditIntent at Save, not here. Offered only when the row
                    carries a menu item id, because without one nothing can be priced against the
                    live menu and the server would refuse a raise. */}
                {rowCanBeAddedTo(row) && (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    onClick={() => increment(row.identity)}
                    aria-label={`${EDIT_COPY.addOneMore} — ${row.name}`}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => decrement(row.identity)}
                  aria-label={`Reduce ${row.name}`}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => remove(row.identity)}
                  aria-label={`Remove ${row.name}`}
                >
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* THE SEPARATE "PENDING ADDITIONS" LIST IS GONE, 2026-08-18.
          It rendered picks BESIDE the rows while the rows already counted them, so an item the
          customer had one of appeared twice — once inside "2× Wrap" and once as "+ Wrap" — and
          neither figure was the answer to "how many am I getting". One row per logical item, at
          the desired quantity, is now the whole list.

          What that list existed to promise still holds: nothing has been sent, and no amount is
          shown beside an addition, because the client does not know what it costs and a
          client-side figure beside a real bill is exactly what this project has ruled against.
          The resulting total is the SERVER's, after Save. */}

      {/* "+ ADD SOMETHING". Ruled 2026-08-16. Opens the MENU in picker mode and comes back to
          this pending edit -- not to the cart, which would place a second order for what the
          customer meant as a change to this one. Nothing commits until Save. */}
      <Button
        type="button"
        variant="outline"
        className="w-full font-semibold"
        onClick={goPickSomething}
        disabled={busy}
      >
        <Plus className="mr-2 h-4 w-4" />
        {EDIT_COPY.addSomething}
      </Button>

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

      {wouldBeEmpty && (
        <p className="text-sm text-[#991B1B]">{EDIT_COPY.cannotEmpty}</p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          className="flex-1 bg-[#16A34A] font-semibold text-white hover:bg-green-700"
          onClick={() => void save()}
          disabled={busy || wouldBeEmpty || (!itemsChanged && !notesChanged)}
        >
          Save changes
        </Button>
      </div>
    </div>
  )
}
