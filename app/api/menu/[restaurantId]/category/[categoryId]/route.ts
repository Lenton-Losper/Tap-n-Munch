import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin-firestore'
import { getCachedMenu, setCachedMenu } from '@/lib/cache/menu-cache'
import { subCategoriesPath, menuItemsPath } from '@/lib/firebase/paths'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ restaurantId: string; categoryId: string }> }
) {
  const { restaurantId, categoryId } = await context.params

  if (!restaurantId || !categoryId) {
    return NextResponse.json({ error: 'Missing restaurantId/categoryId' }, { status: 400 })
  }

  try {
    const cached = await getCachedMenu(restaurantId, categoryId)
    if (cached) {
      return NextResponse.json(cached)
    }

    const db = adminDb()
    if (!db) {
      return NextResponse.json({ error: 'Server Firestore is not configured' }, { status: 503 })
    }

    const subSnap = await db
      .collection(subCategoriesPath(restaurantId, categoryId))
      .where('active', '==', true)
      .orderBy('display_order', 'asc')
      .get()

    const groupedEntries = await Promise.all(
      subSnap.docs.map(async (subDoc) => {
        const subcategory = { id: subDoc.id, ...subDoc.data() }
        const itemSnap = await db
          .collection(menuItemsPath(restaurantId, categoryId, subDoc.id))
          .where('status', '==', 'available')
          .orderBy('name', 'asc')
          .get()
        const items = itemSnap.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
        return [subDoc.id, { subcategory, items }] as const
      })
    )

    const payload = Object.fromEntries(groupedEntries)
    await setCachedMenu(restaurantId, payload, categoryId)
    return NextResponse.json(payload)
  } catch (error) {
    console.error('[MENU API] Failed to fetch category menu:', error)
    return NextResponse.json({ error: 'Failed to load menu' }, { status: 500 })
  }
}
