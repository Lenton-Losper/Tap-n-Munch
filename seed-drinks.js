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

async function seedDrinks() {
  const allItems = [...drinksWithVariants, ...drinksNoVariants]
  const targetCollection = db.collection(`restaurants/${RESTAURANT_ID}/menuItems`)

  if (allItems.length > 500) {
    throw new Error(`Too many items for single batch write: ${allItems.length}`)
  }

  console.log(`[seed-drinks] Starting write to restaurants/${RESTAURANT_ID}/menuItems`)
  console.log(`[seed-drinks] Total items queued: ${allItems.length}`)

  const batch = db.batch()
  let queued = 0

  for (const item of allItems) {
    const docRef = targetCollection.doc()
    const payload = {
      name: item.name,
      category: item.category,
      available: Boolean(item.available),
      price: Number(item.price),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    if (Array.isArray(item.variants) && item.variants.length > 0) {
      payload.variants = item.variants.map((variant) => ({
        size: String(variant.size),
        label: String(variant.label),
        price: Number(variant.price),
      }))
    }

    batch.set(docRef, payload)
    queued += 1
    console.log(`[seed-drinks] Queued ${queued}/${allItems.length}: ${item.name}`)
  }

  await batch.commit()
  console.log(`[seed-drinks] Done. Successfully wrote ${queued} items.`)
}

seedDrinks().catch((error) => {
  console.error('[seed-drinks] Failed:', error?.message || error)
  process.exit(1)
})
