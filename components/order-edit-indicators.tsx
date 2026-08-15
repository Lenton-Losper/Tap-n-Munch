'use client'

/**
 * What the dashboard shows about a customer edit, in one component used by both the Waiting
 * for Review card and the main order card — three things the human asked for:
 *
 *   1. an edit is IN PROGRESS right now
 *   2. this order WAS edited
 *   3. the before/after total, when the total changed
 *
 * (1) is live state and has to be recomputed as time passes, because a lock going stale is
 * the passage of time and nothing else — no row changes when it expires. The dashboard
 * already re-renders on a timer (`nowMs`), and this component takes that clock as a prop
 * rather than reading Date.now() itself so the caller's tick is what drives it and a test can
 * hand it a fixed instant.
 */

import { Badge } from '@/components/ui/badge'
import { Pencil } from 'lucide-react'
import { EDIT_COPY, isEditLockActive } from '@/lib/orders/edit-lock'

type EditableRow = Record<string, unknown>

export function OrderEditBadges({ order, nowMs }: { order: EditableRow; nowMs: number }) {
  const editing = isEditLockActive(order, nowMs)
  const editedAt = order.customer_edited_at ? String(order.customer_edited_at) : ''
  const wasEdited = Boolean(editedAt) || (Number(order.customer_edit_count) || 0) > 0
  const needsReacceptance = order.requires_reacceptance === true

  if (!editing && !wasEdited) return null

  return (
    <>
      {editing && (
        <Badge className="border-0 bg-amber-500 text-white">
          <Pencil className="mr-1 h-3 w-3" />
          {EDIT_COPY.staffEditInProgress}
        </Badge>
      )}
      {wasEdited && !editing && (
        <Badge variant="outline" className="border-amber-500 text-amber-700">
          {EDIT_COPY.staffWasEdited}
        </Badge>
      )}
      {needsReacceptance && (
        <Badge className="border-0 bg-red-600 text-white">
          {EDIT_COPY.staffNeedsReacceptance}
        </Badge>
      )}
    </>
  )
}

/**
 * The before/after figure. Rendered only when a total-changing edit actually happened —
 * total_before_edit is written by the edit route ONLY on a total change, so its presence is
 * the signal and no comparison is done here. A notes-only edit shows the badge above and no
 * money, which is correct: nothing about the money changed.
 */
export function OrderEditTotalDelta({
  order,
  currency,
}: {
  order: EditableRow
  currency: string
}) {
  const before = order.total_before_edit
  if (before == null) return null

  const previous = Number(before)
  const current = Number(order.total) || 0
  if (!Number.isFinite(previous)) return null

  const delta = current - previous
  const rose = delta > 0

  return (
    <p className="text-sm font-medium text-amber-700">
      {currency}
      {previous.toFixed(2)} → {currency}
      {current.toFixed(2)}{' '}
      <span className="text-muted-foreground">
        ({rose ? '+' : '−'}
        {currency}
        {Math.abs(delta).toFixed(2)})
      </span>
    </p>
  )
}
