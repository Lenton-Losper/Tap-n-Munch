import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import {
  loadCategoryForRestaurant,
  loadSubcategoryForRestaurant,
  requireMenuWriteContext,
} from '@/lib/api/menu-route-auth'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const auth = await requireMenuWriteContext(user.id)
    if (auth instanceof NextResponse) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as {
      categoryId?: string
      name?: string
      description?: string
    }

    const categoryId = String(body?.categoryId || '').trim()
    const name = String(body?.name || '').trim()
    const description = body?.description?.trim() || null

    if (!categoryId || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const category = await loadCategoryForRestaurant(supabase, categoryId, restaurantId)
    if (!category) {
      return NextResponse.json(
        { error: 'Category not found for this restaurant' },
        { status: 403 },
      )
    }

    const { data, error } = await supabase
      .from('menu_subcategories')
      .insert({
        restaurant_id: restaurantId,
        category_id: categoryId,
        name,
        description,
      })
      .select()
      .single()

    if (error) {
      const msg = String((error as { message?: string }).message || '')
      if (msg.includes('foreign key') || msg.includes('violates')) {
        return NextResponse.json(
          { error: 'Category not found for this restaurant' },
          { status: 403 },
        )
      }
      throw error
    }
    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create sub-category'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const auth = await requireMenuWriteContext(user.id)
    if (auth instanceof NextResponse) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as Record<string, unknown>
    const subCategoryId = String(body?.subCategoryId || body?.id || '').trim()
    const categoryId = String(body?.categoryId || '').trim()

    if (!subCategoryId) {
      return NextResponse.json({ error: 'Missing sub-category id' }, { status: 400 })
    }

    const subcategory = await loadSubcategoryForRestaurant(supabase, subCategoryId, restaurantId)
    if (!subcategory) {
      return NextResponse.json(
        { error: 'Sub-category not found for this restaurant' },
        { status: 403 },
      )
    }

    if (categoryId) {
      const category = await loadCategoryForRestaurant(supabase, categoryId, restaurantId)
      if (!category) {
        return NextResponse.json(
          { error: 'Category not found for this restaurant' },
          { status: 403 },
        )
      }
    }

    const updates: Record<string, unknown> = {}
    if (categoryId) updates.category_id = categoryId
    if ('name' in body) {
      const name = String(body.name || '').trim()
      if (!name) {
        return NextResponse.json({ error: 'Sub-category name is required' }, { status: 400 })
      }
      updates.name = name
    }
    if ('description' in body) {
      const description = body.description
      updates.description =
        typeof description === 'string' && description.trim() ? description.trim() : null
    }
    if ('display_order' in body) {
      updates.display_order = Number(body.display_order)
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('menu_subcategories')
      .update(updates)
      .eq('id', subCategoryId)
      .eq('restaurant_id', restaurantId)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update sub-category'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const auth = await requireMenuWriteContext(user.id)
    if (auth instanceof NextResponse) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as {
      subCategoryId?: string
      id?: string
    }
    const subCategoryId = String(body?.subCategoryId || body?.id || '').trim()

    if (!subCategoryId) {
      return NextResponse.json({ error: 'Missing sub-category id' }, { status: 400 })
    }

    const subcategory = await loadSubcategoryForRestaurant(supabase, subCategoryId, restaurantId)
    if (!subcategory) {
      return NextResponse.json(
        { error: 'Sub-category not found for this restaurant' },
        { status: 403 },
      )
    }

    const { error: itemErr } = await supabase
      .from('menu_items')
      .delete()
      .eq('subcategory_id', subCategoryId)
    if (itemErr) throw itemErr

    const { error: subErr } = await supabase
      .from('menu_subcategories')
      .delete()
      .eq('id', subCategoryId)
      .eq('restaurant_id', restaurantId)
    if (subErr) throw subErr

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete sub-category'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
