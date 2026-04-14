#!/usr/bin/env node
const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()
const RESTAURANT_ID = 'Ffc7xisdhmHl34z1UvnI'
const CATEGORY_NAMES = ['Hot Coffee', 'Tea', 'Iced', 'Milkshakes', 'Cold Drinks']

const SEED_PLAN = {
  'Hot Coffee': [
    {
      name: 'Americano',
      price: 20,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 20 },
        { size: 'L', label: 'Large', price: 30 },
      ],
    },
    {
      name: 'Cappuccino',
      price: 20,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 20 },
        { size: 'L', label: 'Large', price: 35 },
      ],
    },
    {
      name: 'Espresso',
      price: 17,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 17 },
        { size: 'L', label: 'Large', price: 25 },
      ],
    },
    {
      name: 'Café Latte',
      price: 33,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 33 },
        { size: 'L', label: 'Large', price: 38 },
      ],
    },
    {
      name: 'Mocha Latte',
      price: 33,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 33 },
        { size: 'L', label: 'Large', price: 38 },
      ],
    },
    {
      name: 'White Mocha',
      price: 33,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 33 },
        { size: 'L', label: 'Large', price: 38 },
      ],
    },
    {
      name: 'Hot Chocolate',
      price: 33,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 33 },
        { size: 'L', label: 'Large', price: 38 },
      ],
    },
    {
      name: 'Spicy Chai',
      price: 33,
      available: true,
      variants: [
        { size: 'S', label: 'Small', price: 33 },
        { size: 'L', label: 'Large', price: 38 },
      ],
    },
  ],
  Iced: [
    { name: 'Ice Coffee (Caramel / Vanilla / Hazelnut)', price: 40, available: true },
    { name: 'Drip Ice Latte', price: 45, available: true },
  ],
  Milkshakes: [
    { name: 'Milkshake (Chocolate / Strawberry / Banana)', price: 65, available: true },
  ],
  Tea: [
    { name: 'Inhouse Tea (Mixed Berry / Passionfruit)', price: 35, available: true },
    { name: 'Matcha', price: 40, available: true },
    {
      name: 'Tea (Rooibos / Five Roses / Green Tea)',
      price: 25,
      available: true,
      variants: [
        { size: 'S', label: '250ml', price: 25 },
        { size: 'L', label: '350ml', price: 28 },
      ],
    },
  ],
  'Cold Drinks': [
    { name: 'Fruitree', price: 26, available: true },
    { name: 'Coke Can 330ml', price: 22, available: true },
    { name: 'Fanta Orange 330ml', price: 20, available: true },
    { name: 'Powerade', price: 28, available: true },
    { name: 'Coke Bottle', price: 25, available: true },
    { name: 'Sparkling Water', price: 20, available: true },
    { name: 'Still Water', price: 26, available: true },
    { name: 'Sprite 300ml', price: 22, available: true },
    { name: 'Sparberry 300ml', price: 22, available: true },
    { name: 'Creme Soda 300ml', price: 22, available: true },
    { name: 'Stoney 300ml', price: 22, available: true },
  ],
}

async function commitDeletes(deleteRefs) {
  const CHUNK = 450
  let deleted = 0
  for (let i = 0; i < deleteRefs.length; i += CHUNK) {
    const batch = db.batch()
    const chunk = deleteRefs.slice(i, i + CHUNK)
    for (const ref of chunk) batch.delete(ref)
    await batch.commit()
    deleted += chunk.length
  }
  return deleted
}

