/**
 * STAGING verification for the bulk track_inventory toggle.
 *
 * Exercises the real code path at the data layer: loadTrackingCandidates ->
 * planBulkTrackingChange -> the same UPDATE/INSERT bulkSetTrackInventoryAction performs, then
 * asserts the outcome. The server action's session/permission layer is not reachable from a
 * script, so RECIPE_EDIT gating is covered by unit tests and by reading the action; everything
 * below it is covered here against a real database.
 *
 * REFUSES to run against production. Restores every row it touches, and removes its own audit
 * rows, so staging is left exactly as found.
 *
 *   npx tsx --env-file=.env.test scripts/verify-bulk-tracking-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import {
  BULK_TRACKING_AUDIT_ACTION,
  buildTrackingAuditRows,
  planBulkTrackingChange,
  summarizeBulkTrackingResult,
} from '../lib/recipes/bulk-tracking'
import { loadTrackingCandidates } from '../lib/recipes/bulk-tracking-actions'

// .env.test uses SUPABASE_URL; .env.local uses NEXT_PUBLIC_SUPABASE_URL. Accept either, then
// assert which project it actually is below — the name is not the safety check, the ref is.
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

if (url.includes(PRODUCTION_REF)) {
  throw new Error('REFUSING: this is the PRODUCTION project. Run with --env-file=.env.test')
}
if (!url.includes(STAGING_REF)) {
  throw new Error(`REFUSING: expected staging (${STAGING_REF}), got ${url}`)
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`) }
}

async function main() {
  console.log(`=== STAGING verification (${STAGING_REF}) ===\n`)

  const { data: rests } = await db.from('restaurants').select('id, name').limit(50)
  let restaurantId = ''
  let candidates: Awaited<ReturnType<typeof loadTrackingCandidates>> = []
  for (const r of rests ?? []) {
    const c = await loadTrackingCandidates(db as never, String(r.id))
    if (c.length >= 2) { restaurantId = String(r.id); candidates = c; console.log(`restaurant: ${r.name} (${c.length} menu items)\n`); break }
  }
  if (!restaurantId) throw new Error('No staging restaurant with menu items found')

  const before = new Map(candidates.map((c) => [c.menuItemId, c.tracked]))
  const target = true
  const subject = candidates.filter((c) => !c.tracked).slice(0, 3)
  if (subject.length === 0) throw new Error('No untracked staging menu items to exercise')
  const ids = subject.map((c) => c.menuItemId)
  console.log(`subject items: ${subject.map((c) => c.name).join(', ')}\n`)

  // Snapshot the tables that must NOT change.
  const snap = async (t: string, cols: string) =>
    JSON.stringify((await db.from(t).select(cols).order('id')).data ?? [])
  const recipesBefore = await snap('recipes', 'id, menu_item_id, is_active, deleted_at')
  const recipeItemsBefore = await snap('recipe_items', 'id, recipe_id, stock_item_id, quantity')
  const stockItemsBefore = await snap('stock_items', 'id, is_active')

  // ---------------------------------------------------------------- run 1
  console.log('--- run 1: apply ---')
  const plan = planBulkTrackingChange({ candidates, selectedIds: ids, target })
  check('plan selects exactly the untracked subjects', plan.toChange.length === subject.length)

  const { data: updated1 } = await db
    .from('menu_items')
    .update({ track_inventory: target })
    .eq('restaurant_id', restaurantId)
    .in('id', plan.toChange.map((c) => c.menuItemId))
    .eq('track_inventory', !target)
    .select('id')
  check('UPDATE changed every planned row', (updated1 ?? []).length === plan.toChange.length,
    `changed ${(updated1 ?? []).length} of ${plan.toChange.length}`)

  const batchId = `verify_${Date.now()}`
  const changed1 = plan.toChange.filter((c) =>
    new Set((updated1 ?? []).map((r) => String(r.id))).has(c.menuItemId))
  const { error: auditErr } = await db.from('audit_logs').insert(
    buildTrackingAuditRows({ restaurantId, userId: 'verify-script', batchId, target, changed: changed1 }))
  check('audit rows inserted', !auditErr, auditErr?.message)

  const { data: auditRows } = await db.from('audit_logs')
    .select('entity_id, entity_type, action, metadata')
    .eq('action', BULK_TRACKING_AUDIT_ACTION)
    .contains('metadata', { batch_id: batchId })
  check('one audit row per changed item', (auditRows ?? []).length === changed1.length,
    `${(auditRows ?? []).length} rows for ${changed1.length} items`)
  check('audit rows carry entity_type=menu_item and the menu item id',
    (auditRows ?? []).every((r) => r.entity_type === 'menu_item' && ids.includes(String(r.entity_id))))
  check('audit metadata records the transition direction',
    (auditRows ?? []).every((r) => {
      const m = r.metadata as Record<string, unknown>
      return m.from === !target && m.to === target
    }))

  const afterState = await db.from('menu_items').select('id, track_inventory').in('id', ids)
  check('all subjects now tracked',
    (afterState.data ?? []).every((r) => r.track_inventory === target))

  // ---------------------------------------------------------------- run 2 (idempotency)
  console.log('\n--- run 2: identical re-run must be a no-op ---')
  const candidates2 = await loadTrackingCandidates(db as never, restaurantId)
  const plan2 = planBulkTrackingChange({ candidates: candidates2, selectedIds: ids, target })
  check('plan now reports zero rows to change', plan2.toChange.length === 0)
  check('plan reports them as already-in-state', plan2.alreadyInState.length === subject.length)

  const { data: updated2 } = await db
    .from('menu_items')
    .update({ track_inventory: target })
    .eq('restaurant_id', restaurantId)
    .in('id', ids)
    .eq('track_inventory', !target)
    .select('id')
  check('DB guard matches zero rows on re-run', (updated2 ?? []).length === 0,
    `matched ${(updated2 ?? []).length}`)
  check('summary says so rather than reporting a silent success',
    summarizeBulkTrackingResult({ target, changed: [], alreadyInState: plan2.alreadyInState })
      .includes('No changes'))

  // ---------------------------------------------------------------- isolation
  console.log('\n--- isolation: recipes / recipe_items / stock_items untouched ---')
  check('recipes unchanged', (await snap('recipes', 'id, menu_item_id, is_active, deleted_at')) === recipesBefore)
  check('recipe_items unchanged (quantities preserved)',
    (await snap('recipe_items', 'id, recipe_id, stock_item_id, quantity')) === recipeItemsBefore)
  check('stock_items.is_active unchanged', (await snap('stock_items', 'id, is_active')) === stockItemsBefore)

  // ---------------------------------------------------------------- blocking preview
  console.log('\n--- blocking preview reflects real balances ---')
  const withBalances = candidates2.filter((c) => c.hasLiveRecipe && c.lowestIngredientBalance !== null)
  console.log(`  (${withBalances.length} staging items have a live recipe and a computable balance)`)
  const offPlan = planBulkTrackingChange({
    candidates: candidates2, selectedIds: candidates2.map((c) => c.menuItemId), target: false })
  check('turning OFF never reports a blocking risk', offPlan.wouldBlockImmediately.length === 0)
  const onPlan = planBulkTrackingChange({
    candidates: candidates2.map((c) => ({ ...c, tracked: false })),
    selectedIds: candidates2.map((c) => c.menuItemId), target: true })
  const expected = candidates2.filter(
    (c) => c.hasLiveRecipe && c.lowestIngredientBalance !== null && c.lowestIngredientBalance <= 0)
  check('turning ON flags exactly the at-or-below-zero items',
    onPlan.wouldBlockImmediately.length === expected.length,
    `flagged ${onPlan.wouldBlockImmediately.length}, expected ${expected.length}`)

  // ---------------------------------------------------------------- restore
  console.log('\n--- restore: leaving staging exactly as found ---')
  for (const id of ids) {
    await db.from('menu_items').update({ track_inventory: before.get(id) ?? false }).eq('id', id)
  }
  const restored = await db.from('menu_items').select('id, track_inventory').in('id', ids)
  check('track_inventory restored',
    (restored.data ?? []).every((r) => r.track_inventory === (before.get(String(r.id)) ?? false)))

  const { error: delErr } = await db.from('audit_logs')
    .delete().eq('action', BULK_TRACKING_AUDIT_ACTION).contains('metadata', { batch_id: batchId })
  check('verification audit rows removed', !delErr, delErr?.message)

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('VERIFY THREW:', e); process.exit(1) })
