import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { buildMenuItemDbPayload } from '@/lib/menu-item-db-payload'
import {
  validateMenuItemDraft,
  type ExistingMenuItem,
  type MenuItemDraft,
} from '@/lib/menu/validate-menu-item'
import { invalidateMenuCache } from '@/lib/cache/menu-cache'

export const dynamic = 'force-dynamic'

const LOG_PREFIX = '[API/admin/menu/items]'

/**
 * #272. The customer menu is cached in Redis (`lib/cache/menu-cache.ts`) and NOTHING in
 * this route cleared it, so a menu edit kept serving the stale payload for the whole
 * `TTL.MENU` window. That matters most for the status fix shipping alongside this: setting
 * an item inactive would have changed nothing a customer could see, and read as a failed fix.
 *
 * The cache key is built from the restaurantId that appears in the CUSTOMER url
 * (`app/api/menu/[restaurantId]/category/[categoryId]/route.ts`), and Riviera's subdomain
 * rewrites to the bare UUID (`next.config.mjs`) — the same id resolved here, so these keys
 * do match. Non-UUID aliases in a customer URL would cache under a different key; none are
 * in use today.
 *
 * Never allowed to fail the write. `invalidateMenuCache` already swallows its own Redis
 * errors; this wrapper catches anything left, so a cache problem cannot lose a saved edit.
 */
async function invalidateMenuCacheAfterWrite(restaurantId: string) {
  try {
    await invalidateMenuCache(restaurantId)
  } catch (err) {
    console.error(`${LOG_PREFIX} menu cache invalidation failed`, err)
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function logRouteError(context: string, error: unknown) {
  console.error(`${LOG_PREFIX} ${context}`)
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    console.error(`${LOG_PREFIX} ${context} (serialized)`, {
      name: record.name,
      message: record.message,
      code: record.code,
      details: record.details,
      hint: record.hint,
    })
  }
  if (error instanceof Error) {
    console.error(`${LOG_PREFIX} ${context} message:`, error.message)
    if (error.stack) {
      console.error(`${LOG_PREFIX} ${context} stack:`, error.stack)
    }
  }
  console.error(`${LOG_PREFIX} ${context} full error object:`, error)
}

async function resolveRestaurantId(supabase: ReturnType<typeof createServerSupabaseClient>, input: string) {
  if (isUuid(input)) {
    console.log(`${LOG_PREFIX} restaurant input is Supabase UUID, using directly`, { input })
    return input
  }

  console.log(`${LOG_PREFIX} resolving non-UUID restaurant id`, { input })

  const { data: byFirebaseRestaurantId, error: firebaseRestaurantIdError } = await supabase
    .from('restaurants')
    .select('id, firebase_restaurant_id, firebase_id')
    .eq('firebase_restaurant_id', input)
    .maybeSingle()

  if (firebaseRestaurantIdError) {
    logRouteError('resolveRestaurantId firebase_restaurant_id lookup failed', firebaseRestaurantIdError)
    throw firebaseRestaurantIdError
  }

  if (byFirebaseRestaurantId?.id) {
    console.log(`${LOG_PREFIX} resolved restaurant via firebase_restaurant_id`, {
      input,
      restaurantId: byFirebaseRestaurantId.id,
    })
    return byFirebaseRestaurantId.id as string
  }

  const { data: byFirebaseId, error: firebaseIdError } = await supabase
    .from('restaurants')
    .select('id, firebase_restaurant_id, firebase_id')
    .eq('firebase_id', input)
    .maybeSingle()

  if (firebaseIdError) {
    const message = String((firebaseIdError as { message?: string }).message || '')
    if (!message.includes('firebase_id')) {
      logRouteError('resolveRestaurantId firebase_id lookup failed', firebaseIdError)
      throw firebaseIdError
    }
    console.warn(`${LOG_PREFIX} firebase_id column not available, skipping firebase_id lookup`, {
      input,
      message,
    })
  } else if (byFirebaseId?.id) {
    console.log(`${LOG_PREFIX} resolved restaurant via firebase_id`, {
      input,
      restaurantId: byFirebaseId.id,
    })
    return byFirebaseId.id as string
  }

  const notFoundError = new Error(`Restaurant not found for id=${input}`)
  logRouteError('resolveRestaurantId restaurant not found', notFoundError)
  throw notFoundError
}

async function fetchExistingMenuItems(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
): Promise<ExistingMenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('id, name, subcategory_id, category_id')
    .eq('restaurant_id', restaurantId)

  if (error) throw error

  return (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    subCategoryId: (row.subcategory_id as string | null) ?? null,
    categoryId: (row.category_id as string | null) ?? null,
  }))
}

