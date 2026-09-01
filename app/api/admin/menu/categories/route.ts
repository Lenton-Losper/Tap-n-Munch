import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import {
  loadCategoryForRestaurant,
  requireMenuWriteContext,
} from '@/lib/api/menu-route-auth'
import {
  readBothAcknowledgement,
  validateCategoryRouteWrite,
} from '@/lib/menu/category-routing'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const auth = await requireMenuWriteContext(user.id)
    if (auth instanceof NextResponse) return auth

    const { supabase, restaurantId } = auth
    const body = await request.json()
    const name = String(body?.name || '').trim()
    const description = body?.description ? String(body.description).trim() : null
    const requestedRoute = String(body?.route_to || body?.routeTo || 'kitchen').trim()

    if (!name) {
      return NextResponse.json(
        { error: 'Missing category name' },
        { status: 400 },
      )
    }

    // Previously this cast an arbitrary string straight into the insert, so an unrecognised
    // route_to surfaced as a raw Postgres CHECK violation with a 500. Validate here, and make
    // 'both' require the acknowledgement -- see lib/menu/category-routing.ts for why.
    const routeCheck = validateCategoryRouteWrite(requestedRoute, readBothAcknowledgement(body))
    if (!routeCheck.ok) {
      return NextResponse.json({ error: routeCheck.error }, { status: 400 })
    }
    const routeTo = routeCheck.route

    const { data: existing, error: findError } = await supabase
      .from('menu_categories')
      .select('id, name')
      .eq('restaurant_id', restaurantId)
      .ilike('name', name)
      .maybeSingle()

    if (findError) throw findError
    if (existing?.id) {
      return NextResponse.json({ success: true, id: existing.id, data: existing, created: false })
    }

    const { data, error } = await supabase
      .from('menu_categories')
      .insert({
        restaurant_id: restaurantId,
        name,
        description,
        route_to: routeTo,
        active: true,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, id: data.id, data, created: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create category'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
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

    /**
     * BULK ROUTE-TO, deliberately its own branch rather than a loop over the single-category
     * path below. Setting kitchen/bar/both is the ONE field a manager needs to change across
     * many categories at once during setup -- "nineteen categories one at a time is not a setup
     * flow" -- so bulk mode is scoped to exactly that field, not general bulk-editing.
     */
    if (Array.isArray(body?.categoryIds)) {
      const categoryIds = body.categoryIds.map((id) => String(id).trim()).filter(Boolean)
      const routeTo = String(body?.route_to || body?.routeTo || '').trim()

      if (categoryIds.length === 0) {
        return NextResponse.json({ error: 'categoryIds must be a non-empty array' }, { status: 400 })
      }
      // Bulk is the highest-blast-radius way to set 'both' -- one click can put nineteen
      // categories behind a two-station gate -- so it takes the same acknowledgement as the
      // single-category path, not a weaker one.
      const bulkCheck = validateCategoryRouteWrite(routeTo, readBothAcknowledgement(body))
      if (!bulkCheck.ok) {
        return NextResponse.json({ error: bulkCheck.error }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('menu_categories')
        .update({ route_to: bulkCheck.route, updated_at: new Date().toISOString() })
        .eq('restaurant_id', restaurantId)
        .in('id', categoryIds)
        .select('id')

      if (error) throw error

      return NextResponse.json({ success: true, updatedCount: (data ?? []).length })
    }

    const categoryId = String(body?.categoryId || body?.id || '').trim()

    if (!categoryId) {
      return NextResponse.json({ error: 'Missing category id' }, { status: 400 })
    }

    const category = await loadCategoryForRestaurant(supabase, categoryId, restaurantId)
    if (!category) {
      return NextResponse.json({ error: 'Category not found for this restaurant' }, { status: 403 })
    }

    const updates: Record<string, unknown> = {}
    if ('name' in body) {
      const name = String(body.name || '').trim()
      if (!name) {
        return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
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
    /**
     * Only a write that actually SETS route_to is checked. Renaming a category that is already
     * 'both' does not re-assert its routing and must keep working untouched -- that is what stops
     * this guard from breaking the venues currently running 'both' on purpose.
     */
    if ('route_to' in body || 'routeTo' in body) {
      const singleCheck = validateCategoryRouteWrite(
        String(body.route_to || body.routeTo || 'kitchen'),
        readBothAcknowledgement(body),
      )
      if (!singleCheck.ok) {
        return NextResponse.json({ error: singleCheck.error }, { status: 400 })
      }
      updates.route_to = singleCheck.route
    }
    if ('active' in body) {
      updates.active = Boolean(body.active)
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('menu_categories')
      .update(updates)
      .eq('id', categoryId)
      .eq('restaurant_id', restaurantId)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update category'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const auth = await requireMenuWriteContext(user.id)
    if (auth instanceof NextResponse) return auth

    const { supabase, restaurantId } = auth
    const body = (await request.json()) as { categoryId?: string; id?: string }
    const categoryId = String(body?.categoryId || body?.id || '').trim()

    if (!categoryId) {
      return NextResponse.json({ error: 'Missing category id' }, { status: 400 })
    }

    const category = await loadCategoryForRestaurant(supabase, categoryId, restaurantId)
    if (!category) {
      return NextResponse.json({ error: 'Category not found for this restaurant' }, { status: 403 })
    }

    const { data: subcats, error: subErr } = await supabase
      .from('menu_subcategories')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('category_id', categoryId)
    if (subErr) throw subErr

    const subIds = (subcats || []).map((s) => String(s.id))
    if (subIds.length > 0) {
      const { error: itemErr } = await supabase
        .from('menu_items')
        .delete()
        .in('subcategory_id', subIds)
      if (itemErr) throw itemErr
      const { error: subDelErr } = await supabase
        .from('menu_subcategories')
        .delete()
        .in('id', subIds)
      if (subDelErr) throw subDelErr
    }

    const { error: catErr } = await supabase
      .from('menu_categories')
      .delete()
      .eq('id', categoryId)
      .eq('restaurant_id', restaurantId)
    if (catErr) throw catErr

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete category'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
