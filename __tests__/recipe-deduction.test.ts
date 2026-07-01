import { getSupabaseAdmin } from './helpers'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

const RESTAURANT_ID = TEST_RESTAURANT_ID
const RECIPE_QTY_1 = 2.5
const RECIPE_QTY_2 = 1.5
const ORDER_QTY_SINGLE = 3
const ORDER_QTY_MULTI = 2

describe('deduct_recipe_stock idempotency (staging)', () => {
  const admin = getSupabaseAdmin()
  const runTag = `recipe-ded-${Date.now()}`

  const created = {
    stockItemIds: [] as string[],
    menuItemIds: [] as string[],
    recipeIds: [] as string[],
    recipeItemIds: [] as string[],
    orderIds: [] as string[],
  }

  let stockItemId1: string
  let stockItemId2: string
  let menuItemWithRecipeId: string
  let menuItemNoRecipeId: string
  let recipeId: string
  let orderWithRecipeId: string

  async function movementsForOrder(orderId: string) {
    const { data, error } = await admin
      .from('stock_movements')
      .select('id, stock_item_id, quantity_delta, reference_type, reference_id, reason')
      .eq('reference_type', 'order')
      .eq('reference_id', orderId)
    expect(error).toBeNull()
    return data ?? []
  }

  async function completeOrder(orderId: string) {
    const { data, error } = await admin
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', orderId)
      .select('id, status')
      .single()
    expect(error).toBeNull()
    expect(data?.status).toBe('completed')
    return data
  }

  async function deleteTestData() {
    const orderIds = [...created.orderIds]
    if (orderIds.length) {
      await admin.from('stock_movements').delete().eq('reference_type', 'order').in('reference_id', orderIds)
      await admin.from('orders').delete().in('id', orderIds)
    }
    if (created.recipeItemIds.length) {
      await admin.from('recipe_items').delete().in('id', created.recipeItemIds)
    }
    if (created.recipeIds.length) {
      await admin.from('recipes').delete().in('id', created.recipeIds)
    }
    if (created.menuItemIds.length) {
      await admin.from('menu_items').delete().in('id', created.menuItemIds)
    }
    if (created.stockItemIds.length) {
      await admin.from('stock_movements').delete().in('stock_item_id', created.stockItemIds)
      await admin.from('stock_items').delete().in('id', created.stockItemIds)
    }
  }

  beforeAll(async () => {
    jest.setTimeout(60_000)
    await deleteTestData()

    const { data: stock1, error: stock1Err } = await admin
      .from('stock_items')
      .insert({
        restaurant_id: RESTAURANT_ID,
        name: `${runTag} ingredient-a`,
        base_unit: 'g',
        is_purchasable: true,
        is_manufactured: false,
        is_active: true,
      })
      .select('id')
      .single()
    expect(stock1Err).toBeNull()
    stockItemId1 = stock1!.id
    created.stockItemIds.push(stockItemId1)

    const { data: stock2, error: stock2Err } = await admin
      .from('stock_items')
      .insert({
        restaurant_id: RESTAURANT_ID,
        name: `${runTag} ingredient-b`,
        base_unit: 'ml',
        is_purchasable: true,
        is_manufactured: false,
        is_active: true,
      })
      .select('id')
      .single()
    expect(stock2Err).toBeNull()
    stockItemId2 = stock2!.id
    created.stockItemIds.push(stockItemId2)

    const { data: menuWith, error: menuWithErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: RESTAURANT_ID,
        name: `${runTag} menu-with-recipe`,
        base_price: 10,
        status: 'active',
      })
      .select('id')
      .single()
    expect(menuWithErr).toBeNull()
    menuItemWithRecipeId = menuWith!.id
    created.menuItemIds.push(menuItemWithRecipeId)

    const { data: menuNo, error: menuNoErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: RESTAURANT_ID,
        name: `${runTag} menu-no-recipe`,
        base_price: 5,
        status: 'active',
      })
      .select('id')
      .single()
    expect(menuNoErr).toBeNull()
    menuItemNoRecipeId = menuNo!.id
    created.menuItemIds.push(menuItemNoRecipeId)

    const { data: recipe, error: recipeErr } = await admin
      .from('recipes')
      .insert({
        restaurant_id: RESTAURANT_ID,
        menu_item_id: menuItemWithRecipeId,
        name: `${runTag} bom`,
        is_active: true,
      })
      .select('id')
      .single()
    expect(recipeErr).toBeNull()
    recipeId = recipe!.id
    created.recipeIds.push(recipeId)

    const { data: recipeItem, error: recipeItemErr } = await admin
      .from('recipe_items')
      .insert({
        recipe_id: recipeId,
        stock_item_id: stockItemId1,
        quantity: RECIPE_QTY_1,
        unit: 'g',
      })
      .select('id')
      .single()
    expect(recipeItemErr).toBeNull()
    created.recipeItemIds.push(recipeItem!.id)

    const orderNumber = 980_000 + (Date.now() % 10_000)
    const { data: order, error: orderErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID,
        order_number: orderNumber,
        table_number: 99,
        status: 'accepted',
        payment_status: 'unpaid',
        total: 30,
        items: [
          {
            menu_item_id: menuItemWithRecipeId,
            name: `${runTag} menu-with-recipe`,
            quantity: ORDER_QTY_SINGLE,
            price: 10,
          },
        ],
        is_closed: false,
      })
      .select('id')
      .single()
    expect(orderErr).toBeNull()
    orderWithRecipeId = order!.id
    created.orderIds.push(orderWithRecipeId)
  }, 60_000)

  afterAll(async () => {
    await deleteTestData()
  }, 60_000)

  test('deducts stock correctly on order completion', async () => {
    await completeOrder(orderWithRecipeId)

    const movements = await movementsForOrder(orderWithRecipeId)
    const forItem = movements.filter((m) => m.stock_item_id === stockItemId1)
    expect(forItem).toHaveLength(1)
    expect(forItem[0].reason).toBe('sale')
    expect(Number(forItem[0].quantity_delta)).toBe(-(RECIPE_QTY_1 * ORDER_QTY_SINGLE))
  })

  test('does not double-deduct on manual re-invocation', async () => {
    const { error } = await admin.rpc('deduct_recipe_stock', { p_order_id: orderWithRecipeId })
    expect(error).toBeNull()

    const movements = await movementsForOrder(orderWithRecipeId)
    const forItem = movements.filter((m) => m.stock_item_id === stockItemId1)
    expect(forItem).toHaveLength(1)
    expect(Number(forItem[0].quantity_delta)).toBe(-(RECIPE_QTY_1 * ORDER_QTY_SINGLE))
  })

  test('does not double-deduct on a status flip retry', async () => {
    const { error: readyErr } = await admin
      .from('orders')
      .update({ status: 'ready' })
      .eq('id', orderWithRecipeId)
    expect(readyErr).toBeNull()

    await completeOrder(orderWithRecipeId)

    const movements = await movementsForOrder(orderWithRecipeId)
    const forItem = movements.filter((m) => m.stock_item_id === stockItemId1)
    expect(forItem).toHaveLength(1)
  })

  test('skips silently when no recipe exists', async () => {
    const orderNumber = 981_000 + (Date.now() % 10_000)
    const { data: order, error: insertErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID,
        order_number: orderNumber,
        table_number: 99,
        status: 'accepted',
        payment_status: 'unpaid',
        total: 5,
        items: [
          {
            menu_item_id: menuItemNoRecipeId,
            name: `${runTag} menu-no-recipe`,
            quantity: 1,
            price: 5,
          },
        ],
        is_closed: false,
      })
      .select('id')
      .single()
    expect(insertErr).toBeNull()
    const noRecipeOrderId = order!.id
    created.orderIds.push(noRecipeOrderId)

    await completeOrder(noRecipeOrderId)

    const movements = await movementsForOrder(noRecipeOrderId)
    expect(movements).toHaveLength(0)
  })

  test('handles multiple ingredients correctly', async () => {
    const { data: secondItem, error: secondItemErr } = await admin
      .from('recipe_items')
      .insert({
        recipe_id: recipeId,
        stock_item_id: stockItemId2,
        quantity: RECIPE_QTY_2,
        unit: 'ml',
      })
      .select('id')
      .single()
    expect(secondItemErr).toBeNull()
    created.recipeItemIds.push(secondItem!.id)

    const orderNumber = 982_000 + (Date.now() % 10_000)
    const { data: multiOrder, error: multiErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID,
        order_number: orderNumber,
        table_number: 99,
        status: 'accepted',
        payment_status: 'unpaid',
        total: 20,
        items: [
          {
            menu_item_id: menuItemWithRecipeId,
            name: `${runTag} menu-with-recipe`,
            quantity: ORDER_QTY_MULTI,
            price: 10,
          },
        ],
        is_closed: false,
      })
      .select('id')
      .single()
    expect(multiErr).toBeNull()
    const multiOrderId = multiOrder!.id
    created.orderIds.push(multiOrderId)

    await completeOrder(multiOrderId)

    const movements = await movementsForOrder(multiOrderId)
    expect(movements).toHaveLength(2)

    const rowA = movements.find((m) => m.stock_item_id === stockItemId1)
    const rowB = movements.find((m) => m.stock_item_id === stockItemId2)
    expect(rowA).toBeDefined()
    expect(rowB).toBeDefined()
    expect(Number(rowA!.quantity_delta)).toBe(-(RECIPE_QTY_1 * ORDER_QTY_MULTI))
    expect(Number(rowB!.quantity_delta)).toBe(-(RECIPE_QTY_2 * ORDER_QTY_MULTI))
  })
})