/** Ingredients are saved via saveRecipeAction, not this route — only parse if ever sent. */
function parseIngredientRowsFromBody(
  body: Record<string, unknown>,
): MenuItemDraft['ingredientRows'] {
  const raw = body.ingredient_rows ?? body.ingredientRows ?? body.ingredients
  if (!Array.isArray(raw)) return []

  return raw.map((row) => {
    const record = row as Record<string, unknown>
    return {
      stockItemId: String(record.stockItemId ?? record.stock_item_id ?? ''),
      quantity: (record.quantity ?? '') as string | number,
      unitId: String(record.unitId ?? record.unit_id ?? ''),
    }
  })
}

function validationErrorResponse(blockingErrors: string[]) {
  return NextResponse.json({ error: blockingErrors.join(' ') }, { status: 400 })
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = (await request.json()) as Record<string, any>
    const restaurantInput = String(body?.restaurant_id || '').trim()
    if (!restaurantInput) {
      return NextResponse.json({ error: 'Missing restaurant_id' }, { status: 400 })
    }

    console.log(`${LOG_PREFIX} POST request`, {
      restaurantInput,
      restaurantInputIsUuid: isUuid(restaurantInput),
      categoryId: body.category_id ?? body.menu_category_id ?? null,
      subCategoryId: body.sub_category_id ?? body.subcategory_id ?? body.sub_categoryId ?? null,
      name: body.name,
    })

    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantInput)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied
    const categoryId = body.category_id ?? body.menu_category_id ?? null
    const subCategoryId = (body.sub_category_id ?? body.subcategory_id ?? body.sub_categoryId) || null
    const basePrice = Number(body.base_price ?? 0)
    const name = String(body.name || '').trim()
    const description = body.description ? String(body.description) : null
    const imageUrl = body.image_url ? String(body.image_url) : null
    if (!name) {
      return NextResponse.json({ error: 'Missing item name' }, { status: 400 })
    }
    if (!categoryId) {
      return NextResponse.json({ error: 'Missing category id' }, { status: 400 })
    }
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return NextResponse.json({ error: 'Invalid price' }, { status: 400 })
    }

    const existingItems = await fetchExistingMenuItems(supabase, restaurantId)
    const { blockingErrors } = validateMenuItemDraft(
      {
        name,
        categoryId: categoryId ? String(categoryId) : null,
        subCategoryId: subCategoryId || null,
        ingredientRows: parseIngredientRowsFromBody(body),
      },
      existingItems,
    )
    if (blockingErrors.length > 0) {
      return validationErrorResponse(blockingErrors)
    }

    const payload = buildMenuItemDbPayload({
      ...body,
      category_id: categoryId,
      subcategory_id: subCategoryId,
      name,
      description,
      image_url: imageUrl,
      base_price: basePrice,
      is_popular: Boolean(body.is_popular),
    })

    payload.restaurant_id = restaurantId

    console.log(`${LOG_PREFIX} inserting menu item`, { payloadKeys: Object.keys(payload) })

    const { data, error } = await supabase
      .from('menu_items')
      .insert(payload)
      .select()
      .single()

    if (error) {
      logRouteError('insert failed', error)
      throw error
    }

    console.log(`${LOG_PREFIX} insert succeeded`, { id: data?.id })
    await invalidateMenuCacheAfterWrite(restaurantId)
    return NextResponse.json({ success: true, id: data?.id, data })
  } catch (error: unknown) {
    logRouteError('POST handler failed', error)
    const err = error as { message?: string; code?: string; details?: string }
    return NextResponse.json(
      {
        error: err?.message || 'Failed to create menu item',
        code: err?.code || null,
        details: err?.details || null,
      },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = (await request.json()) as Record<string, any>
    const itemId = String(body?.id || body?.item_id || '').trim()
    const restaurantInput = String(body?.restaurant_id || '').trim()

    if (!itemId) {
      return NextResponse.json({ error: 'Missing menu item id' }, { status: 400 })
    }
    if (!restaurantInput) {
      return NextResponse.json({ error: 'Missing restaurant_id' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantInput)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied

    const categoryId = body.category_id ?? body.menu_category_id ?? undefined
    const subCategoryId =
      body.subcategory_id ?? body.sub_category_id ?? body.sub_categoryId ?? undefined

    const existingItems = await fetchExistingMenuItems(supabase, restaurantId)
    const existingItem = existingItems.find((item) => item.id === itemId)
    const draftName =
      body.name !== undefined ? String(body.name || '').trim() : (existingItem?.name ?? '')
    const draftCategoryId =
      categoryId !== undefined
        ? categoryId
          ? String(categoryId)
          : null
        : (existingItem?.categoryId ?? null)
    const draftSubCategoryId =
      subCategoryId !== undefined
        ? subCategoryId
          ? String(subCategoryId)
          : null
        : (existingItem?.subCategoryId ?? null)

    const { blockingErrors } = validateMenuItemDraft(
      {
        itemId,
        name: draftName,
        categoryId: draftCategoryId,
        subCategoryId: draftSubCategoryId,
        ingredientRows: parseIngredientRowsFromBody(body),
      },
      existingItems,
    )
    if (blockingErrors.length > 0) {
      return validationErrorResponse(blockingErrors)
    }

    const payload = buildMenuItemDbPayload({
      ...body,
      category_id: categoryId,
      subcategory_id: subCategoryId,
    })

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    payload.updated_at = new Date().toISOString()

    console.log(`${LOG_PREFIX} PATCH`, { itemId, restaurantId, payloadKeys: Object.keys(payload) })

    const { data, error } = await supabase
      .from('menu_items')
      .update(payload)
      .eq('id', itemId)
      .eq('restaurant_id', restaurantId)
      .select()
      .maybeSingle()

    if (error) {
      logRouteError('PATCH update failed', error)
      throw error
    }

    if (!data) {
      return NextResponse.json({ error: 'Menu item not found' }, { status: 404 })
    }

    await invalidateMenuCacheAfterWrite(restaurantId)
    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    logRouteError('PATCH handler failed', error)
    const err = error as { message?: string; code?: string; details?: string }
    const message = err?.message || 'Failed to update menu item'
    const status =
      message.includes('authorization') ||
      message.includes('session') ||
      message.includes('permission')
        ? 403
        : 500
    return NextResponse.json(
      {
        error: message,
        code: err?.code || null,
        details: err?.details || null,
      },
      { status }
    )
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    let itemId = ''
    let restaurantInput = ''

    const contentType = request.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>
      itemId = String(body?.id || body?.item_id || '').trim()
      restaurantInput = String(body?.restaurant_id || '').trim()
    } else {
      const url = new URL(request.url)
      itemId = String(url.searchParams.get('id') || url.searchParams.get('item_id') || '').trim()
      restaurantInput = String(url.searchParams.get('restaurant_id') || '').trim()
    }

    if (!itemId) {
      return NextResponse.json({ error: 'Missing menu item id' }, { status: 400 })
    }
    if (!restaurantInput) {
      return NextResponse.json({ error: 'Missing restaurant_id' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantInput)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied

    console.log(`${LOG_PREFIX} DELETE`, { itemId, restaurantId })

    const { error: hardDeleteError } = await supabase
      .from('menu_items')
      .delete()
      .eq('id', itemId)
      .eq('restaurant_id', restaurantId)

    if (!hardDeleteError) {
      await invalidateMenuCacheAfterWrite(restaurantId)
      return NextResponse.json({ success: true, deleted: true })
    }

    logRouteError('DELETE hard delete failed, trying soft hide', hardDeleteError)

    const { data, error: softError } = await supabase
      .from('menu_items')
      .update({ status: 'hidden', updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('restaurant_id', restaurantId)
      .select('id')
      .maybeSingle()

    if (softError) {
      logRouteError('DELETE soft hide failed', softError)
      throw softError
    }

    if (!data) {
      return NextResponse.json({ error: 'Menu item not found' }, { status: 404 })
    }

    await invalidateMenuCacheAfterWrite(restaurantId)
    return NextResponse.json({ success: true, deleted: false, hidden: true })
  } catch (error: unknown) {
    logRouteError('DELETE handler failed', error)
    const err = error as { message?: string; code?: string; details?: string }
    const message = err?.message || 'Failed to delete menu item'
    const status =
      message.includes('authorization') ||
      message.includes('session') ||
      message.includes('permission')
        ? 403
        : 500
    return NextResponse.json(
      {
        error: message,
        code: err?.code || null,
        details: err?.details || null,
      },
      { status }
    )
  }
}
