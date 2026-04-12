#!/usr/bin/env node
const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()
const TARGET_EMAIL = 'flashtaptestacc1@gmail.com'

const menuItems = [
  { name: 'Glazed', price: 18, category: 'Doughnuts', available: true },
  { name: 'Sugar', price: 18, category: 'Doughnuts', available: true },
  { name: 'Cinnamon Sugar', price: 18, category: 'Doughnuts', available: true },
  { name: 'Chocolate', price: 25, category: 'Doughnuts', available: true },
  { name: 'Caramel', price: 25, category: 'Doughnuts', available: true },
  { name: 'Vanilla', price: 25, category: 'Doughnuts', available: true },
  { name: 'Jam', price: 28, category: 'Doughnuts', available: true },
  { name: 'Bar One', price: 28, category: 'Doughnuts', available: true },
  { name: 'Chocolate Sprinkles', price: 28, category: 'Doughnuts', available: true },
  { name: 'Chocolate Crunch', price: 28, category: 'Doughnuts', available: true },
  { name: 'Chocolate Caramel', price: 30, category: 'Doughnuts', available: true },
  { name: 'Oreo', price: 30, category: 'Doughnuts', available: true },
  { name: 'Milktart', price: 35, category: 'Doughnuts', available: true },
  { name: 'Cream Cheese', price: 35, category: 'Doughnuts', available: true },
  { name: 'Nutella', price: 35, category: 'Doughnuts', available: true },
  { name: "S'mores", price: 35, category: 'Doughnuts', available: true },
  { name: 'Cookie Crumble', price: 35, category: 'Doughnuts', available: true },
  { name: 'Cream / Caramel Cream', price: 35, category: 'Doughnuts', available: true },
  { name: 'Chocolate Nuts', price: 35, category: 'Doughnuts', available: true },
  { name: 'Cream Cheese Nuts', price: 35, category: 'Doughnuts', available: true },
  { name: 'Banana Pie', price: 40, category: 'Doughnuts', available: true },
  { name: 'Chocolate Cream Cheese', price: 40, category: 'Doughnuts', available: true },
  { name: 'Ferrero Rocher', price: 40, category: 'Doughnuts', available: true },
  { name: 'Strawberry Cream', price: 40, category: 'Doughnuts', available: true },
  { name: 'Glazed Strawberry Cream', price: 40, category: 'Doughnuts', available: true },
  { name: 'Cookies and Cream', price: 40, category: 'Doughnuts', available: true },
  { name: 'Lamington', price: 40, category: 'Doughnuts', available: true },
  { name: 'Peppermint Tart', price: 40, category: 'Doughnuts', available: true },
  { name: 'P.S Delight', price: 40, category: 'Doughnuts', available: true },
  { name: 'Dubai Chocolate', price: 45, category: 'Doughnuts', available: true },
  { name: 'Churros', price: 50, category: 'Mains', available: true },
  { name: 'Chicken Schnitzel Brotchen', price: 50, category: 'Mains', available: true },
  { name: 'Cake of the Day', price: 50, category: 'Mains', available: true },
  { name: 'Ciabatta', price: 75, category: 'Mains', available: true },
  { name: 'Curry Bunny', price: 45, category: 'Mains', available: true },
  { name: 'Chicken Crunch Burger', price: 80, category: 'Burgers', available: true },
  { name: 'Double Chicken Crunch Burger', price: 95, category: 'Burgers', available: true },
  { name: 'Hawaiian Chicken Burger', price: 85, category: 'Burgers', available: true },
  { name: 'Beef Burger', price: 80, category: 'Burgers', available: true },
  { name: 'Double Beef Burger', price: 95, category: 'Burgers', available: true },
  { name: 'Chicken Mayo Doughnut', price: 35, category: 'Doughnuts', available: true },
  { name: 'On-the-Go Doughnut', price: 45, category: 'Doughnuts', available: true },
  { name: 'Booster Breakfast', price: 95, category: 'Breakfast', available: true },
  { name: 'Classic Egg & Cheese Bagel', price: 60, category: 'Bagels', available: true },
  { name: 'Bacon, Egg & Cheese Bagel', price: 65, category: 'Bagels', available: true },
  { name: 'Sausage, Egg & Cheese Bagel', price: 65, category: 'Bagels', available: true },
  { name: 'Avocado Sunrise Bagel', price: 70, category: 'Bagels', available: true },
  { name: 'Chicken Club Bagel', price: 75, category: 'Bagels', available: true },
  { name: 'Chicken Salad Bagel', price: 65, category: 'Bagels', available: true },
  { name: 'Caprese Bagel', price: 65, category: 'Bagels', available: true },
]

