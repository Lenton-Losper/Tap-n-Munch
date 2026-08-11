/**
 * READ-ONLY staging probe: does the server charge what the browse page quoted for a
 * variant-group item?
 *
 * Feeds calculateOrderPricing (lib/orders/calculate-order-pricing.ts, the exact function
 * POST /api/orders calls at 21d5133) the exact payload app/menu/[restaurantId]/browse/page.tsx
 * builds in handleAddToCart, for the one staging menu item that has a priced variant group
 * ("Still Water": base_price 18, options 500ml=18 / 1L=30, has_sizes=false, sizes=[]).
 *
 * calculateOrderPricing performs only SELECTs. Nothing here writes.
 *
 * PRODUCTION REFUSAL: allowlist of exactly one project ref (staging).
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { calculateOrderPricing } from '../../lib/orders/calculate-order-pricing'

config({ path: '.env.test' })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '')
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || ''
if (ref !== STAGING_REF) {
  console.error(`REFUSED: resolved project ref "${ref}" is not the staging ref. No query was sent.`)
  process.exit(1)
}

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ITEM = '5fec6f04-968e-4883-a305-924c1b5c5ae4' // Still Water

const db = createClient(url, key, { auth: { persistSession: false } })

/** Exactly the object literal browse/page.tsx:663-677 builds, then cart/page.tsx:370-381 maps. */
function submittedLine(variantLabel: string, quotedPrice: number) {
  return {
    menuItemId: ITEM,
    name: 'Still Water',
    displayName: `Still Water - ${variantLabel}`,
    quantity: 1,
    basePrice: quotedPrice,
    selectedVariants: { Size: variantLabel },
    size: variantLabel,
    addons: [],
    specialInstructions: '',
    subtotal: quotedPrice,
  }
}

async function main() {
  for (const [label, quoted] of [
    ['500ml', 18],
    ['1L', 30],
  ] as const) {
    const pricing = await calculateOrderPricing(db as never, RESTAURANT, [submittedLine(label, quoted)])
    console.log(`\n--- customer picked "${label}" ---`)
    console.log(`  quoted to customer (browse + cart screens): N$${quoted.toFixed(2)}`)
    console.log(`  server-priced total stored on order_request: N$${pricing.total.toFixed(2)}`)
    console.log(`  DIVERGENCE: N$${(quoted - pricing.total).toFixed(2)}`)
    console.log(`  warnings: ${JSON.stringify(pricing.warnings)}`)
  }

  // Control: a plain item with no priced variant group must NOT diverge.
  const { data: plain } = await db
    .from('menu_items')
    .select('id, name, base_price')
    .eq('restaurant_id', RESTAURANT)
    .eq('status', 'available')
    .neq('id', ITEM)
    .limit(1)
    .maybeSingle()
  if (plain) {
    const pricing = await calculateOrderPricing(db as never, RESTAURANT, [
      {
        menuItemId: plain.id,
        name: plain.name,
        quantity: 1,
        basePrice: plain.base_price,
        selectedVariants: {},
        size: null,
        addons: [],
        specialInstructions: '',
        subtotal: plain.base_price,
      },
    ])
    console.log(`\n--- CONTROL: "${plain.name}" (no priced variant group) ---`)
    console.log(`  quoted N$${Number(plain.base_price).toFixed(2)} / priced N$${pricing.total.toFixed(2)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
