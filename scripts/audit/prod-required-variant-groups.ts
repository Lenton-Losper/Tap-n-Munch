/**
 * READ-ONLY PRODUCTION probe for #200's residual lead:
 *   FIVE variant groups are `required: true` while every order line carries an EMPTY selection.
 *   Question: are those items ORDERABLE AT ALL?
 *
 * This script answers only the measurement half. The behaviour half is answered from code.
 *
 * SAFETY
 *  - refuses on anything that is not the production ref, BEFORE a client is constructed;
 *  - uses `.select()` exclusively. No .insert/.update/.delete/.upsert/.rpc appears in this file.
 *    Verify with:  grep -nE "\.(insert|update|delete|upsert|rpc)\(" <this file>   -> zero hits.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '')
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || ''
if (ref !== PROD_REF) {
  throw new Error(`REFUSED: resolved project ref "${ref}" is not the production ref. No client was constructed, no query was sent.`)
}
if (!key) {
  throw new Error('REFUSED: no service role key resolved.')
}

const db = createClient(url, key, { auth: { persistSession: false } })

type Group = { name?: unknown; required?: unknown; type?: unknown; options?: unknown }

/** app/menu/[restaurantId]/browse/page.tsx:274-306, transcribed exactly. */
function normalizeVariantGroups(groups: unknown): Array<{ name: string; required: boolean; type: string; options: unknown[] }> {
  if (!Array.isArray(groups)) return []
  return groups
    .map((group) => {
      const raw = (group || {}) as Group
      const groupName = String(raw.name || '').trim()
      const groupType = raw.type === 'price' ? 'price' : raw.type === 'text' ? 'text' : null
      const rawOptions = Array.isArray(raw.options) ? raw.options : []
      if (!groupName || !groupType || rawOptions.length === 0) return null
      const options = rawOptions
        .map((opt) => {
          if (typeof opt === 'string') return opt
          if (!opt || typeof opt !== 'object') return null
          const label = String((opt as { label?: unknown; name?: unknown }).label || (opt as { name?: unknown }).name || '').trim()
          if (!label) return null
          if (groupType === 'text') return label
          const price = Number((opt as { price?: unknown }).price)
          if (!Number.isFinite(price)) return null
          return { label, price }
        })
        .filter(Boolean) as unknown[]
      if (options.length === 0) return null
      return { name: groupName, required: Boolean(raw.required), type: groupType, options }
    })
    .filter(Boolean) as Array<{ name: string; required: boolean; type: string; options: unknown[] }>
}

