'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  bulkSetTrackInventoryAction,
  previewBulkTrackingAction,
} from '@/lib/recipes/bulk-tracking-actions'
import type { TrackingCandidate } from '@/lib/recipes/bulk-tracking'

type Mode = 'off' | 'on'

type RunResult = {
  changed: TrackingCandidate[]
  alreadyInState: TrackingCandidate[]
  lostRace: TrackingCandidate[]
  message: string
}

/**
 * Bulk tracking toggle.
 *
 * OFF and ON are deliberately asymmetric. Turning tracking off cannot refuse an order, so it
 * is one action behind a plain warning about drift. Turning it on can refuse orders the
 * instant it lands, so it shows exactly which items would block and requires an explicit
 * confirmation before writing.
 */
export function BulkTrackingDialog({ canEdit }: { canEdit: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('off')
  const [candidates, setCandidates] = useState<TrackingCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [confirmedBlocking, setConfirmedBlocking] = useState(false)

  // Only items that are not already in the target state are worth showing.
  const relevant = useMemo(
    () => candidates.filter((c) => (mode === 'off' ? c.tracked : !c.tracked)),
    [candidates, mode],
  )

  const selectedCandidates = useMemo(
    () => relevant.filter((c) => selected.has(c.menuItemId)),
    [relevant, selected],
  )

  const wouldBlock = useMemo(
    () =>
      mode === 'on'
        ? selectedCandidates.filter(
            (c) => c.hasLiveRecipe && c.lowestIngredientBalance !== null && c.lowestIngredientBalance <= 0,
          )
        : [],
    [mode, selectedCandidates],
  )

  const noRecipe = useMemo(
    () => (mode === 'on' ? selectedCandidates.filter((c) => !c.hasLiveRecipe) : []),
    [mode, selectedCandidates],
  )

  const load = useCallback(async (nextMode: Mode) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setConfirmedBlocking(false)
    const res = await previewBulkTrackingAction({ selectedIds: [], target: nextMode === 'on' })
    setLoading(false)
    if ('error' in res && res.error) {
      setError(res.error)
      return
    }
    const all = res.data?.allCandidates ?? []
    setCandidates(all)
    // Default to everything actionable: today's need is "turn it all off", one click.
    setSelected(
      new Set(all.filter((c) => (nextMode === 'off' ? c.tracked : !c.tracked)).map((c) => c.menuItemId)),
    )
  }, [])

  // Loading is driven by the two user actions that need it -- opening the dialog and switching
  // direction -- rather than by an effect on [open, mode]. An effect would set state
  // synchronously on mount and re-run on every mode change, which is the cascading-render
  // pattern the lint rule flags, and it would also refetch on unrelated re-renders.
  const openWith = (nextMode: Mode) => {
    setMode(nextMode)
    setOpen(true)
    void load(nextMode)
  }

  const switchMode = (nextMode: Mode) => {
    if (nextMode === mode) return
    setMode(nextMode)
    void load(nextMode)
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const apply = async () => {
    setSaving(true)
    setError(null)
    const res = await bulkSetTrackInventoryAction({
      selectedIds: [...selected],
      target: mode === 'on',
      confirmBlocking: confirmedBlocking,
    })
    setSaving(false)
    if ('error' in res && res.error) {
      setError(res.error)
      return
    }
    setResult({
      changed: res.data?.changed ?? [],
      alreadyInState: res.data?.alreadyInState ?? [],
      lostRace: res.data?.lostRace ?? [],
      message: res.data?.message ?? '',
    })
    router.refresh()
  }

  if (!canEdit) return null

  const blockedUnconfirmed = mode === 'on' && wouldBlock.length > 0 && !confirmedBlocking

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => openWith('off')}>
        Bulk tracking
      </Button>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setResult(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bulk inventory tracking</DialogTitle>
            <DialogDescription>
              Changes only whether stock is deducted on sale. Recipes and ingredient quantities
              are never touched.
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
                {result.message}
              </div>
              {result.changed.length > 0 ? (
                <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
                  {result.changed.map((c) => (
                    <li key={c.menuItemId} className="flex items-center justify-between rounded border border-[#E9E9E7] px-2 py-1">
                      <span>{c.name}</span>
                      <Badge variant="outline">{mode === 'off' ? 'tracking off' : 'tracking on'}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.lostRace.length > 0 ? (
                <p className="text-sm text-amber-800">
                  {result.lostRace.length} item(s) were changed by someone else while this ran and
                  were left alone: {result.lostRace.map((c) => c.name).join(', ')}.
                </p>
              ) : null}
              <DialogFooter>
                <Button onClick={() => { setResult(null); void load(mode) }}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === 'off' ? 'default' : 'outline'}
                  onClick={() => switchMode('off')}
                >
                  Turn tracking off
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'on' ? 'default' : 'outline'}
                  onClick={() => switchMode('on')}
                >
                  Turn tracking on
                </Button>
              </div>

              {mode === 'off' ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Stock will stop deducting for these items. Balances will drift from reality
                  until you turn tracking back on and do a stock count. Recipes are preserved.
                </div>
              ) : (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  Stock will start deducting again. Any item whose ingredient balance is at or
                  below zero will stop accepting orders immediately.
                </div>
              )}

              {error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  {error}
                </div>
              ) : null}

              <div className="flex items-center justify-between text-sm">
                <span className="text-[#6B675F]">
                  {selected.size} of {relevant.length} selected
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-[#FF6B35] hover:underline"
                    onClick={() => setSelected(new Set(relevant.map((c) => c.menuItemId)))}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-[#6B675F] hover:underline"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-[#E9E9E7] p-2">
                {loading ? (
                  <p className="p-2 text-sm text-[#6B675F]">Loading…</p>
                ) : relevant.length === 0 ? (
                  <p className="p-2 text-sm text-[#6B675F]">
                    Nothing to change — every item is already {mode === 'off' ? 'untracked' : 'tracked'}.
                  </p>
                ) : (
                  relevant.map((c) => {
                    const blocks =
                      mode === 'on' &&
                      c.hasLiveRecipe &&
                      c.lowestIngredientBalance !== null &&
                      c.lowestIngredientBalance <= 0
                    return (
                      <label
                        key={c.menuItemId}
                        className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-[#F7F6F3]"
                      >
                        <Checkbox
                          checked={selected.has(c.menuItemId)}
                          onCheckedChange={() => toggle(c.menuItemId)}
                        />
                        <span className="flex-1 text-sm">{c.name}</span>
                        {blocks ? (
                          <Badge variant="destructive" className="text-xs">
                            would block — {c.blockingIngredients.join(', ')} at{' '}
                            {c.lowestIngredientBalance}
                          </Badge>
                        ) : null}
                        {mode === 'on' && !c.hasLiveRecipe ? (
                          <Badge variant="outline" className="text-xs">no recipe — will not deduct</Badge>
                        ) : null}
                      </label>
                    )
                  })
                )}
              </div>

              {mode === 'on' && wouldBlock.length > 0 ? (
                <label className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  <Checkbox
                    checked={confirmedBlocking}
                    onCheckedChange={(v) => setConfirmedBlocking(Boolean(v))}
                  />
                  <span>
                    I understand {wouldBlock.length} item(s) will stop accepting orders
                    immediately: {wouldBlock.map((c) => c.name).join(', ')}.
                  </span>
                </label>
              ) : null}

              {noRecipe.length > 0 ? (
                <p className="text-sm text-[#6B675F]">
                  {noRecipe.length} selected item(s) have no recipe, so tracking them will not
                  deduct anything yet.
                </p>
              ) : null}

              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={apply} disabled={saving || selected.size === 0 || blockedUnconfirmed}>
                  {saving
                    ? 'Applying…'
                    : mode === 'off'
                      ? `Turn off ${selected.size} item(s)`
                      : `Turn on ${selected.size} item(s)`}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
