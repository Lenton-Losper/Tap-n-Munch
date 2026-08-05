/**
 * Bulk menu_items.track_inventory toggle.
 *
 * The scenario these guard is real: at Mingle Brew & Pour on 2026-08-05, 16 of 17 recipes had
 * track_inventory = true with quantities entered as stock counts, and 8 menu items were being
 * refused live by check_stock_sufficiency_locked. Turning tracking off item by item, mid
 * service, was the only available remedy — twice.
 */
import {
  BULK_TRACKING_AUDIT_ACTION,
  buildTrackingAuditRows,
  planBulkTrackingChange,
  summarizeBulkTrackingResult,
  wouldBlockWhenTracked,
  type TrackingCandidate,
} from '@/lib/recipes/bulk-tracking'

function candidate(over: Partial<TrackingCandidate> & { menuItemId: string }): TrackingCandidate {
  return {
    name: over.menuItemId,
    tracked: false,
    hasLiveRecipe: true,
    lowestIngredientBalance: 10,
    blockingIngredients: [],
    ...over,
  }
}

/** The eight Mingle items the deployed gate was refusing, plus the healthy ones. */
const MINGLE: TrackingCandidate[] = [
  candidate({ menuItemId: 'pizza', name: 'Pizza', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Pizza'] }),
  candidate({ menuItemId: 'croissant', name: 'Plain croissant', tracked: true, lowestIngredientBalance: -80, blockingIngredients: ['Croissant'] }),
  candidate({ menuItemId: 'still', name: 'Still water 500ml', tracked: true, lowestIngredientBalance: -80, blockingIngredients: ['Still water x 500ml'] }),
  candidate({ menuItemId: 'milkshake', name: 'Milkshake', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Milkshake'] }),
  candidate({ menuItemId: 'biltong', name: 'Biltong', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Biltong'] }),
  candidate({ menuItemId: 'chili', name: 'Chili bites', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Chili bites'] }),
  candidate({ menuItemId: 'droewors', name: 'Droe wors', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Droe wors'] }),
  candidate({ menuItemId: 'cheesecake', name: 'Cheesecake', tracked: true, lowestIngredientBalance: 0, blockingIngredients: ['Cheesecake'] }),
  candidate({ menuItemId: 'sparkling', name: 'Sparkling water 500ml', tracked: true, lowestIngredientBalance: 53 }),
  candidate({ menuItemId: 'sprite', name: 'Sprite', tracked: true, lowestIngredientBalance: 72 }),
  candidate({ menuItemId: 'coke', name: 'Coke', tracked: false, lowestIngredientBalance: 100 }),
]

const ALL_IDS = MINGLE.map((c) => c.menuItemId)

describe('wouldBlockWhenTracked — mirrors the deployed gate predicate', () => {
  it('blocks at or below zero', () => {
    expect(wouldBlockWhenTracked(candidate({ menuItemId: 'a', lowestIngredientBalance: 0 }))).toBe(true)
    expect(wouldBlockWhenTracked(candidate({ menuItemId: 'a', lowestIngredientBalance: -80 }))).toBe(true)
  })

  it('does not block above zero, however small', () => {
    expect(wouldBlockWhenTracked(candidate({ menuItemId: 'a', lowestIngredientBalance: 1 }))).toBe(false)
    expect(wouldBlockWhenTracked(candidate({ menuItemId: 'a', lowestIngredientBalance: 0.01 }))).toBe(false)
  })

  it('does not block an item with no live recipe, whatever the balance', () => {
    expect(
      wouldBlockWhenTracked(
        candidate({ menuItemId: 'a', hasLiveRecipe: false, lowestIngredientBalance: null }),
      ),
    ).toBe(false)
  })
})

describe('bulk OFF — the Mingle mid-service case', () => {
  it('turns off every tracked item in one action', () => {
    const plan = planBulkTrackingChange({ candidates: MINGLE, selectedIds: ALL_IDS, target: false })
    expect(plan.toChange).toHaveLength(10)
    expect(plan.toChange.map((c) => c.name)).toContain('Pizza')
    expect(plan.toChange.map((c) => c.name)).toContain('Plain croissant')
  })

  it('leaves already-off items untouched instead of rewriting them', () => {
    const plan = planBulkTrackingChange({ candidates: MINGLE, selectedIds: ALL_IDS, target: false })
    expect(plan.alreadyInState.map((c) => c.name)).toEqual(['Coke'])
    expect(plan.toChange.map((c) => c.menuItemId)).not.toContain('coke')
  })

  it('never reports a blocking risk when turning off — off cannot refuse an order', () => {
    const plan = planBulkTrackingChange({ candidates: MINGLE, selectedIds: ALL_IDS, target: false })
    expect(plan.wouldBlockImmediately).toEqual([])
    expect(plan.noRecipeNoop).toEqual([])
  })

  it('is idempotent: the second identical run changes nothing', () => {
    const first = planBulkTrackingChange({ candidates: MINGLE, selectedIds: ALL_IDS, target: false })
    const after = MINGLE.map((c) =>
      first.toChange.some((t) => t.menuItemId === c.menuItemId) ? { ...c, tracked: false } : c,
    )
    const second = planBulkTrackingChange({ candidates: after, selectedIds: ALL_IDS, target: false })
    expect(second.toChange).toHaveLength(0)
    expect(second.alreadyInState).toHaveLength(MINGLE.length)
  })
})

describe('bulk ON — the dangerous direction', () => {
  const allOff = MINGLE.map((c) => ({ ...c, tracked: false }))

  it('flags exactly the eight items that would be refused immediately', () => {
    const plan = planBulkTrackingChange({ candidates: allOff, selectedIds: ALL_IDS, target: true })
    expect(plan.wouldBlockImmediately.map((c) => c.name).sort()).toEqual(
      ['Biltong', 'Cheesecake', 'Chili bites', 'Droe wors', 'Milkshake', 'Pizza', 'Plain croissant', 'Still water 500ml'],
    )
  })

  it('carries the offending ingredient names so the warning can be specific', () => {
    const plan = planBulkTrackingChange({ candidates: allOff, selectedIds: ALL_IDS, target: true })
    const croissant = plan.wouldBlockImmediately.find((c) => c.name === 'Plain croissant')
    expect(croissant?.blockingIngredients).toEqual(['Croissant'])
  })

  it('does not flag healthy items', () => {
    const plan = planBulkTrackingChange({ candidates: allOff, selectedIds: ALL_IDS, target: true })
    expect(plan.wouldBlockImmediately.map((c) => c.name)).not.toContain('Sprite')
    expect(plan.wouldBlockImmediately.map((c) => c.name)).not.toContain('Sparkling water 500ml')
  })

  it('reports items with no live recipe as a no-op rather than a success', () => {
    const withOrphan = [
      ...allOff,
      candidate({ menuItemId: 'orphan', name: 'No recipe yet', hasLiveRecipe: false, lowestIngredientBalance: null }),
    ]
    const plan = planBulkTrackingChange({
      candidates: withOrphan,
      selectedIds: ['orphan'],
      target: true,
    })
    expect(plan.noRecipeNoop.map((c) => c.name)).toEqual(['No recipe yet'])
    expect(plan.wouldBlockImmediately).toEqual([])
  })
})

describe('selection handling', () => {
  it('honours a subset rather than acting on everything', () => {
    const plan = planBulkTrackingChange({
      candidates: MINGLE,
      selectedIds: ['pizza', 'biltong'],
      target: false,
    })
    expect(plan.toChange.map((c) => c.name)).toEqual(['Pizza', 'Biltong'])
  })

  it('de-duplicates repeated ids so an item is never written twice', () => {
    const plan = planBulkTrackingChange({
      candidates: MINGLE,
      selectedIds: ['pizza', 'pizza', 'pizza'],
      target: false,
    })
    expect(plan.toChange).toHaveLength(1)
  })

  it('collects unknown ids instead of silently dropping them', () => {
    const plan = planBulkTrackingChange({
      candidates: MINGLE,
      selectedIds: ['pizza', 'not-a-real-id', '  '],
      target: false,
    })
    expect(plan.unknownIds).toEqual(['not-a-real-id'])
    expect(plan.toChange).toHaveLength(1)
  })

  it('does nothing on an empty selection', () => {
    const plan = planBulkTrackingChange({ candidates: MINGLE, selectedIds: [], target: false })
    expect(plan.toChange).toHaveLength(0)
    expect(plan.alreadyInState).toHaveLength(0)
  })
})

describe('audit trail', () => {
  const plan = planBulkTrackingChange({ candidates: MINGLE, selectedIds: ALL_IDS, target: false })
  const rows = buildTrackingAuditRows({
    restaurantId: 'rest-1',
    userId: 'user-1',
    batchId: 'batch-1',
    target: false,
    changed: plan.toChange,
  })

  it('writes one row per changed item — audit_logs currently holds zero menu-entity rows', () => {
    expect(rows).toHaveLength(plan.toChange.length)
    expect(rows.every((r) => r.action === BULK_TRACKING_AUDIT_ACTION)).toBe(true)
  })

  it('makes entity_id lookups work by writing the menu item id', () => {
    expect(rows.map((r) => r.entity_id)).toEqual(plan.toChange.map((c) => c.menuItemId))
    expect(rows.every((r) => r.entity_type === 'menu_item')).toBe(true)
  })

  it('records the transition direction and who did it', () => {
    const meta = rows[0].metadata as Record<string, unknown>
    expect(meta.from).toBe(true)
    expect(meta.to).toBe(false)
    expect(meta.changed_by).toBe('user-1')
  })

  it('ties the run together with a shared batch_id', () => {
    expect(new Set(rows.map((r) => (r.metadata as Record<string, unknown>).batch_id))).toEqual(
      new Set(['batch-1']),
    )
  })

  it('records whether enabling blocked the item, so a later reader can tell', () => {
    const onPlan = planBulkTrackingChange({
      candidates: MINGLE.map((c) => ({ ...c, tracked: false })),
      selectedIds: ALL_IDS,
      target: true,
    })
    const onRows = buildTrackingAuditRows({
      restaurantId: 'rest-1',
      userId: 'user-1',
      batchId: 'batch-2',
      target: true,
      changed: onPlan.toChange,
    })
    const pizza = onRows.find(
      (r) => (r.metadata as Record<string, unknown>).menu_item_name === 'Pizza',
    )
    expect((pizza!.metadata as Record<string, unknown>).blocked_on_enable).toBe(true)
    expect((pizza!.metadata as Record<string, unknown>).blocking_ingredients).toEqual(['Pizza'])
  })

  it('writes nothing when nothing changed', () => {
    expect(
      buildTrackingAuditRows({
        restaurantId: 'rest-1',
        userId: 'user-1',
        batchId: 'batch-3',
        target: false,
        changed: [],
      }),
    ).toEqual([])
  })
})

describe('result summary — never a silent success', () => {
  it('names the items that changed', () => {
    const msg = summarizeBulkTrackingResult({
      target: false,
      changed: [candidate({ menuItemId: 'pizza', name: 'Pizza' })],
      alreadyInState: [],
    })
    expect(msg).toContain('Tracking turned off for 1 item(s)')
    expect(msg).toContain('Pizza')
  })

  it('says so explicitly when a re-run changed nothing', () => {
    const msg = summarizeBulkTrackingResult({
      target: false,
      changed: [],
      alreadyInState: [candidate({ menuItemId: 'pizza', name: 'Pizza' })],
    })
    expect(msg).toContain('No changes')
    expect(msg).toContain('already in that state')
  })

  it('reports the skipped count alongside the changed ones', () => {
    const msg = summarizeBulkTrackingResult({
      target: true,
      changed: [candidate({ menuItemId: 'a', name: 'A' })],
      alreadyInState: [candidate({ menuItemId: 'b', name: 'B' })],
    })
    expect(msg).toContain('Tracking enabled for 1 item(s)')
    expect(msg).toContain('1 already in that state')
  })
})