function firstDefaultLabel(options: unknown[]): string {
  const first = options[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') return String((first as { label?: unknown }).label || '')
  return ''
}

async function selectAll<T>(table: string, columns: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db.from(table).select(columns).range(from, from + pageSize - 1)
    if (error) throw error
    const rows = (data ?? []) as unknown as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

async function main() {
  console.log(`connected READ-ONLY to production ref ${ref}\n`)

  const restaurants = await selectAll<{ id: string; name: string | null }>('restaurants', 'id, name')
  const restaurantName = new Map(restaurants.map((r) => [String(r.id), String(r.name ?? '(unnamed)')]))

  const menuItems = await selectAll<{
    id: string
    restaurant_id: string | null
    name: string | null
    status: string | null
    base_price: number | null
    has_sizes: boolean | null
    has_addons: boolean | null
    sizes: unknown
    addons: unknown
    variants: unknown
    variant_groups: unknown
  }>('menu_items', 'id, restaurant_id, name, status, base_price, has_sizes, has_addons, sizes, addons, variants, variant_groups')

  console.log(`menu_items scanned: ${menuItems.length}`)

  const withGroups = menuItems.filter((m) => Array.isArray(m.variant_groups) && (m.variant_groups as unknown[]).length > 0)
  console.log(`menu_items with a non-empty variant_groups array: ${withGroups.length}`)

  // Keyed off the RAW jsonb, not the normalised view -- a group the client DROPS is still a
  // group the menu editor marked required, and dropping it is the thing under investigation.
  const requiredItems = withGroups
    .filter((m) => (m.variant_groups as Group[]).some((g) => Boolean(g?.required)))
    .map((m) => ({ item: m, groups: normalizeVariantGroups(m.variant_groups) }))

  const rawRequiredCount = withGroups.reduce(
    (n, m) => n + (m.variant_groups as Group[]).filter((g) => Boolean(g?.required)).length,
    0,
  )
  console.log(`variant groups with required:true (RAW jsonb, pre-normalisation): ${rawRequiredCount}`)
  console.log(`menu_items carrying >=1 SURVIVING required group: ${requiredItems.length}\n`)

  console.log('=== THE REQUIRED-GROUP ITEMS ===')
  for (const { item, groups } of requiredItems) {
    const rid = String(item.restaurant_id ?? '')
    console.log(`\nitem ${item.id}  "${item.name}"`)
    console.log(`  restaurant : ${rid}  ${restaurantName.get(rid) ?? '(unknown)'}`)
    console.log(`  status=${item.status}  base_price=${item.base_price}  has_sizes=${item.has_sizes}  has_addons=${item.has_addons}`)
    console.log(`  sizes=${JSON.stringify(item.sizes)}  addons=${JSON.stringify(item.addons)}`)
    for (const g of item.variant_groups as Group[]) {
      if (!g?.required) continue
      const nm = String(g?.name || '').trim()
      const survived = groups.find((s) => s.name === nm && s.required)
      console.log(`  RAW required group ${JSON.stringify(g)}`)
      if (survived) {
        console.log(
          `    -> SURVIVES normalisation; getDefaultGroupSelection preselects ${JSON.stringify(firstDefaultLabel(survived.options))} (blank => Add disabled)`,
        )
      } else {
        console.log('    -> DROPPED by normaliseVariantGroups: not rendered, not enforced')
      }
    }
    // LEGACY fallback, browse/page.tsx:263-272 + 315-325: when normalisation yields nothing,
    // a `variants` row of {size,label,price} synthesises a REQUIRED priced "Size" group.
    const legacy = Array.isArray(item.variants)
      ? (item.variants as Array<Record<string, unknown>>).filter(
          (v) => v && typeof v.size === 'string' && typeof v.label === 'string' && Number.isFinite(Number(v.price)),
        )
      : []
    console.log(`  legacy variants column = ${JSON.stringify(item.variants)}`)
    console.log(`  legacy variants passing the browse filter: ${legacy.length}`)

    const effectiveGroups = groups.length > 0 ? groups : legacy.length > 0 ? [{ name: 'Size', required: true, type: 'price', options: legacy.map((v) => ({ label: String(v.label), price: Number(v.price) })) }] : []
    console.log(`  EFFECTIVE getVariantGroups() => ${effectiveGroups.length} group(s) ${JSON.stringify(effectiveGroups.map((g) => g.name))}`)
    if (effectiveGroups.length === 0) {
      console.log('    => no selector rendered, isRequiredVariantMissing()=false, selected_variants={}')
    } else {
      const dflt = firstDefaultLabel(effectiveGroups[0].options)
      console.log(`    => selector rendered; default preselection ${JSON.stringify(dflt)} (blank would disable Add)`)
    }

    // Which browse code path this item takes (browse/page.tsx:632).
    const hasInline = effectiveGroups.length > 0
    const quickAdd = (!item.has_sizes && !item.has_addons) || (hasInline && !item.has_addons)
    console.log(`  browse path: ${quickAdd ? 'QUICK-ADD (variant selectors rendered)' : 'ItemDetailModal (NO variant UI)'}`)
  }

  // Also surface required groups that normalisation DROPS -- those are invisible in the UI.
  console.log('\n=== REQUIRED GROUPS DROPPED BY NORMALISATION (invisible + unenforced) ===')
  let dropped = 0
  for (const m of withGroups) {
    const surviving = new Set(normalizeVariantGroups(m.variant_groups).map((g) => g.name))
    for (const g of m.variant_groups as Group[]) {
      if (!g?.required) continue
      const nm = String(g?.name || '').trim()
      if (!nm || !surviving.has(nm)) {
        dropped += 1
        console.log(`  item ${m.id} "${m.name}" group ${JSON.stringify(g)}`)
      }
    }
  }
  if (dropped === 0) console.log('  none')

  // ---- order history ----
  const targetIds = new Set(requiredItems.map((e) => e.item.id))
  const orders = await selectAll<{
    id: string
    restaurant_id: string | null
    channel: string | null
    status: string | null
    payment_status: string | null
    placed_at: string | null
    items: unknown
  }>('orders', 'id, restaurant_id, channel, status, payment_status, placed_at, items')

  console.log(`\n=== ORDER HISTORY ===`)
  console.log(`orders scanned: ${orders.length}`)

  const perRestaurantOrders = new Map<string, number>()
  for (const o of orders) {
    const rid = String(o.restaurant_id ?? '')
    perRestaurantOrders.set(rid, (perRestaurantOrders.get(rid) ?? 0) + 1)
  }

  let linesForTargets = 0
  let linesEmptySelection = 0
  let linesNonEmptySelection = 0
  const sample: string[] = []
  const crossTab = new Map<string, number>()
  for (const o of orders) {
    if (!Array.isArray(o.items)) continue
    for (const line of o.items as Array<Record<string, unknown>>) {
      const mid = String(line?.menuItemId ?? line?.menu_item_id ?? '')
      if (!targetIds.has(mid)) continue
      linesForTargets += 1
      const sel = (line?.selectedVariants ?? line?.selected_variants) as Record<string, unknown> | undefined
      const keys = sel && typeof sel === 'object' ? Object.keys(sel).filter((k) => String(sel[k] ?? '').trim()) : []
      const bucket = `${keys.length === 0 ? 'EMPTY' : 'SELECTED'} / channel=${String(o.channel ?? 'null')}`
      crossTab.set(bucket, (crossTab.get(bucket) ?? 0) + 1)
      if (keys.length === 0) linesEmptySelection += 1
      else linesNonEmptySelection += 1
      if (sample.length < 12) {
        sample.push(
          `  order ${o.id} ch=${o.channel} status=${o.status} placed=${o.placed_at} name=${JSON.stringify(line?.name)} displayName=${JSON.stringify(line?.displayName ?? line?.display_name)} selectedVariants=${JSON.stringify(sel)}`,
        )
      }
    }
  }
  console.log(`order lines referencing a required-group item: ${linesForTargets}`)
  console.log(`  with an EMPTY/blank variant selection : ${linesEmptySelection}`)
  console.log(`  with a real variant selection        : ${linesNonEmptySelection}`)
  console.log('cross-tab (selection x channel):')
  for (const [k, v] of [...crossTab.entries()].sort()) console.log(`  ${k}: ${v}`)
  if (sample.length) {
    console.log('sample lines:')
    for (const s of sample) console.log(s)
  }

  console.log('\n=== TRAFFIC ON THE OWNING RESTAURANTS ===')
  const owning = new Set(requiredItems.map((e) => String(e.item.restaurant_id ?? '')))
  for (const rid of owning) {
    const total = perRestaurantOrders.get(rid) ?? 0
    const byChannel = new Map<string, number>()
    let latest = ''
    for (const o of orders) {
      if (String(o.restaurant_id ?? '') !== rid) continue
      const ch = String(o.channel ?? 'null')
      byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1)
      const p = String(o.placed_at ?? '')
      if (p > latest) latest = p
    }
    console.log(
      `  ${rid} "${restaurantName.get(rid) ?? '(unknown)'}": ${total} orders, channels=${JSON.stringify(Object.fromEntries(byChannel))}, latest=${latest || 'never'}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
