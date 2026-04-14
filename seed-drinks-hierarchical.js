#!/usr/bin/env node
const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()
const RESTAURANT_ID = 'Ffc7xisdhmHl34z1UvnI'

const drinksWithVariants = [
  {
    name: 'Americano',
    category: 'Hot Coffee',
    available: true,
    price: 20,
    variants: [
      { size: 'S', label: 'Small', price: 20 },
      { size: 'L', label: 'Large', price: 30 },
    ],
  },
  {
    name: 'Cappuccino',
    category: 'Hot Coffee',
    available: true,
    price: 20,
    variants: [
      { size: 'S', label: 'Small', price: 20 },
      { size: 'L', label: 'Large', price: 35 },
    ],
  },
  {
    name: 'Espresso',
    category: 'Hot Coffee',
    available: true,
    price: 17,
    variants: [
      { size: 'S', label: 'Small', price: 17 },
      { size: 'L', label: 'Large', price: 25 },
    ],
  },
  {
    name: 'Café Latte',
    category: 'Hot Coffee',
    available: true,
    price: 33,
    variants: [
      { size: 'S', label: 'Small', price: 33 },
      { size: 'L', label: 'Large', price: 38 },
    ],
  },
  {
    name: 'Mocha Latte',
    category: 'Hot Coffee',
    available: true,
    price: 33,
    variants: [
      { size: 'S', label: 'Small', price: 33 },
      { size: 'L', label: 'Large', price: 38 },
    ],
  },
  {
    name: 'White Mocha',
    category: 'Hot Coffee',
    available: true,
    price: 33,
    variants: [
      { size: 'S', label: 'Small', price: 33 },
      { size: 'L', label: 'Large', price: 38 },
    ],
  },
  {
    name: 'Hot Chocolate',
    category: 'Hot Coffee',
    available: true,
    price: 33,
    variants: [
      { size: 'S', label: 'Small', price: 33 },
      { size: 'L', label: 'Large', price: 38 },
    ],
  },
  {
    name: 'Spicy Chai',
    category: 'Hot Coffee',
    available: true,
    price: 33,
    variants: [
      { size: 'S', label: 'Small', price: 33 },
      { size: 'L', label: 'Large', price: 38 },
    ],
  },
  {
    name: 'Tea (Rooibos / Five Roses / Green Tea)',
    category: 'Tea',
    available: true,
    price: 25,
    variants: [
      { size: 'S', label: '250ml', price: 25 },
      { size: 'L', label: '350ml', price: 28 },
    ],
  },
]

const drinksNoVariants = [
  { name: 'Ice Coffee (Caramel / Vanilla / Hazelnut)', price: 40, category: 'Iced', available: true },
  { name: 'Drip Ice Latte', price: 45, category: 'Iced', available: true },
  { name: 'Milkshake (Chocolate / Strawberry / Banana)', price: 65, category: 'Milkshakes', available: true },
  { name: 'Inhouse Tea (Mixed Berry / Passionfruit)', price: 35, category: 'Tea', available: true },
  { name: 'Matcha', price: 40, category: 'Tea', available: true },
  { name: 'Fruitree', price: 26, category: 'Cold Drinks', available: true },
  { name: 'Coke Can 330ml', price: 22, category: 'Cold Drinks', available: true },
  { name: 'Fanta Orange 330ml', price: 20, category: 'Cold Drinks', available: true },
  { name: 'Powerade', price: 28, category: 'Cold Drinks', available: true },
  { name: 'Coke Bottle', price: 25, category: 'Cold Drinks', available: true },
  { name: 'Sparkling Water', price: 20, category: 'Cold Drinks', available: true },
  { name: 'Still Water', price: 26, category: 'Cold Drinks', available: true },
  { name: 'Sprite 300ml', price: 22, category: 'Cold Drinks', available: true },
  { name: 'Sparberry 300ml', price: 22, category: 'Cold Drinks', available: true },
  { name: 'Creme Soda 300ml', price: 22, category: 'Cold Drinks', available: true },
  { name: 'Stoney 300ml', price: 22, category: 'Cold Drinks', available: true },
]

const allDrinks = [...drinksWithVariants, ...drinksNoVariants]

async function ensureCategoryAndSubcategory(categoryName) {
  const categoriesPath = `restaurants/${RESTAURANT_ID}/menu/data/categories`
  const categoriesRef = db.collection(categoriesPath)
  const categoriesSnap = await categoriesRef.where('name', '==', categoryName).limit(1).get()

  let categoryId = null
  if (!categoriesSnap.empty) {
    categoryId = categoriesSnap.docs[0].id
  } else {
    const allCats = await categoriesRef.get()
    const maxOrder = allCats.docs.reduce((max, doc) => {
      const order = Number((doc.data() || {}).display_order || 0)
      return Math.max(max, order)
    }, 0)
    const catDoc = categoriesRef.doc()
    await catDoc.set({
      restaurant_id: RESTAURANT_ID,
      name: categoryName,
      description: null,
      display_order: maxOrder + 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    categoryId = catDoc.id
    console.log(`[seed-drinks-hierarchical] Created category "${categoryName}" (${categoryId})`)
  }

  const subPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${categoryId}/subcategories`
  const subRef = db.collection(subPath)
  const subSnap = await subRef.where('name', '==', 'All Items').limit(1).get()

  let subCategoryId = null
  if (!subSnap.empty) {
    subCategoryId = subSnap.docs[0].id
  } else {
    const allSubs = await subRef.get()
    const maxOrder = allSubs.docs.reduce((max, doc) => {
      const order = Number((doc.data() || {}).display_order || 0)
      return Math.max(max, order)
    }, 0)
    const subDoc = subRef.doc()
    await subDoc.set({
      name: 'All Items',
      description: null,
      display_order: maxOrder + 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    subCategoryId = subDoc.id
    console.log(`[seed-drinks-hierarchical] Created subcategory "All Items" for "${categoryName}"`)
  }

  return { categoryId, subCategoryId }
}

async function seedDrinksHierarchical() {
  console.log('[seed-drinks-hierarchical] Starting hierarchical drinks seed...')
  console.log(`[seed-drinks-hierarchical] Total items to write: ${allDrinks.length}`)

  const categoryMappings = new Map()
  const categoryNames = [...new Set(allDrinks.map((item) => item.category))]
  for (const categoryName of categoryNames) {
    const mapping = await ensureCategoryAndSubcategory(categoryName)
    categoryMappings.set(categoryName, mapping)
  }

  const batch = db.batch()
  let queued = 0

  for (const item of allDrinks) {
    const mapping = categoryMappings.get(item.category)
    if (!mapping) {
      throw new Error(`Missing category mapping for "${item.category}"`)
    }

    const itemsPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${mapping.categoryId}/subcategories/${mapping.subCategoryId}/items`
    const docRef = db.collection(itemsPath).doc()

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

    batch.set(docRef, payload)
    queued += 1
    console.log(`[seed-drinks-hierarchical] Queued ${queued}/${allDrinks.length}: ${item.name}`)
  }

  await batch.commit()
  console.log(`[seed-drinks-hierarchical] Done. Successfully wrote ${queued} items.`)
}

seedDrinksHierarchical().catch((error) => {
  console.error('[seed-drinks-hierarchical] Failed:', error?.message || error)
  process.exit(1)
})
