#!/usr/bin/env node
const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()
const RESTAURANT_ID = 'Ffc7xisdhmHl34z1UvnI'

const updatesByName = new Map([
  [
    'Tea (Rooibos / Five Roses / Green Tea)',
    {
      variantGroups: [
        {
          name: 'Flavour',
          required: true,
          type: 'text',
          options: ['Rooibos', 'Five Roses', 'Green Tea'],
        },
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: '250ml', price: 25 },
            { label: '350ml', price: 28 },
          ],
        },
      ],
    },
  ],
  [
    'Americano',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 20 },
            { label: 'Large', price: 30 },
          ],
        },
      ],
    },
  ],
  [
    'Cappuccino',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 20 },
            { label: 'Large', price: 35 },
          ],
        },
      ],
    },
  ],
  [
    'Espresso',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 17 },
            { label: 'Large', price: 25 },
          ],
        },
      ],
    },
  ],
  [
    'Café Latte',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 33 },
            { label: 'Large', price: 38 },
          ],
        },
      ],
    },
  ],
  [
    'Mocha Latte',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 33 },
            { label: 'Large', price: 38 },
          ],
        },
      ],
    },
  ],
  [
    'White Mocha',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 33 },
            { label: 'Large', price: 38 },
          ],
        },
      ],
    },
  ],
  [
    'Hot Chocolate',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 33 },
            { label: 'Large', price: 38 },
          ],
        },
      ],
    },
  ],
  [
    'Spicy Chai',
    {
      variantGroups: [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: [
            { label: 'Small', price: 33 },
            { label: 'Large', price: 38 },
          ],
        },
      ],
    },
  ],
  [
    'Ice Coffee (Caramel / Vanilla / Hazelnut)',
    {
      name: 'Ice Coffee',
      variantGroups: [
        {
          name: 'Flavour',
          required: true,
          type: 'text',
          options: ['Caramel', 'Vanilla', 'Hazelnut'],
        },
      ],
    },
  ],
  [
    'Milkshake (Chocolate / Strawberry / Banana)',
    {
      name: 'Milkshake',
      variantGroups: [
        {
          name: 'Flavour',
          required: true,
          type: 'text',
          options: ['Chocolate', 'Strawberry', 'Banana'],
        },
      ],
    },
  ],
  [
    'Inhouse Tea (Mixed Berry / Passionfruit)',
    {
      name: 'Inhouse Tea',
      variantGroups: [
        {
          name: 'Flavour',
          required: true,
          type: 'text',
          options: ['Mixed Berry', 'Passionfruit'],
        },
      ],
    },
  ],
])

async function main() {
  console.log('[seed-variant-groups] Starting variantGroups update...')

  const categoriesPath = `restaurants/${RESTAURANT_ID}/menu/data/categories`
  const drinksCategorySnap = await db
    .collection(categoriesPath)
    .where('name', '==', 'Drinks')
    .limit(1)
    .get()

  if (drinksCategorySnap.empty) {
    throw new Error('Drinks category not found')
  }
  const drinksCategoryId = drinksCategorySnap.docs[0].id
  console.log(`[seed-variant-groups] Drinks category ID: ${drinksCategoryId}`)

  const subPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${drinksCategoryId}/subcategories`
  const subSnap = await db.collection(subPath).get()

  let updated = 0
  const missingTargets = new Set(Array.from(updatesByName.keys()))

  for (const subDoc of subSnap.docs) {
    const itemsPath = `restaurants/${RESTAURANT_ID}/menu/data/categories/${drinksCategoryId}/subcategories/${subDoc.id}/items`
    const itemsSnap = await db.collection(itemsPath).get()
    if (itemsSnap.empty) continue

    const batch = db.batch()
    let subUpdated = 0
    for (const itemDoc of itemsSnap.docs) {
      const data = itemDoc.data() || {}
      const currentName = String(data.name || '').trim()
      if (!updatesByName.has(currentName)) continue

      const payload = updatesByName.get(currentName)
      const patch = {
        ...payload,
        variants: admin.firestore.FieldValue.delete(),
        updated_at: new Date().toISOString(),
      }
      batch.update(itemDoc.ref, patch)
      subUpdated += 1
      updated += 1
      missingTargets.delete(currentName)
      console.log(`[seed-variant-groups] Queued update: ${currentName}`)
    }

    if (subUpdated > 0) {
      await batch.commit()
      console.log(
        `[seed-variant-groups] Updated ${subUpdated} item(s) in subcategory ${subDoc.id}`
      )
    }
  }

  console.log(`[seed-variant-groups] Done. Updated ${updated} item(s).`)
  if (missingTargets.size > 0) {
    console.log(
      '[seed-variant-groups] Missing targets (not found):',
      Array.from(missingTargets).join(', ')
    )
  }
}

main().catch((error) => {
  console.error('[seed-variant-groups] Failed:', error?.message || error)
  process.exit(1)
})