async function resolveRestaurantIdByEmail(email) {
  const restaurantsSnap = await db.collection('restaurants').where('email', '==', email).limit(1).get()
  if (!restaurantsSnap.empty) {
    return restaurantsSnap.docs[0].id
  }

  const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get()
  if (!usersSnap.empty) {
    const userDoc = usersSnap.docs[0]
    const userData = userDoc.data() || {}
    if (typeof userData.restaurant_id === 'string' && userData.restaurant_id.trim()) {
      return userData.restaurant_id.trim()
    }
    if (typeof userData.restaurantId === 'string' && userData.restaurantId.trim()) {
      return userData.restaurantId.trim()
    }
    if (typeof userData.restaurant_id === 'number') {
      return String(userData.restaurant_id)
    }
  }

  throw new Error(`Could not find restaurantId for email: ${email}`)
}

async function pushMenuItems(restaurantId) {
  console.log(`[seed-menu] Starting menu push for restaurantId: ${restaurantId}`)
  console.log(`[seed-menu] Total items to write: ${menuItems.length}`)

  const nowIso = new Date().toISOString()
  const categoriesPath = `restaurants/${restaurantId}/menu/data/categories`

  const categoriesSnap = await db.collection(categoriesPath).where('active', '==', true).get()
  const categoryByName = new Map()
  let maxCategoryOrder = 0
  for (const doc of categoriesSnap.docs) {
    const data = doc.data() || {}
    const name = String(data.name || '').trim()
    if (name) categoryByName.set(name, { id: doc.id, data })
    maxCategoryOrder = Math.max(maxCategoryOrder, Number(data.display_order || 0))
  }

  const categoryNames = [...new Set(menuItems.map((i) => i.category))]
  for (const catName of categoryNames) {
    if (categoryByName.has(catName)) continue
    const ref = db.collection(categoriesPath).doc()
    maxCategoryOrder += 1
    await ref.set({
      restaurant_id: restaurantId,
      name: catName,
      description: null,
      display_order: maxCategoryOrder,
      active: true,
      created_at: nowIso,
      updated_at: nowIso,
    })
    categoryByName.set(catName, { id: ref.id, data: { name: catName } })
    console.log(`[seed-menu] Created category: ${catName} (${ref.id})`)
  }

  const subcategoryByCategoryId = new Map()
  for (const [catName, cat] of categoryByName.entries()) {
    const subPath = `restaurants/${restaurantId}/menu/data/categories/${cat.id}/subcategories`
    const subSnap = await db.collection(subPath).where('active', '==', true).get()
    let subId = null
    let maxSubOrder = 0
    for (const s of subSnap.docs) {
      const d = s.data() || {}
      if (String(d.name || '').trim() === 'All Items') subId = s.id
      maxSubOrder = Math.max(maxSubOrder, Number(d.display_order || 0))
    }
    if (!subId) {
      const subRef = db.collection(subPath).doc()
      await subRef.set({
        name: 'All Items',
        description: null,
        display_order: maxSubOrder + 1,
        active: true,
        created_at: nowIso,
        updated_at: nowIso,
      })
      subId = subRef.id
      console.log(`[seed-menu] Created subcategory 'All Items' for ${catName}`)
    }
    subcategoryByCategoryId.set(cat.id, subId)
  }

  const batchSize = 400
  let written = 0
  for (let i = 0; i < menuItems.length; i += batchSize) {
    const chunk = menuItems.slice(i, i + batchSize)
    const batch = db.batch()
    for (const item of chunk) {
      const cat = categoryByName.get(item.category)
      const categoryId = cat.id
      const subCategoryId = subcategoryByCategoryId.get(categoryId)
      const itemPath = `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
      const ref = db.collection(itemPath).doc()
      batch.set(ref, {
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
        created_at: nowIso,
        updated_at: nowIso,
      })
    }
    await batch.commit()
    written += chunk.length
    console.log(`[seed-menu] Progress: ${written}/${menuItems.length} items written`)
  }

  console.log(`[seed-menu] Done. Successfully wrote ${written} items to menu management paths.`)
}

async function main() {
  const restaurantId = await resolveRestaurantIdByEmail(TARGET_EMAIL)
  console.log(`[seed-menu] Found restaurantId for ${TARGET_EMAIL}: ${restaurantId}`)
  await pushMenuItems(restaurantId)
}

main().catch((err) => {
  console.error('[seed-menu] Failed:', err?.message || err)
  process.exit(1)
})
