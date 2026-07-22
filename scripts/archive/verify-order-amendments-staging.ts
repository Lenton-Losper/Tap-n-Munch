/**
 * Staging verification: order amendments API + order_revisions + stock effects.
 *   npx tsx scripts/verify-order-amendments-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { amendOrder } from '../lib/orders/amend-order'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `amend-${Date.now()}`

const created = {
  orderIds: [] as string[],
  menuItemIds: [] as string[],
  recipeIds: [] as string[],
  recipeItemIds: [] as string[],
  stockItemIds: [] as string[],
  orgStockItemIds: [] as string[],
  staffMemberIds: [] as string[],
  userIds: [] as string[],
  revisionIds: [] as string[],
}

async function cleanup() {
  if (created.revisionIds.length) {
    await db.from('stock_movements').delete().eq('reference_type', 'order_revision').in('reference_id', created.revisionIds)
  }
  if (created.orderIds.length) {
    await db.from('order_revisions').delete().in('order_id', created.orderIds)
    await db.from('stock_movements').delete().eq('reference_type', 'order').in('reference_id', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
  if (created.recipeItemIds.length) {
    await db.from('recipe_items').delete().in('id', created.recipeItemIds)
  }
  if (created.recipeIds.length) {
    await db.from('recipes').delete().in('id', created.recipeIds)
  }
  if (created.menuItemIds.length) {
    await db.from('menu_items').delete().in('id', created.menuItemIds)
  }
  if (created.stockItemIds.length) {
    await db.from('stock_movements').delete().in('stock_item_id', created.stockItemIds)
    await db.from('stock_items').delete().in('id', created.stockItemIds)
  }
  if (created.orgStockItemIds.length) {
    await db.from('organization_stock_items').delete().in('id', created.orgStockItemIds)
  }
  for (const userId of created.userIds) {
    await db.auth.admin.deleteUser(userId)
  }
  if (created.staffMemberIds.length) {
    await db.from('staff_members').delete().in('id', created.staffMemberIds)
  }
}

async function ensureManagerUser(): Promise<{ userId: string; staffMemberId: string }> {
  const email = `${tag}.manager@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1`

  const { data: authUser, error: authError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authError || !authUser.user) throw authError ?? new Error('createUser failed')
  created.userIds.push(authUser.user.id)

  await db.from('users').upsert({
    id: authUser.user.id,
    email,
  })

  await db.from('restaurant_users').insert({
    user_id: authUser.user.id,
    restaurant_id: TEST_RESTAURANT_ID,
    role: 'manager',
  })

  const { data: staffMember, error: staffError } = await db
    .from('staff_members')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      email,
      role: 'manager',
      active: true,
    })
    .select('id')
    .single()

  if (staffError || !staffMember) throw staffError ?? new Error('staff member insert failed')
  created.staffMemberIds.push(staffMember.id)

  return { userId: authUser.user.id, staffMemberId: staffMember.id }
}

async function seedRecipeFixture(): Promise<{ menuItemId: string; stockItemId: string }> {
  const { data: unit, error: unitError } = await db
    .from('measurement_units')
    .select('id')
    .is('restaurant_id', null)
    .eq('name', 'g')
    .single()
  if (unitError || !unit) throw unitError ?? new Error('unit missing')

  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .select('organization_id')
    .eq('id', TEST_RESTAURANT_ID)
    .single()
  if (restaurantError || !restaurant?.organization_id) {
    throw restaurantError ?? new Error('restaurant has no organization_id')
  }

  const { data: orgStockItem, error: orgStockItemError } = await db
    .from('organization_stock_items')
    .insert({
      organization_id: restaurant.organization_id,
      name: `${tag} ingredient`,
      base_unit_id: unit.id,
    })
    .select('id')
    .single()
  if (orgStockItemError || !orgStockItem) throw orgStockItemError ?? new Error('org stock item failed')
  created.orgStockItemIds.push(orgStockItem.id)

  const { data: stockItem, error: stockError } = await db
    .from('stock_items')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      organization_stock_item_id: orgStockItem.id,
      name: `${tag} ingredient`,
      unit_id: unit.id,
      is_purchasable: true,
      is_active: true,
    })
    .select('id')
    .single()
  if (stockError || !stockItem) throw stockError ?? new Error('stock item failed')
  created.stockItemIds.push(stockItem.id)

  const { data: category, error: categoryError } = await db
    .from('menu_categories')
    .select('id')
    .eq('restaurant_id', TEST_RESTAURANT_ID)
    .limit(1)
    .maybeSingle()
  if (categoryError) throw categoryError

  const { data: menuItem, error: menuError } = await db
    .from('menu_items')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      category_id: category?.id ?? null,
      name: `${tag} Burger`,
      base_price: 45,
      status: 'active',
    })
    .select('id')
    .single()
  if (menuError || !menuItem) throw menuError ?? new Error('menu item failed')
  created.menuItemIds.push(menuItem.id)

  const { data: recipe, error: recipeError } = await db
    .from('recipes')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      menu_item_id: menuItem.id,
      name: `${tag} recipe`,
      is_active: true,
    })
    .select('id')
    .single()
  if (recipeError || !recipe) throw recipeError ?? new Error('recipe failed')
  created.recipeIds.push(recipe.id)

  const { data: recipeItem, error: recipeItemError } = await db
    .from('recipe_items')
    .insert({
      recipe_id: recipe.id,
      stock_item_id: stockItem.id,
      quantity: 2,
      unit_id: unit.id,
    })
    .select('id')
    .single()
  if (recipeItemError || !recipeItem) throw recipeItemError ?? new Error('recipe item failed')
  created.recipeItemIds.push(recipeItem.id)

  return { menuItemId: menuItem.id, stockItemId: stockItem.id }
}

async function createPaidOrder(menuItemId: string, status: string, preparingAt: string | null) {
  const lineId = randomUUID()
  const items = [
    {
      id: lineId,
      menuItemId: menuItemId,
      menu_item_id: menuItemId,
      name: `${tag} Burger`,
      quantity: 3,
      basePrice: 45,
      subtotal: 135,
      route_to: 'kitchen',
    },
  ]

  const { data: order, error } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 99,
      status,
      preparing_at: preparingAt,
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      subtotal: 135,
      total: 135,
      items,
      channel: 'pos',
    })
    .select('id')
    .single()

  if (error || !order) throw error ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  if (status === 'completed') {
    const { error: completeError } = await db
      .from('orders')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', order.id)
    if (completeError) throw completeError
  }

  return { orderId: order.id, lineId, menuItemId }
}

async function main() {
  await cleanup()

  const { userId } = await ensureManagerUser()
  const { menuItemId, stockItemId } = await seedRecipeFixture()

  const { orderId, lineId } = await createPaidOrder(menuItemId, 'accepted', null)

  const revision1 = await amendOrder(db, userId, {
    orderId,
    reason: 'Customer changed mind on one item',
    changes: [
      {
        item_id: lineId,
        action: 'quantity_changed',
        quantity_delta: -1,
        price_delta: -45,
        reason: 'Reduce quantity before prep',
      },
    ],
  })

  created.revisionIds.push(revision1.revisionId)

  if (revision1.revisionNumber !== 1) {
    throw new Error(`Expected revision_number 1, got ${revision1.revisionNumber}`)
  }
  if (revision1.changes[0]?.stock_action !== 'reversed') {
    throw new Error(`Revision 1 expected stock_action reversed, got ${revision1.changes[0]?.stock_action}`)
  }

  const rev1Movements = await db
    .from('stock_movements')
    .select('id, quantity_delta, reason, adjustment_type')
    .eq('reference_type', 'order_revision')
    .eq('reference_id', revision1.revisionId)

  if ((rev1Movements.data ?? []).length !== 0) {
    throw new Error('Revision 1 (pre-completion) should not insert stock movements')
  }

  await db
    .from('orders')
    .update({
      status: 'preparing',
      preparing_at: new Date().toISOString(),
    })
    .eq('id', orderId)

  await db
    .from('orders')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', orderId)

  const revision2 = await amendOrder(db, userId, {
    orderId,
    reason: 'Further reduction after prep started',
    changes: [
      {
        item_id: lineId,
        action: 'quantity_changed',
        quantity_delta: -1,
        price_delta: -45,
        reason: 'Item already in prep',
      },
    ],
  })

  created.revisionIds.push(revision2.revisionId)

  if (revision2.revisionNumber !== 2) {
    throw new Error(`Expected revision_number 2, got ${revision2.revisionNumber}`)
  }
  if (revision2.changes[0]?.stock_action !== 'waste') {
    throw new Error(`Revision 2 expected stock_action waste, got ${revision2.changes[0]?.stock_action}`)
  }

  const rev2Movements = await db
    .from('stock_movements')
    .select('stock_item_id, quantity_delta, reason, adjustment_type')
    .eq('reference_type', 'order_revision')
    .eq('reference_id', revision2.revisionId)

  const wasteRows = rev2Movements.data ?? []
  if (wasteRows.length !== 1) {
    throw new Error(`Expected 1 waste movement for revision 2, got ${wasteRows.length}`)
  }
  if (wasteRows[0]?.adjustment_type !== 'waste' || Number(wasteRows[0]?.quantity_delta) !== -2) {
    throw new Error(`Unexpected waste movement: ${JSON.stringify(wasteRows[0])}`)
  }
  if (wasteRows[0]?.stock_item_id !== stockItemId) {
    throw new Error('Waste movement linked to wrong stock item')
  }

  const { data: orderRow } = await db
    .from('orders')
    .select('total, items')
    .eq('id', orderId)
    .single()

  const items = Array.isArray(orderRow?.items) ? orderRow.items : []
  const qty = Number((items[0] as { quantity?: number })?.quantity ?? 0)
  if (qty !== 1) {
    throw new Error(`Expected final quantity 1, got ${qty}`)
  }
  if (Number(orderRow?.total) !== 45) {
    throw new Error(`Expected final total 45, got ${orderRow?.total}`)
  }

  console.log('ORDER_AMENDMENTS_STAGING_VERIFY_OK', {
    orderId,
    revision1: revision1.revisionNumber,
    revision2: revision2.revisionNumber,
    stock_actions: [revision1.changes[0]?.stock_action, revision2.changes[0]?.stock_action],
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('ORDER_AMENDMENTS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