async function getOrCreateSubcategory(restaurantId, categoryId, name, displayOrderBase = 0) {
  const subPath = `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories`
  const subRef = db.collection(subPath)
  const existing = await subRef.where('name', '==', name).limit(1).get()
  if (!existing.empty) {
    return existing.docs[0].id
  }
  const subDoc = subRef.doc()
  await subDoc.set({
    name,
    description: null,
    display_order: displayOrderBase,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  return subDoc.id
}

async function main() {
  console.log('[seed-drinks-final] Starting cleanup + reseed...')

  const categoriesPath = `restaurants/${RESTAURANT_ID}/menu/data/categories`
  const categoriesRef = db.collection(categoriesPath)
  const allCategoriesSnap = await categoriesRef.get()

  let drinksCategory = allCategoriesSnap.docs.find(
    (d) => String((d.data() || {}).name || '').trim() === 'Drinks'
  )
  if (!drinksCategory) {
    const maxOrder = allCategoriesSnap.docs.reduce((max, d) => {
      const order = Number((d.data() || {}).display_order || 0)
      return Math.max(max, order)
    }, 0)
    const created = categoriesRef.doc()
    await created.set({
      restaurant_id: RESTAURANT_ID,
      name: 'Drinks',
      description: null,
      display_order: maxOrder + 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    const createdSnap = await created.get()
    drinksCategory = createdSnap
    console.log(`[seed-drinks-final] "Drinks" category did not exist; created ${created.id}`)
  }
  const drinksCategoryId = drinksCategory.id
  console.log(`[seed-drinks-final] Drinks category ID: ${drinksCategoryId}`)

  const deleteRefs = []
  const topLevelDeleted = []
  let nestedItemsQueuedForDelete = 0
  let nestedSubcategoriesQueuedForDelete = 0

  // 1) Remove wrong top-level categories + all nested data.
  for (const catDoc of allCategoriesSnap.docs) {
    const catData = catDoc.data() || {}
    const catName = String(catData.name || '').trim()
    if (!CATEGORY_NAMES.includes(catName)) continue
    if (catDoc.id === drinksCategoryId) continue

    const subPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${catDoc.id}/subcategories`
    const subSnap = await db.collection(subPath).get()
    for (const subDoc of subSnap.docs) {
      const itemsPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${catDoc.id}/subcategories/${subDoc.id}/items`
      const itemsSnap = await db.collection(itemsPath).get()
      for (const itemDoc of itemsSnap.docs) {
        deleteRefs.push(itemDoc.ref)
        nestedItemsQueuedForDelete += 1
      }
      deleteRefs.push(subDoc.ref)
      nestedSubcategoriesQueuedForDelete += 1
    }
    deleteRefs.push(catDoc.ref)
    topLevelDeleted.push({ id: catDoc.id, name: catName })
  }

  // 2) Remove any existing subcategories under "Drinks" that we are about to seed + their items.
  const drinksSubPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${drinksCategoryId}/subcategories`
  const drinksSubSnap = await db.collection(drinksSubPath).get()
  for (const subDoc of drinksSubSnap.docs) {
    const subName = String((subDoc.data() || {}).name || '').trim()
    if (!CATEGORY_NAMES.includes(subName)) continue
    const itemsPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${drinksCategoryId}/subcategories/${subDoc.id}/items`
    const itemsSnap = await db.collection(itemsPath).get()
    for (const itemDoc of itemsSnap.docs) {
      deleteRefs.push(itemDoc.ref)
      nestedItemsQueuedForDelete += 1
    }
    deleteRefs.push(subDoc.ref)
    nestedSubcategoriesQueuedForDelete += 1
  }

  const deletedCount = await commitDeletes(deleteRefs)
  console.log(
    `[seed-drinks-final] Cleanup complete. Deleted docs=${deletedCount} (items=${nestedItemsQueuedForDelete}, subcategories=${nestedSubcategoriesQueuedForDelete}, top-level categories=${topLevelDeleted.length})`
  )
  if (topLevelDeleted.length > 0) {
    console.log(
      '[seed-drinks-final] Removed top-level categories:',
      topLevelDeleted.map((c) => `${c.name}(${c.id})`).join(', ')
    )
  } else {
    console.log('[seed-drinks-final] No incorrect top-level categories found to remove.')
  }

  // 3) Recreate subcategories under Drinks and seed items.
  let totalWritten = 0
  for (const [idx, subcategoryName] of CATEGORY_NAMES.entries()) {
    const subId = await getOrCreateSubcategory(RESTAURANT_ID, drinksCategoryId, subcategoryName, idx + 1)
    const itemsPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${drinksCategoryId}/subcategories/${subId}/items`
    const batch = db.batch()
    const items = SEED_PLAN[subcategoryName] || []

    for (const item of items) {
      const itemRef = db.collection(itemsPath).doc()
      const payload = {
        name: item.name,
        description: '',
        image_url: null,
        base_price: Number(item.price),
        has_sizes: false,
        sizes: [],
        has_addons: false,
        addons: [],
        allow_special_instructions: true,
        status: item.available ? 'available' : 'out_of_stock',
        times_ordered: 0,
        total_revenue: 0,
        variants: Array.isArray(item.variants)
          ? item.variants.map((variant) => ({
              size: String(variant.size),
              label: String(variant.label),
              price: Number(variant.price),
            }))
          : [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: new Date().toISOString(),
      }
      batch.set(itemRef, payload)
    }

    await batch.commit()
    totalWritten += items.length
    console.log(
      `[seed-drinks-final] Seeded subcategory "${subcategoryName}" (${subId}) with ${items.length} items`
    )
  }

  console.log(`[seed-drinks-final] Done. Total items written under Drinks: ${totalWritten}`)
}

main().catch((err) => {
  console.error('[seed-drinks-final] Failed:', err?.message || err)
  process.exit(1)
})
