import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const LOG_PREFIX = '[API/admin/menu/items]'

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

export async function POST(request: Request) {
  try {
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

    const payload = {
      restaurant_id: restaurantId,
      category_id: categoryId,
      subcategory_id: subCategoryId,
      name,
      description,
      image_url: imageUrl,
      base_price: basePrice,
    }

    console.log(`${LOG_PREFIX} inserting menu item`, { payload })

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
